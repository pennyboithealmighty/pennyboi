// Nickname / grudge / loyalty extraction (docs/06 §2D, docs/04 Layer 3 step 6).
//
// Two signals, strongest first:
//  1. The ACTION itself (deterministic): airdrop recipients and bounty targets
//     are wallets Pennyboi just blessed -> loyalty.
//  2. The NARRATION (heuristic): wallets from the briefing that Pennyboi names
//     (by full address or a "7xK…" truncation) get a grudge or loyalty based on
//     nearby sentiment words, plus an optional coined nickname.

import type { Briefing } from "./briefing.js";
import type { MemoryUpdate } from "./memory.js";

interface DecisionLike {
  action: string;
  params: Record<string, unknown>;
  narration?: string;
}

const GRUDGE_WORDS =
  /\b(forsaken|forsake|betray|betrayed|traitor|sold|dump|dumped|jeet|remember this|grudge|wrath|punish)\b/i;
const BLESS_WORDS =
  /\b(bless|blessed|loyal|faithful|reward|rewarded|chosen|devout|congregation|anoint)\b/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All wallets the briefing legitimately knows about, with their role. */
function briefingWallets(b: Briefing): Map<string, "buyer" | "seller" | "other"> {
  const m = new Map<string, "buyer" | "seller" | "other">();
  for (const x of b.since_last_threshold.top_new_buyers) m.set(x.wallet, "buyer");
  for (const x of b.since_last_threshold.biggest_sellers) m.set(x.wallet, "seller");
  for (const x of b.offerings_from_telegram) if (!m.has(x.wallet)) m.set(x.wallet, "other");
  for (const x of b.grudges) if (!m.has(x.wallet)) m.set(x.wallet, "seller");
  for (const x of b.loyal) if (!m.has(x.wallet)) m.set(x.wallet, "buyer");
  return m;
}

/** Does `narration` reference `wallet` — full address or a "<prefix>…"/"..."? */
export function narrationReferences(narration: string, wallet: string): boolean {
  if (narration.includes(wallet)) return true;
  const pre = wallet.slice(0, 5);
  if (pre.length < 4) return false;
  return new RegExp(`${escapeRe(pre)}\\w*\\s*(\\.{2,}|…)`).test(narration);
}

/** Pull a coined nickname like: known as "THE FAITHFUL" / shall be called X. */
function findNickname(narration: string): string | undefined {
  const m =
    narration.match(/known as "?([A-Z][\w ]{2,24}?)"?[.,!]/) ??
    narration.match(/shall be (?:called|known as) "?([A-Z][\w ]{2,24}?)"?[.,!]/);
  return m ? m[1]!.trim() : undefined;
}

export function extractMemory(
  decision: DecisionLike,
  briefing?: Briefing
): MemoryUpdate {
  const seen = new Set<string>();
  const loyal: MemoryUpdate["loyal"] = [];
  const grudges: MemoryUpdate["grudges"] = [];
  const narration = decision.narration ?? "";

  // 1) Action-derived loyalty (deterministic).
  if (decision.action === "airdrop" && Array.isArray(decision.params.recipients)) {
    for (const w of decision.params.recipients as unknown[]) {
      if (typeof w === "string") {
        seen.add(w);
        loyal.push({ wallet: w, reason: "blessed in an airdrop" });
      }
    }
  }
  if (decision.action === "bounty" && typeof decision.params.to === "string") {
    const w = decision.params.to;
    seen.add(w);
    loyal.push({ wallet: w, reason: "funded an offering" });
  }

  // 2) Narration-derived sentiment over known briefing wallets.
  if (briefing && narration) {
    const nickname = findNickname(narration);
    const referenced: string[] = [];
    for (const [wallet, role] of briefingWallets(briefing)) {
      if (!narrationReferences(narration, wallet)) continue;
      referenced.push(wallet);
      seen.add(wallet);
      const grudge = GRUDGE_WORDS.test(narration);
      const bless = BLESS_WORDS.test(narration);
      if (role === "seller" || (grudge && !bless)) {
        grudges.push({ wallet, reason: "named after selling" });
      } else if (role === "buyer" || bless) {
        loyal.push({ wallet, reason: "named in narration" });
      }
    }
    // Attach a coined nickname only when exactly one wallet was referenced.
    if (nickname && referenced.length === 1) {
      const w = referenced[0]!;
      const entry = loyal.find((l) => l.wallet === w);
      if (entry) entry.nickname = nickname;
      else loyal.push({ wallet: w, reason: "named in narration", nickname });
    }
  }

  return { seen: [...seen], loyal, grudges };
}
