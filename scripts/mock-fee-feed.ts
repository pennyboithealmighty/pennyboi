// Devnet dry-run fee feed. Pump.fun pays creator fees to a wallet you control;
// in production a sweeper forwards them to the FeeReceiver PDA. For the devnet
// dry run this script simulates that by dripping SOL into the FeeReceiver PDA.
//
// It sends from a DEDICATED mock-fee wallet (keys/mockfee.json, gitignored,
// funded from admin), NOT the admin wallet — otherwise its deposits would be
// classified as "Creator tithes" (docs/12 §1). Add the printed wallet to
// FEE_SOURCE_WALLETS so its deposits are treated as fees, not offerings.
//
// Env: MOCK_FEE_LAMPORTS (per drip), MOCK_FEE_INTERVAL_SECS, plus --once for a
// single drip (cron-friendly) instead of the default loop.

import * as anchor from "@coral-xyz/anchor";
import { envNum, getConnection, solToLamports, tryLoadVault } from "@pennyboi/shared";
import {
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assertDevnet, ensureFunded, loadOrCreateKeypair, log, sol } from "./lib.js";

async function drip(
  conn: ReturnType<typeof getConnection>,
  fromKp: anchor.web3.Keypair,
  feesPda: anchor.web3.PublicKey,
  lamports: number
): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: fromKp.publicKey, toPubkey: feesPda, lamports })
  );
  await sendAndConfirmTransaction(conn, tx, [fromKp], { commitment: "confirmed" });
  const bal = await conn.getBalance(feesPda);
  log(`dripped ${sol(lamports)} SOL -> FeeReceiver (balance now ${sol(bal)} SOL)`);
}

async function main(): Promise<void> {
  assertDevnet();
  const conn = getConnection();
  const admin = loadOrCreateKeypair("admin");
  const mockfee = loadOrCreateKeypair("mockfee"); // dedicated fee source, NOT admin

  const loaded = tryLoadVault(conn, new anchor.Wallet(admin.keypair));
  if (!loaded.ok) throw new Error(`vault not loaded: ${loaded.reason} (deploy first)`);
  const feesPda = loaded.vault.feesPda;

  const lamports = envNum("MOCK_FEE_LAMPORTS", 50_000_000); // 0.05 SOL default
  const intervalSecs = envNum("MOCK_FEE_INTERVAL_SECS", 60);
  const once = process.argv.includes("--once");
  const dripSol = lamports / 1_000_000_000;

  // One tick: keep admin funded (faucet), keep the mock-fee wallet funded from
  // admin, then drip from the mock-fee wallet.
  const tick = async () => {
    await ensureFunded(conn, admin.keypair.publicKey, dripSol + 0.05, 2);
    const mfBal = await conn.getBalance(mockfee.keypair.publicKey);
    if (mfBal < solToLamports(dripSol + 0.01)) {
      const topUp = solToLamports(dripSol + 0.05) - mfBal;
      const fund = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: admin.keypair.publicKey, toPubkey: mockfee.keypair.publicKey, lamports: topUp })
      );
      await sendAndConfirmTransaction(conn, fund, [admin.keypair], { commitment: "confirmed" });
    }
    await drip(conn, mockfee.keypair, feesPda, lamports);
  };

  log(`fee feed -> ${feesPda.toBase58()} from mockfee ${mockfee.keypair.publicKey.toBase58()} (${sol(lamports)} SOL${once ? ", single drip" : ` every ${intervalSecs}s`})`);
  log(`IMPORTANT: add the mock-fee wallet to FEE_SOURCE_WALLETS so its deposits count as fees, not offerings:`);
  log(`  FEE_SOURCE_WALLETS=${mockfee.keypair.publicKey.toBase58()}`);

  await tick();
  if (once) return;

  setInterval(() => {
    tick().catch((e) => log(`drip failed: ${e.message}`));
  }, Math.max(5, intervalSecs) * 1000);
}

main().catch((e) => {
  log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
