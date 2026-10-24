// Build the airdrop eligible pool at a threshold (docs/11 §1-§3). Eyes assembles
// the exclusion set, reads the holder source (mock on devnet), filters to the
// eligible pool, computes the verifiable seed from a recent blockhash, stores
// the snapshot by threshold step, and returns the enriched `airdrop` object for
// the briefing — or null when the pool is empty (airdrop is then omitted).

import {
  airdropConfig,
  buildEligiblePool,
  computeSeed,
  loadMockHolders,
  repoRoot,
  type AvailableActions,
  type FavoredCandidate,
  type LoadedVault,
  type MemoryDb,
  type PoolMember,
  type VaultConfig,
} from "@pennyboi/shared";
import type { Connection } from "@solana/web3.js";
import { join } from "node:path";
import type { Logger } from "./log.js";

export interface AirdropPoolDeps {
  cfg: VaultConfig;
  nowSecs: number;
  connection: Connection;
  db: MemoryDb;
  vault: LoadedVault;
  log: Logger;
}

/** Addresses that can never be in the pool: the protocol's own accounts. */
export function staticExclusions(cfg: VaultConfig, vault: LoadedVault): Set<string> {
  return new Set([
    cfg.admin,
    cfg.agent,
    cfg.tokenMint,
    vault.programId.toBase58(),
    vault.configPda.toBase58(),
    vault.treasuryPda.toBase58(),
    vault.feesPda.toBase58(),
  ]);
}

/**
 * The shortlist Pennyboi may hand-pick from (docs/11 §3): pool members who are
 * also in his loyal list (with nickname + reason) first, then the longest-held
 * pool members, up to `max` total.
 */
export function buildFavoredCandidates(
  members: PoolMember[],
  loyal: Array<{ wallet: string; nickname: string | null; reason: string }>,
  max = 15,
  durationCap = 10
): FavoredCandidate[] {
  const loyalMap = new Map(loyal.map((l) => [l.wallet, l]));
  const byDuration = [...members].sort((a, b) => b.heldHours - a.heldHours);
  const out: FavoredCandidate[] = [];
  const seen = new Set<string>();

  // Loyal members in the pool, longest-held first.
  for (const m of byDuration) {
    if (out.length >= max) break;
    const l = loyalMap.get(m.wallet);
    if (!l) continue;
    out.push({
      wallet: m.wallet,
      nickname: l.nickname ?? undefined,
      reason: l.reason,
      held_hours: m.heldHours,
      balance_tokens: m.balanceTokens,
    });
    seen.add(m.wallet);
  }

  // Then fill with the longest-held non-loyal members (up to durationCap of them).
  let added = 0;
  for (const m of byDuration) {
    if (out.length >= max || added >= durationCap) break;
    if (seen.has(m.wallet)) continue;
    out.push({ wallet: m.wallet, held_hours: m.heldHours, balance_tokens: m.balanceTokens });
    seen.add(m.wallet);
    added += 1;
  }
  return out;
}

/**
 * Returns the enriched `airdrop` briefing entry, or null when the pool is empty
 * (so the caller omits airdrop from available_actions). Also persists the pool
 * snapshot + seed so Hands can recompute the fortune draw deterministically.
 */
export async function buildAirdropPool(
  deps: AirdropPoolDeps
): Promise<NonNullable<AvailableActions["airdrop"]> | null> {
  const { cfg, nowSecs, connection, db, vault, log } = deps;
  const acfg = airdropConfig();

  if (acfg.holderSource !== "mock") {
    // The Helius DAS holder path is not wired yet (docs/11 §7B); until then,
    // only the mock source builds a pool. Omit airdrop rather than guess.
    log.warn(`HOLDER_SOURCE=${acfg.holderSource} not implemented — airdrop omitted this threshold.`);
    return null;
  }

  // Holders + exclusions (protocol accounts + fixture flags + DB /exclude list).
  const { holders, exclusions: fixtureEx } = loadMockHolders(
    join(repoRoot(), "db", "mock-holders.json"),
    nowSecs
  );
  const exclusions = new Set<string>([
    ...staticExclusions(cfg, vault),
    ...fixtureEx,
    ...db.excludedSet(),
  ]);

  // "No sell since the last threshold": use the previous recorded round's ts as
  // the last-threshold time (fall back to 24h on the first run).
  const prior = db.recentAirdropRounds(5).find((r) => r.step !== cfg.thresholdStep);
  const lastThresholdTs = prior ? prior.ts : nowSecs - 86_400;

  const pool = buildEligiblePool(holders, { now: nowSecs, lastThresholdTs, exclusions, cfg: acfg });
  if (pool.poolSize === 0) {
    log.info("airdrop pool is empty this threshold — airdrop omitted.");
    return null;
  }

  // Verifiable seed from a recent blockhash, recorded with the snapshot.
  const { blockhash } = await connection.getLatestBlockhash();
  const seed = computeSeed(blockhash, cfg.thresholdStep);
  db.saveAirdropRound({
    step: cfg.thresholdStep,
    now: nowSecs,
    seed,
    blockhash,
    poolHash: pool.poolHash,
    poolSize: pool.poolSize,
    pool: pool.wallets,
  });

  const loyal = db.listLoyal(50).map((l) => ({ wallet: l.wallet, nickname: l.nickname, reason: l.reason }));
  return {
    cap_lamports: cfg.airdropCapLamports,
    max_recipients: cfg.airdropMaxRecipients,
    recipients: acfg.recipients,
    favored_max: acfg.favoredMax,
    pool_size: pool.poolSize,
    favored_candidates: buildFavoredCandidates(pool.members, loyal),
  };
}
