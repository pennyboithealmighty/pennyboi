import test from "node:test";
import assert from "node:assert/strict";
import { isBackfill, parseOffering } from "./offerings.js";

const FEE = "FEESPda11111111111111111111111111111111111";
const DONOR = "Donor1111111111111111111111111111111111111";
const REF = "Ref11111111111111111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const MEMO_PROG = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const NOW = 1_700_000_100;

function makeTx(opts: {
  credit?: number;
  err?: unknown;
  memo?: string | null;
  withRef?: boolean;
  withTransfer?: boolean;
  feeInKeys?: boolean;
} = {}) {
  const {
    credit = 50_000_000,
    err = null,
    memo = null,
    withRef = true,
    withTransfer = true,
    feeInKeys = true,
  } = opts;

  const accountKeys: any[] = [{ pubkey: DONOR, signer: true, writable: true }];
  if (feeInKeys) accountKeys.push({ pubkey: FEE, signer: false, writable: true });
  accountKeys.push({ pubkey: SYSTEM, signer: false, writable: false });
  if (withRef) accountKeys.push({ pubkey: REF, signer: false, writable: false });

  const preBalances: number[] = accountKeys.map((_, i) =>
    i === 0 ? 1_000_000_000 : i === 1 && feeInKeys ? 2_000_000 : 1
  );
  const postBalances: number[] = [...preBalances];
  if (feeInKeys) postBalances[1] = (preBalances[1] ?? 0) + credit;

  const instructions: any[] = [];
  if (withTransfer) {
    instructions.push({
      program: "system",
      programId: SYSTEM,
      parsed: { type: "transfer", info: { source: DONOR, destination: FEE, lamports: credit } },
    });
  }
  if (memo != null) {
    instructions.push({ program: "spl-memo", programId: MEMO_PROG, parsed: memo });
  }

  return {
    slot: 123,
    blockTime: 1_700_000_000,
    meta: { err, preBalances, postBalances },
    transaction: { message: { accountKeys, instructions } },
  };
}

test("parseOffering extracts donor, lamports, memo, reference", () => {
  const r = parseOffering("sigA", makeTx({ credit: 50_000_000, memo: "for the king" }), FEE, NOW);
  assert.ok(r);
  assert.equal(r!.donor, DONOR);
  assert.equal(r!.lamports, 50_000_000);
  assert.equal(r!.memoRaw, "for the king");
  assert.equal(r!.reference, REF);
  assert.equal(r!.slot, 123);
  assert.equal(r!.ts, 1_700_000_000);
  assert.equal(r!.txSig, "sigA");
});

test("parseOffering: no memo / no reference -> nulls", () => {
  const r = parseOffering("sigB", makeTx({ memo: null, withRef: false }), FEE, NOW);
  assert.ok(r);
  assert.equal(r!.memoRaw, null);
  assert.equal(r!.reference, null);
});

test("parseOffering: failed tx is skipped", () => {
  assert.equal(parseOffering("sigC", makeTx({ err: { InstructionError: [0, "Custom"] } }), FEE, NOW), null);
});

test("parseOffering: no positive credit -> null", () => {
  assert.equal(parseOffering("sigD", makeTx({ credit: 0 }), FEE, NOW), null);
});

test("parseOffering: FeeReceiver not in the tx -> null", () => {
  assert.equal(parseOffering("sigE", makeTx({ feeInKeys: false }), FEE, NOW), null);
});

test("parseOffering: donor falls back to fee payer without a parsed transfer", () => {
  const r = parseOffering("sigF", makeTx({ withTransfer: false }), FEE, NOW);
  assert.ok(r);
  assert.equal(r!.donor, DONOR); // accountKeys[0], the fee payer
});

test("parseOffering: blockTime missing -> uses now", () => {
  const tx: any = makeTx({});
  tx.blockTime = null;
  const r = parseOffering("sigG", tx, FEE, NOW);
  assert.equal(r!.ts, NOW);
});

test("isBackfill: at/before the start cursor is a silent backfill", () => {
  assert.equal(isBackfill(100, 150), true); // existed before start -> silent
  assert.equal(isBackfill(150, 150), true); // exactly the cursor -> silent
  assert.equal(isBackfill(151, 150), false); // arrived after start -> announce
  assert.equal(isBackfill(100, undefined), false); // no cursor yet -> not backfill
});
