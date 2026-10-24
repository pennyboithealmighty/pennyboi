// Airdrop eligibility + verifiable selection (docs/11). Pure, deterministic
// logic shared by Eyes (builds the pool at a threshold) and Hands (recomputes
// the fortune draw before signing). Nothing here touches the chain or the DB —
// callers pass holder data in and get a snapshot + draw out, so the whole thing
// is unit-testable and anyone can reproduce a result from the pool + seed.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { envNum, envStr } from "./env.js";

// ---- Config (env knobs, docs/11 §9) ---------------------------------------

export interface AirdropConfig {
  recipients: number; // total slots per airdrop (default 5)
  favoredMax: number; // how many Pennyboi may hand-pick (default 2)
  minHoldTokens: number; // rule 1: minimum balance to qualify
  minHoldSecs: number; // rule 2: how long that balance must have been held
  repeatCooldownSecs: number; // rule 6: no repeat wins within this window
  poolMax: number; // snapshot cap (keep the largest holders if over)
  holderSource: "mock" | "helius";
}

export function airdropConfig(): AirdropConfig {
  const holderSource = envStr("HOLDER_SOURCE", "mock").toLowerCase() === "helius" ? "helius" : "mock";
  return {
    recipients: envNum("AIRDROP_RECIPIENTS", 5),
    favoredMax: envNum("AIRDROP_FAVORED_MAX", 2),
    minHoldTokens: envNum("AIRDROP_MIN_HOLD_TOKENS", 100_000),
    minHoldSecs: envNum("AIRDROP_MIN_HOLD_SECS", 86_400),
    repeatCooldownSecs: envNum("AIRDROP_REPEAT_COOLDOWN_SECS", 259_200),
    poolMax: envNum("AIRDROP_POOL_MAX", 500),
    holderSource,
  };
}

// ---- Holder shape (absolute unix-second timestamps) -----------------------

/** A token holder at briefing time, as the pool filter consumes it. */
export interface Holder {
  address: string;
  balance: number; // token units
  qualifiedSince: number | null; // when balance first reached the minimum; null = never
  lastSellTs: number | null; // last outgoing/sell of the mint; null = never
  lastAirdropTs: number | null; // last airdrop this wallet received; null = never
}

// ---- Mock holder source (HOLDER_SOURCE=mock, docs/11 §7A) -----------------
// The fixture stores time fields as "seconds ago" offsets so it stays
// meaningful whenever it is run; the loader resolves them against `now`.

interface MockRow {
  address: string;
  balance: number;
  qualified_secs_ago: number | null;
  last_sell_secs_ago?: number | null;
  last_airdrop_secs_ago?: number | null;
  excluded?: boolean;
  note?: string; // human label for the scenario; ignored by the filter
}

export interface MockHolders {
  holders: Holder[];
  exclusions: Set<string>; // addresses flagged `excluded` in the fixture
}

export function parseMockHolders(json: string, now: number): MockHolders {
  const raw = JSON.parse(json) as { holders: MockRow[] };
  const holders: Holder[] = [];
  const exclusions = new Set<string>();
  for (const r of raw.holders) {
    if (r.excluded) exclusions.add(r.address);
    const ago = (v: number | null | undefined): number | null =>
      v == null ? null : now - v;
    holders.push({
      address: r.address,
      balance: r.balance,
      qualifiedSince: ago(r.qualified_secs_ago),
      lastSellTs: ago(r.last_sell_secs_ago),
      lastAirdropTs: ago(r.last_airdrop_secs_ago),
    });
  }
  return { holders, exclusions };
}

export function loadMockHolders(path: string, now: number): MockHolders {
  return parseMockHolders(readFileSync(path, "utf8"), now);
}

// ---- Eligible pool (docs/11 §1) -------------------------------------------

export interface PoolMember {
  wallet: string;
  balanceTokens: number;
  qualifiedSince: number;
  heldHours: number;
}

export interface EligiblePool {
  wallets: string[]; // sorted by pubkey (deterministic order)
  members: PoolMember[]; // same order, with detail for the briefing
  poolHash: string; // sha256(sorted pubkeys joined by ",")
  poolSize: number;
}

export interface PoolOpts {
  now: number;
  lastThresholdTs: number; // rule 3: "no sell since the last threshold"
  exclusions: Set<string>; // static known addresses + DB list + fixture flags
  cfg: AirdropConfig;
}

/**
 * Apply every eligibility rule in §1, then produce a deterministic snapshot:
 * eligible wallets sorted by pubkey, capped at `poolMax` (largest holders kept),
 * plus a `poolHash` anyone can recompute from the pool list.
 */
export function buildEligiblePool(holders: Holder[], opts: PoolOpts): EligiblePool {
  const { now, lastThresholdTs, exclusions, cfg } = opts;

  const eligible = holders.filter((h) => {
    if (exclusions.has(h.address)) return false; // rule 5: excluded
    if (h.balance < cfg.minHoldTokens) return false; // rule 1: holds enough
    if (h.qualifiedSince == null) return false; // rule 2: has qualified at all
    if (now - h.qualifiedSince < cfg.minHoldSecs) return false; // rule 2: long enough
    if (h.lastSellTs != null && h.lastSellTs > lastThresholdTs) return false; // rule 3: no recent sell
    if (h.lastAirdropTs != null && now - h.lastAirdropTs < cfg.repeatCooldownSecs) return false; // rule 6
    return true;
  });

  // Over the cap? Keep the largest holders, then restore deterministic order.
  let kept = eligible;
  if (eligible.length > cfg.poolMax) {
    kept = [...eligible].sort((a, b) => b.balance - a.balance).slice(0, cfg.poolMax);
  }
  kept = [...kept].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  const wallets = kept.map((h) => h.address);
  const members: PoolMember[] = kept.map((h) => ({
    wallet: h.address,
    balanceTokens: h.balance,
    qualifiedSince: h.qualifiedSince as number,
    heldHours: Math.floor((now - (h.qualifiedSince as number)) / 3600),
  }));
  return { wallets, members, poolHash: sha256Hex(wallets.join(",")), poolSize: wallets.length };
}

// ---- Verifiable selection: favored + fortune (docs/11 §2) -----------------

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** seed = sha256(recent_blockhash || threshold_step). */
export function computeSeed(blockhash: string, step: number): string {
  return sha256Hex(`${blockhash}|${step}`);
}

/**
 * sha256 counter-mode PRNG: an endless stream of 32-bit unsigned ints drawn
 * from sha256(seed ":" counter). Deterministic for a given seed, and anyone can
 * reproduce it. (A small modulo bias when reducing to a range is acceptable
 * here — this picks meme-coin airdrop winners, not cryptographic nonces.)
 */
function* prng(seedHex: string): Generator<number> {
  let counter = 0;
  for (;;) {
    const h = createHash("sha256").update(`${seedHex}:${counter}`).digest();
    for (let i = 0; i + 4 <= h.length; i += 4) yield h.readUInt32BE(i);
    counter += 1;
  }
}

/** Deterministic Fisher–Yates shuffle driven by the seed. Returns a copy. */
export function seededShuffle<T>(items: T[], seedHex: string): T[] {
  const a = [...items];
  const rng = prng(seedHex);
  for (let i = a.length - 1; i > 0; i--) {
    const r = rng.next().value as number;
    const j = r % (i + 1);
    const tmp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = tmp;
  }
  return a;
}

/**
 * The random picks: remove favored wallets from the sorted pool, shuffle the
 * rest by the seed, and take the remaining slots. Deterministic for a given
 * (pool, favored, seed).
 */
export function fortuneDraw(
  sortedPool: string[],
  favored: string[],
  seedHex: string,
  recipients: number
): string[] {
  const favoredSet = new Set(favored);
  const rest = sortedPool.filter((w) => !favoredSet.has(w));
  const need = Math.max(0, recipients - favored.length);
  return seededShuffle(rest, seedHex).slice(0, need);
}

/**
 * Final recipients = favored ++ fortune (length <= recipients). If the pool has
 * fewer than `recipients` wallets, everyone in the pool receives (favored first,
 * for stable narration).
 */
export function selectRecipients(
  sortedPool: string[],
  favored: string[],
  seedHex: string,
  recipients: number
): string[] {
  if (sortedPool.length <= recipients) {
    const inPool = favored.filter((w) => sortedPool.includes(w));
    const favoredSet = new Set(inPool);
    return [...inPool, ...sortedPool.filter((w) => !favoredSet.has(w))];
  }
  return [...favored, ...fortuneDraw(sortedPool, favored, seedHex, recipients)];
}

/** Equal split: floor(cap / count) lamports each. Never exceeds the cap. */
export function equalSplit(capLamports: number, count: number): number {
  return count > 0 ? Math.floor(capLamports / count) : 0;
}
