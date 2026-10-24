// Devnet dry-run fee feed. Pump.fun pays creator fees to a wallet you control;
// in production a sweeper forwards them to the FeeReceiver PDA. For the devnet
// dry run this script simulates that by dripping SOL from the admin wallet into
// the FeeReceiver PDA on an interval, so thresholds get crossed and the loop runs.
//
// Env: MOCK_FEE_LAMPORTS (per drip), MOCK_FEE_INTERVAL_SECS, plus --once for a
// single drip (cron-friendly) instead of the default loop.

import * as anchor from "@coral-xyz/anchor";
import { envNum, getConnection, tryLoadVault } from "@pennyboi/shared";
import {
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assertDevnet, loadOrCreateKeypair, log, sol } from "./lib.js";

async function drip(
  conn: ReturnType<typeof getConnection>,
  adminKp: anchor.web3.Keypair,
  feesPda: anchor.web3.PublicKey,
  lamports: number
): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: adminKp.publicKey,
      toPubkey: feesPda,
      lamports,
    })
  );
  await sendAndConfirmTransaction(conn, tx, [adminKp], { commitment: "confirmed" });
  const bal = await conn.getBalance(feesPda);
  log(`dripped ${sol(lamports)} SOL -> FeeReceiver (balance now ${sol(bal)} SOL)`);
}

async function main(): Promise<void> {
  assertDevnet();
  const conn = getConnection();
  const admin = loadOrCreateKeypair("admin");

  const loaded = tryLoadVault(conn, new anchor.Wallet(admin.keypair));
  if (!loaded.ok) throw new Error(`vault not loaded: ${loaded.reason} (deploy first)`);
  const feesPda = loaded.vault.feesPda;

  const lamports = envNum("MOCK_FEE_LAMPORTS", 50_000_000); // 0.05 SOL default
  const intervalSecs = envNum("MOCK_FEE_INTERVAL_SECS", 60);
  const once = process.argv.includes("--once");

  log(`fee feed -> ${feesPda.toBase58()} (${sol(lamports)} SOL${once ? ", single drip" : ` every ${intervalSecs}s`})`);

  await drip(conn, admin.keypair, feesPda, lamports);
  if (once) return;

  setInterval(() => {
    drip(conn, admin.keypair, feesPda, lamports).catch((e) => log(`drip failed: ${e.message}`));
  }, Math.max(5, intervalSecs) * 1000);
}

main().catch((e) => {
  log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
