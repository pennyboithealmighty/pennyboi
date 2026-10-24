import test from "node:test";
import assert from "node:assert/strict";
import type { Briefing, MemoryDb, VaultConfig } from "@pennyboi/shared";
import { resolveAirdrop, type AirdropResolution } from "./airdrop-resolve.js";
import type { Decision } from "./types.js";

const POOL = ["aa", "bb", "cc", "dd", "ee", "ff"]; // sorted
const SEED = "deadbeef";
const STEP = 7;
const CAP = 100_000_000;

function fakeDb(round: { pool: string[]; seed: string } | null): MemoryDb {
  return {
    getAirdropRound(step: number) {
      if (!round || step !== STEP) return null;
      return {
        step: STEP,
        ts: 0,
        seed: round.seed,
        blockhash: "bh",
        pool_hash: "h",
        pool_size: round.pool.length,
        pool_json: JSON.stringify(round.pool),
        favored_json: null,
        fortune_json: null,
        amount_each: null,
        tx_sig: null,
      };
    },
  } as unknown as MemoryDb;
}

function briefing(candidates: string[], step: number = STEP): Briefing {
  return {
    treasury: { threshold_step: step },
    available_actions: { airdrop: { favored_candidates: candidates.map((w) => ({ wallet: w })) } },
  } as unknown as Briefing;
}

const cfg = { airdropCapLamports: CAP } as VaultConfig;

function decision(favored: unknown): Decision {
  return { action: "airdrop", params: { favored } };
}

function ok(r: AirdropResolution) {
  assert.ok(r.ok, r.ok ? "" : r.error);
  return (r as Extract<AirdropResolution, { ok: true }>).resolved;
}

test("resolves favored + fortune into 5 recipients with an equal split", () => {
  const r = ok(resolveAirdrop(decision(["aa"]), briefing(["aa", "bb"]), cfg, fakeDb({ pool: POOL, seed: SEED })));
  assert.equal(r.recipients.length, 5);
  assert.equal(r.recipients[0], "aa", "favored first");
  assert.deepEqual(r.favored, ["aa"]);
  assert.equal(r.fortune.length, 4);
  assert.equal(r.amountEach, 20_000_000); // floor(1e8 / 5)
  assert.deepEqual(r.amounts, [20_000_000, 20_000_000, 20_000_000, 20_000_000, 20_000_000]);
  assert.ok(r.amounts.reduce((a, b) => a + b, 0) <= CAP);
  assert.equal(new Set(r.recipients).size, 5, "no duplicate recipients");
});

test("is deterministic for the same pool + seed + favored", () => {
  const a = ok(resolveAirdrop(decision(["aa"]), briefing(["aa", "bb"]), cfg, fakeDb({ pool: POOL, seed: SEED })));
  const b = ok(resolveAirdrop(decision(["aa"]), briefing(["aa", "bb"]), cfg, fakeDb({ pool: POOL, seed: SEED })));
  assert.deepEqual(a.recipients, b.recipients);
});

test("zero favored -> all five drawn by fortune", () => {
  const r = ok(resolveAirdrop(decision([]), briefing(["aa", "bb"]), cfg, fakeDb({ pool: POOL, seed: SEED })));
  assert.equal(r.favored.length, 0);
  assert.equal(r.fortune.length, 5);
  assert.equal(r.recipients.length, 5);
});

test("rejects a favored wallet that is not a candidate", () => {
  // "cc" is in the pool but not among favored_candidates.
  const r = resolveAirdrop(decision(["cc"]), briefing(["aa", "bb"]), cfg, fakeDb({ pool: POOL, seed: SEED }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not in favored_candidates/);
});

test("rejects a favored wallet that is not in the pool", () => {
  const r = resolveAirdrop(decision(["zz"]), briefing(["aa", "zz"]), cfg, fakeDb({ pool: POOL, seed: SEED }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not in the pool/);
});

test("rejects duplicates and too many favored", () => {
  const dup = resolveAirdrop(decision(["aa", "aa"]), briefing(["aa", "bb"]), cfg, fakeDb({ pool: POOL, seed: SEED }));
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.match(dup.error, /duplicated/);

  const many = resolveAirdrop(
    decision(["aa", "bb", "cc"]),
    briefing(["aa", "bb", "cc"]),
    cfg,
    fakeDb({ pool: POOL, seed: SEED })
  );
  assert.equal(many.ok, false);
  if (!many.ok) assert.match(many.error, /max 2/);
});

test("pool smaller than recipients -> everyone receives", () => {
  const small = ["aa", "bb", "cc"];
  const r = ok(resolveAirdrop(decision(["aa"]), briefing(["aa"]), cfg, fakeDb({ pool: small, seed: SEED })));
  assert.equal(r.recipients.length, 3);
  assert.deepEqual(new Set(r.recipients), new Set(small));
  assert.equal(r.amountEach, Math.floor(CAP / 3));
});

test("errors when there is no snapshot for the step", () => {
  const r = resolveAirdrop(decision(["aa"]), briefing(["aa"]), cfg, fakeDb(null));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /no airdrop pool snapshot/);
});

test("errors when the briefing has no threshold_step", () => {
  const b = { available_actions: { airdrop: { favored_candidates: [] } } } as unknown as Briefing;
  const r = resolveAirdrop(decision([]), b, cfg, fakeDb({ pool: POOL, seed: SEED }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /threshold_step/);
});
