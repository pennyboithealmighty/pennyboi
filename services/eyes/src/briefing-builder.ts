// Assemble the structured briefing from on-chain config + rolling activity.
// Offerings / past actions / grudges / loyal come from the memory DB once it
// exists (Step 6); until then they default to empty.

import {
  computeAvailableActions,
  pickMood,
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
}

export function buildBriefing(
  cfg: VaultConfig,
  treasurySol: number,
  activity: ActivitySource,
  nowSecs: number,
  opts: BuildOpts = {}
): Briefing {
  return {
    mood: opts.mood ?? pickMood(opts.rng),
    treasury: {
      balance_sol: treasurySol,
      threshold_step: cfg.thresholdStep,
      actions_banked: cfg.actionsAvailable,
    },
    available_actions: computeAvailableActions(cfg, nowSecs),
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
