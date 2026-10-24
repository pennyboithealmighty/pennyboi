import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  airdropConfig,
  buildEligiblePool,
  computeSeed,
  equalSplit,
  fortuneDraw,
  loadMockHolders,
  parseMockHolders,
  repoRoot,
  seededShuffle,
  selectRecipients,
  sha256Hex,
  type AirdropConfig,
  type Holder,
} from "./index.js";

const NOW = 1_000_000_000;
const LAST_THRESHOLD = NOW - 7200; // 2h ago, matching the fixture's scenarios
const FIXTURE = join(repoRoot(), "db", "mock-holders.json");

// Default knobs, independent of the process env.
const CFG: AirdropConfig = {
  recipients: 5,
  favoredMax: 2,
  minHoldTokens: 100_000,
  minHoldSecs: 86_400,
  repeatCooldownSecs: 259_200,
  poolMax: 500,
  holderSource: "mock",
};

function pool(exclusions = new Set<string>()) {
  const { holders, exclusions: fixtureEx } = loadMockHolders(FIXTURE, NOW);
  const all = new Set<string>([...fixtureEx, ...exclusions]);
  return buildEligiblePool(holders, { now: NOW, lastThresholdTs: LAST_THRESHOLD, exclusions: all, cfg: CFG });
}

// Addresses from the fixture, by scenario.
const ELIGIBLE_SAMPLE = "7TcqDniwz6RDQfPPLAL9svGJ2FnK5rrhB8mwncVyjfxC"; // wallet 2, exactly at minimum
const TOO_SMALL = "7EuAztb6vDRVjfi4xgjZP2JVU98yzRbzKY4nYgk8TLuc";
const TOO_NEW = "77zGxJG2zHk1R9CeFPSd5caH3HPG1kMJPPwjHu5L7eFR";
const SOLD = "D55xuGFuSuDSZLkJyTyGgogNzNE8sEUNheh5MPrRnbeC";
const EXCLUDED = "7p4ymG1cUYLy8R2XjwNEJdiRr4M9Upwekx81TR8xcot4";
const RECENT_WINNER = "kFiW6BLcQBeme2RMr2abJjRWRoebuXLCUuV12eEgd5o";

test("eligible pool keeps exactly the 18 fixture wallets that pass every rule", () => {
  const p = pool();
  assert.equal(p.poolSize, 18);
  assert.ok(p.wallets.includes(ELIGIBLE_SAMPLE));
});

test("each §1 rule excludes the right wallet", () => {
  const p = pool();
  for (const bad of [TOO_SMALL, TOO_NEW, SOLD, EXCLUDED, RECENT_WINNER]) {
    assert.ok(!p.wallets.includes(bad), `${bad} should be filtered out`);
  }
});

test("pool is sorted by pubkey and pool_hash matches the list", () => {
  const p = pool();
  const sorted = [...p.wallets].sort();
  assert.deepEqual(p.wallets, sorted, "deterministic order");
  assert.equal(p.poolHash, sha256Hex(p.wallets.join(",")));
  // Stable across runs.
  assert.equal(pool().poolHash, p.poolHash);
});

test("a DB-level exclusion drops a wallet that would otherwise qualify", () => {
  const without = pool();
  assert.ok(without.wallets.includes(ELIGIBLE_SAMPLE));
  const withEx = pool(new Set([ELIGIBLE_SAMPLE]));
  assert.ok(!withEx.wallets.includes(ELIGIBLE_SAMPLE));
  assert.equal(withEx.poolSize, without.poolSize - 1);
});

test("empty pool when nobody qualifies", () => {
  const holders: Holder[] = [
    { address: "aaa", balance: 1, qualifiedSince: NOW - 10, lastSellTs: null, lastAirdropTs: null },
  ];
  const p = buildEligiblePool(holders, { now: NOW, lastThresholdTs: LAST_THRESHOLD, exclusions: new Set(), cfg: CFG });
  assert.equal(p.poolSize, 0);
  assert.equal(p.poolHash, sha256Hex(""));
});

test("poolMax keeps the largest holders when over the cap", () => {
  const holders: Holder[] = Array.from({ length: 10 }, (_, i) => ({
    address: `w${i}`,
    balance: 100_000 + i, // w9 largest
    qualifiedSince: NOW - 200_000,
    lastSellTs: null,
    lastAirdropTs: null,
  }));
  const p = buildEligiblePool(holders, {
    now: NOW,
    lastThresholdTs: LAST_THRESHOLD,
    exclusions: new Set(),
    cfg: { ...CFG, poolMax: 3 },
  });
  assert.equal(p.poolSize, 3);
  assert.deepEqual([...p.wallets].sort(), p.wallets); // still sorted by pubkey
  assert.deepEqual(new Set(p.wallets), new Set(["w7", "w8", "w9"])); // top 3 by balance
});

test("fortune draw is deterministic and removes favored before drawing", () => {
  const sorted = Array.from({ length: 10 }, (_, i) => `p${i}`).sort();
  const seed = computeSeed("BLOCKHASH123", 7);
  const favored = [sorted[0]!];
  const a = fortuneDraw(sorted, favored, seed, 5);
  const b = fortuneDraw(sorted, favored, seed, 5);
  assert.deepEqual(a, b, "same seed + pool -> same picks");
  assert.equal(a.length, 4, "fills the slots left after favored");
  assert.ok(!a.includes(sorted[0]!), "favored never appears in the fortune picks");
  assert.equal(new Set(a).size, a.length, "no duplicates");
});

test("different seed -> different draw (almost surely)", () => {
  const sorted = Array.from({ length: 20 }, (_, i) => `q${i}`).sort();
  const a = fortuneDraw(sorted, [], computeSeed("hashA", 1), 5);
  const b = fortuneDraw(sorted, [], computeSeed("hashB", 1), 5);
  assert.notDeepEqual(a, b);
});

test("selectRecipients: favored first, then fortune, capped at recipients", () => {
  const sorted = Array.from({ length: 12 }, (_, i) => `r${String(i).padStart(2, "0")}`).sort();
  const seed = computeSeed("bh", 3);
  const favored = [sorted[0]!, sorted[1]!];
  const picks = selectRecipients(sorted, favored, seed, 5);
  assert.equal(picks.length, 5);
  assert.deepEqual(picks.slice(0, 2), favored, "favored come first");
  assert.equal(new Set(picks).size, 5, "no duplicates");
});

test("pool smaller than recipients -> everyone receives", () => {
  const sorted = ["x1", "x2", "x3"];
  const picks = selectRecipients(sorted, ["x2"], computeSeed("bh", 1), 5);
  assert.equal(picks.length, 3);
  assert.deepEqual(new Set(picks), new Set(sorted));
  assert.equal(picks[0], "x2", "favored still surfaces first");
});

test("equal split never exceeds the cap", () => {
  assert.equal(equalSplit(100_000_000, 5), 20_000_000);
  assert.ok(equalSplit(100_000_000, 5) * 5 <= 100_000_000);
  assert.equal(equalSplit(100_000_000, 3), 33_333_333); // floor
  assert.ok(equalSplit(100_000_000, 3) * 3 <= 100_000_000);
  assert.equal(equalSplit(100, 0), 0);
});

test("seededShuffle is a deterministic permutation", () => {
  const items = Array.from({ length: 8 }, (_, i) => i);
  const s1 = seededShuffle(items, "seed");
  const s2 = seededShuffle(items, "seed");
  assert.deepEqual(s1, s2);
  assert.deepEqual([...s1].sort((a, b) => a - b), items, "same multiset");
});

test("parseMockHolders resolves secs-ago offsets against now", () => {
  const { holders } = parseMockHolders(
    JSON.stringify({ holders: [{ address: "z", balance: 1, qualified_secs_ago: 100, last_sell_secs_ago: null }] }),
    NOW
  );
  assert.equal(holders[0]!.qualifiedSince, NOW - 100);
  assert.equal(holders[0]!.lastSellTs, null);
  assert.equal(holders[0]!.lastAirdropTs, null);
});

test("airdropConfig falls back to the documented defaults", () => {
  const c = airdropConfig();
  assert.equal(c.recipients, 5);
  assert.equal(c.favoredMax, 2);
  assert.equal(c.holderSource, "mock");
});
