// docs/12 §0 + §8: an offering must NEVER affect airdrop eligibility. The pool
// builder reads holders + the airdrop_exclusions set, never the donations table,
// so recording a gift (even from a pool wallet) can't change the pool or hash.

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { buildEligiblePool, MemoryDb, type AirdropConfig, type Holder } from "./index.js";

const CFG: AirdropConfig = {
  recipients: 5,
  favoredMax: 2,
  minHoldTokens: 100_000,
  minHoldSecs: 86_400,
  repeatCooldownSecs: 259_200,
  poolMax: 500,
  holderSource: "mock",
};
const NOW = 1_000_000_000;
const HOLDERS: Holder[] = [
  { address: "aa", balance: 500_000, qualifiedSince: NOW - 200_000, lastSellTs: null, lastAirdropTs: null },
  { address: "bb", balance: 500_000, qualifiedSince: NOW - 200_000, lastSellTs: null, lastAirdropTs: null },
];

function pool(db: MemoryDb) {
  return buildEligiblePool(HOLDERS, { now: NOW, lastThresholdTs: NOW - 86_400, exclusions: db.excludedSet(), cfg: CFG });
}

test("a donation never changes the airdrop pool or its hash", () => {
  const path = join(tmpdir(), `pb-isolation-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new MemoryDb(path);
  try {
    const before = pool(db);

    // A donor tithes — and is also in the eligible pool.
    db.recordDonation({
      tx_sig: "sig1",
      ts: NOW,
      slot: 1,
      donor: "aa",
      lamports: 5_000_000_000,
      is_creator: 0,
      reference: null,
      memo_raw: null,
      memo_clean: null,
      tier: "grand",
    });
    assert.equal(db.countDonationsByDonor("aa"), 1);
    assert.equal(db.excludedSet().size, 0, "a donation is not an exclusion");

    const after = pool(db);
    assert.deepEqual(after.wallets, before.wallets);
    assert.equal(after.poolHash, before.poolHash);
  } finally {
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        rmSync(path + ext, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
});
