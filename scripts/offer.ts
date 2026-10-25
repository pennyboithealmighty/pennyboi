// Devnet offering sender (docs/12 §7). Sends a real SOL gift to the vault's
// FeeReceiver from a generated, gitignored test donor keypair (funded from the
// admin wallet), with a Solana Pay reference key and an optional memo — exactly
// the transaction the offering page builds. Prints the reference + signature so
// you can poll /public/offering/receipt.
//
// Run: OFFER_SOL=0.05 OFFER_MEMO="for the king" pnpm --filter @pennyboi/scripts offer
// Env: OFFER_DONOR (donor keypair suffix, default "1"), OFFER_SOL, OFFER_MEMO.

import { deriveFeesPda, envStr, getConnection, solToLamports } from "@pennyboi/shared";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assertDevnet, ensureFunded, loadOrCreateKeypair, log, sol } from "./lib.js";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function memoIx(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM,
    data: Buffer.from(memo, "utf8"),
  });
}

async function main(): Promise<void> {
  assertDevnet();
  const programId = envStr("VAULT_PROGRAM_ID");
  if (!programId) throw new Error("VAULT_PROGRAM_ID not set — deploy first.");
  const feeReceiver = deriveFeesPda(new PublicKey(programId));

  const amountSol = Number(envStr("OFFER_SOL", "0.05"));
  if (!(amountSol > 0) || amountSol > 100) throw new Error(`OFFER_SOL must be 0 < x <= 100 (got ${envStr("OFFER_SOL")})`);
  const lamports = solToLamports(amountSol);
  const memo = envStr("OFFER_MEMO");

  const conn = getConnection();
  const admin = loadOrCreateKeypair("admin");
  const donor = loadOrCreateKeypair(`donor-${envStr("OFFER_DONOR", "1")}`);
  log(`feeReceiver ${feeReceiver.toBase58()}`);
  log(`donor       ${donor.keypair.publicKey.toBase58()} (${donor.created ? "generated" : "existing"})`);

  // Fund the donor from admin so it can cover the gift + fees.
  const need = lamports + solToLamports(0.01);
  let donorBal = await conn.getBalance(donor.keypair.publicKey);
  if (donorBal < need) {
    await ensureFunded(conn, admin.keypair.publicKey, 0.5, 1);
    const topUp = need - donorBal;
    log(`funding donor with ${sol(topUp)} SOL from admin`);
    const fund = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: admin.keypair.publicKey, toPubkey: donor.keypair.publicKey, lamports: topUp })
    );
    await sendAndConfirmTransaction(conn, fund, [admin.keypair], { commitment: "confirmed" });
    donorBal = await conn.getBalance(donor.keypair.publicKey);
  }
  log(`donor balance ${sol(donorBal)} SOL`);

  // The offering tx: transfer(donor -> FeeReceiver) + a read-only reference key + optional memo.
  const reference = Keypair.generate().publicKey;
  const transferIx = SystemProgram.transfer({
    fromPubkey: donor.keypair.publicKey,
    toPubkey: feeReceiver,
    lamports,
  });
  transferIx.keys.push({ pubkey: reference, isSigner: false, isWritable: false }); // Solana Pay reference

  const tx = new Transaction().add(transferIx);
  if (memo) tx.add(memoIx(memo, donor.keypair.publicKey));

  const sig = await sendAndConfirmTransaction(conn, tx, [donor.keypair], { commitment: "confirmed" });

  log("");
  log(`OFFERING SENT: ${sol(lamports)} SOL -> FeeReceiver`);
  log(`  reference: ${reference.toBase58()}`);
  log(`  signature: ${sig}`);
  if (memo) log(`  memo:      "${memo}"`);
  log(`Poll: /public/offering/receipt?ref=${reference.toBase58()}  or  ?sig=${sig}`);
}

main().catch((e) => {
  log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
