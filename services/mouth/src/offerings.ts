// Offering selection (docs/06 §2C): top N by upvotes feed the next briefing.

export interface OfferingRecord {
  id: number;
  ts: number;
  wallet: string; // telegram handle / id stand-in until wallets are linked
  text: string;
  upvotes: number;
  chosen: number; // 0/1
}

/** Top `n` offerings by upvotes (ties broken by earliest submission). */
export function rankOfferings(rows: OfferingRecord[], n = 5): OfferingRecord[] {
  return [...rows]
    .sort((a, b) => b.upvotes - a.upvotes || a.ts - b.ts)
    .slice(0, n);
}
