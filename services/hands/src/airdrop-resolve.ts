// Resolve an airdrop decision into concrete recipients + amounts (docs/11 §4).
// The Brain only sends `favored`; Hands loads the pool snapshot + seed Eyes
// recorded for this threshold, validates the favored picks, computes the fortune
// draw deterministically, builds `favored ++ fortune` (<= AIRDROP_RECIPIENTS)
// with an equal split, and hands the result back so the caller can submit it and
// record the round. This also enforces the 5-recipient cap off-chain today,
// before the on-chain cap catches up through the timelock.

import {
  airdropConfig,
  equalSplit,
  selectRecipients,
  type Briefing,
  type MemoryDb,
  type VaultConfig,
} from "@pennyboi/shared";
import type { Decision } from "./types.js";

export interface AirdropResolved {
  step: number;
  favored: string[];
  fortune: string[];
  recipients: string[];
  amounts: number[];
  amountEach: number;
  poolSize: number;
  seed: string;
}

export type AirdropResolution = { ok: true; resolved: AirdropResolved } | { ok: false; error: string };

function parsePool(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export function resolveAirdrop(
  decision: Decision,
  briefing: Briefing | undefined,
  cfg: VaultConfig,
  db: MemoryDb
): AirdropResolution {
  const step = briefing?.treasury?.threshold_step;
  if (typeof step !== "number") return { ok: false, error: "no threshold_step in briefing" };

  const round = db.getAirdropRound(step);
  if (!round) return { ok: false, error: `no airdrop pool snapshot for step ${step}` };
  const pool = parsePool(round.pool_json);
  if (pool.length === 0) return { ok: false, error: "airdrop pool snapshot is empty" };

  // Validate the favored picks against the pool AND the briefing's candidates.
  const acfg = airdropConfig();
  const poolSet = new Set(pool);
  const candidates = new Set(
    (briefing?.available_actions?.airdrop?.favored_candidates ?? []).map((c) => c.wallet)
  );
  const rawFavored = Array.isArray(decision.params.favored) ? (decision.params.favored as unknown[]) : [];
  const favored: string[] = [];
  const seen = new Set<string>();
  for (const w of rawFavored) {
    if (typeof w !== "string") return { ok: false, error: "favored contains a non-string value" };
    if (seen.has(w)) return { ok: false, error: `favored "${w}" is duplicated` };
    if (!poolSet.has(w)) return { ok: false, error: `favored "${w}" is not in the pool` };
    if (!candidates.has(w)) return { ok: false, error: `favored "${w}" is not in favored_candidates` };
    seen.add(w);
    favored.push(w);
  }
  if (favored.length > acfg.favoredMax) {
    return { ok: false, error: `favored has ${favored.length} (max ${acfg.favoredMax})` };
  }

  // Fortune fills the remaining slots from the seed; recipients <= AIRDROP_RECIPIENTS.
  const recipients = selectRecipients(pool, favored, round.seed, acfg.recipients);
  const fortune = recipients.filter((w) => !seen.has(w));
  const amountEach = equalSplit(cfg.airdropCapLamports, recipients.length);
  if (amountEach <= 0) {
    return { ok: false, error: `equal split is zero (cap ${cfg.airdropCapLamports} / ${recipients.length})` };
  }
  const amounts = recipients.map(() => amountEach);

  return {
    ok: true,
    resolved: {
      step,
      favored,
      fortune,
      recipients,
      amounts,
      amountEach,
      poolSize: pool.length,
      seed: round.seed,
    },
  };
}
