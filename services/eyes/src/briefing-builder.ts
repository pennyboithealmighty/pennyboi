// Assemble the structured briefing from on-chain config + rolling activity.
// Offerings / past actions / grudges / loyal come from the memory DB once it
// exists (Step 6); until then they default to empty.

import {
  computeAvailableActions,
  pickMood,
  type AvailableActions,
  type Briefing,
  type GrudgeRow,
  type LoyalRow,
  type Mood,
  type OfferingRow,
  type PastActionRow,
  type VaultConfig,
} from "@pennyboi/shared";
import type { ActivitySource } from "./activity.js";

export interface BuildOpts {
  mood?: Mood;
  offerings?: OfferingRow[];
  lastActions?: PastActionRow[];
  grudges?: GrudgeRow[];
  loyal?: LoyalRow[];
  rng?: () => number;
  // Airdrop pool enrichment (docs/11), only when airdrop is off cooldown:
  //   object -> use this enriched airdrop entry; null -> omit airdrop (empty
  //   pool); undefined -> leave the plain cooldown entry as-is.
  airdrop?: AvailableActions["airdrop"] | null;
}

export function buildBriefing(
  cfg: VaultConfig,
  treasurySol: number,
  activity: ActivitySource,
  nowSecs: number,
  opts: BuildOpts = {}
): Briefing {
  const available = computeAvailableActions(cfg, nowSecs);
  // Replace the plain airdrop entry with the enriched pool (or drop it if the
  // pool came back empty). Only applies when airdrop is off cooldown.
  if (available.airdrop && opts.airdrop !== undefined) {
    if (opts.airdrop === null) delete available.airdrop;
    else available.airdrop = opts.airdrop;
  }
  return {
    mood: opts.mood ?? pickMood(opts.rng),
    treasury: {
      balance_sol: treasurySol,
      threshold_step: cfg.thresholdStep,
      actions_banked: cfg.actionsAvailable,
    },
    available_actions: available,
    since_last_threshold: {
      top_new_buyers: activity.topBuyers(5),
      biggest_sellers: activity.topSellers(5),
      volume_sol: activity.volumeSol(),
      holder_count_change: activity.holderChange(),
    },
    offerings_from_telegram: opts.offerings ?? [],
    your_last_actions: opts.lastActions ?? [],
    grudges: opts.grudges ?? [],
    loyal: opts.loyal ?? [],
  };
}
