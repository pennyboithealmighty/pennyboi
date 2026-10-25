// Devnet buyback testing (docs/13 §6.2, docs/11 §7B). Mints a devnet SPL token
// and — if a mock-venue program is deployed (MOCK_VENUE_PROGRAM) — seeds its
// constant-product pool (SOL + token), so buyback_burn can run end to end on
// devnet AFTER the owner redeploys with the docs/13 program. This script never
// redeploys and never writes .env; it prints the values to set.
//
// Run: pnpm --filter @pennyboi/scripts devnet-token
// Env: TOKEN_DECIMALS (6), TOKEN_SUPPLY (1e9), MOCK_VENUE_PROGRAM (optional),
//      POOL_SOL (5), POOL_TOKENS (fraction of supply into the pool, 0.5).

import { assertDevnet, loadOrCreateKeypair, log, sol } from "./lib.js";
import { envNum, envStr, getConnection, solToLamports } from "@pennyboi/shared";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

async function main(): Promise<void> {
  assertDevnet();
  const conn = getConnection();
  const admin = loadOrCreateKeypair("admin");

  const decimals = envNum("TOKEN_DECIMALS", 6);
  const supply = BigInt(Math.floor(envNum("TOKEN_SUPPLY", 1_000_000_000))) * BigInt(10) ** BigInt(decimals);

  log(`minting devnet token (decimals=${decimals}) with admin authority…`);
  const mint = await createMint(conn, admin.keypair, admin.keypair.publicKey, null, decimals);
  const adminAta = await getOrCreateAssociatedTokenAccount(conn, admin.keypair, mint, admin.keypair.publicKey);
  await mintTo(conn, admin.keypair, mint, adminAta.address, admin.keypair, supply);
  log(`minted ${supply} base units to admin.`);

  const venueStr = envStr("MOCK_VENUE_PROGRAM");
  if (venueStr) {
    const venue = new PublicKey(venueStr);
    const [poolSol] = PublicKey.findProgramAddressSync([Buffer.from("pool_sol")], venue);
    const [poolAuth] = PublicKey.findProgramAddressSync([Buffer.from("pool_auth")], venue);

    const poolSolLamports = solToLamports(envNum("POOL_SOL", 5));
    log(`seeding mock pool at ${venue.toBase58()} with ${sol(poolSolLamports)} SOL…`);
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: admin.keypair.publicKey, toPubkey: poolSol, lamports: poolSolLamports })
      ),
      [admin.keypair],
      { commitment: "confirmed" }
    );

    const poolVault = await getOrCreateAssociatedTokenAccount(conn, admin.keypair, mint, poolAuth, true);
    const poolTokens = (supply * BigInt(Math.floor(envNum("POOL_TOKENS", 0.5) * 1_000_000))) / 1_000_000n;
    await mintTo(conn, admin.keypair, mint, poolVault.address, admin.keypair, poolTokens);
    log(`seeded pool vault ${poolVault.address.toBase58()} with ${poolTokens} base units.`);
  } else {
    log("MOCK_VENUE_PROGRAM not set — minted the token only (deploy the mock venue, then re-run to seed the pool).");
  }

  log("");
  log("Set these in .env (take effect at the next redeploy — do NOT reinit the current instance):");
  log(`  TOKEN_MINT=${mint.toBase58()}`);
  if (venueStr) log(`  VAULT_VENUE_WHITELIST=${venueStr}`);
  log("  BURN_MODE=swap   # once redeployed with the docs/13 program + pool");
}

main().catch((e) => {
  log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
