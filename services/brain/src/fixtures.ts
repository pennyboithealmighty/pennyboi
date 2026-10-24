// Shared test fixtures: a briefing with a couple of known wallets.
import type { Briefing } from "@pennyboi/shared";

// Canonical valid base58 pubkeys (used as stand-in wallet addresses).
export const BUYER = "So11111111111111111111111111111111111111112";
export const SELLER = "Vote111111111111111111111111111111111111111";

export function makeBriefing(over: Partial<Briefing> = {}): Briefing {
  return {
    mood: "greedy",
    treasury: { balance_sol: 2.5, threshold_step: 1, actions_banked: 3 },
    available_actions: {
      burn: { cap_lamports: 100_000_000 },
      airdrop: {
        cap_lamports: 100_000_000,
        max_recipients: 5,
        recipients: 5,
        favored_max: 2,
        pool_size: 3,
        favored_candidates: [
          { wallet: BUYER, nickname: "THE FAITHFUL", reason: "loyal", held_hours: 48, balance_tokens: 500_000 },
        ],
      },
      bounty: { cap_lamports: 50_000_000 },
    },
    since_last_threshold: {
      top_new_buyers: [{ wallet: BUYER, sol_in: 1.2 }],
      biggest_sellers: [{ wallet: SELLER, sol_out: 0.8 }],
      volume_sol: 2.0,
      holder_count_change: 1,
    },
    offerings_from_telegram: [],
    your_last_actions: [],
    grudges: [],
    loyal: [],
    ...over,
  };
}
