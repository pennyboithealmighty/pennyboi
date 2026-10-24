// Rolling record of trading activity since the last threshold crossing.
// Reset after each briefing is built. In-memory for v0.1; moves to SQLite with
// the memory DB in build-plan Step 6.

import type { BuyerRow, SellerRow } from "@pennyboi/shared";
import type { TradeEvent } from "./parser.js";

/** What the briefing builder needs from an activity source (fakeable in tests). */
export interface ActivitySource {
  topBuyers(n: number): BuyerRow[];
  topSellers(n: number): SellerRow[];
  volumeSol(): number;
  holderChange(): number;
}

export class ActivityWindow implements ActivitySource {
  private buys = new Map<string, number>(); // wallet -> total sol_in
  private sells = new Map<string, number>(); // wallet -> total sol_out
  private volume = 0;

  record(ev: TradeEvent): void {
    if (ev.kind === "buy") {
      this.buys.set(ev.wallet, (this.buys.get(ev.wallet) ?? 0) + ev.sol);
    } else {
      this.sells.set(ev.wallet, (this.sells.get(ev.wallet) ?? 0) + ev.sol);
    }
    this.volume += ev.sol;
  }

  recordMany(evs: TradeEvent[]): void {
    for (const e of evs) this.record(e);
  }

  topBuyers(n: number): BuyerRow[] {
    return [...this.buys.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([wallet, sol_in]) => ({ wallet, sol_in }));
  }

  topSellers(n: number): SellerRow[] {
    return [...this.sells.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([wallet, sol_out]) => ({ wallet, sol_out }));
  }

  volumeSol(): number {
    return this.volume;
  }

  /** Approximate net holder change: distinct buyers minus distinct sellers. */
  holderChange(): number {
    return this.buys.size - this.sells.size;
  }

  reset(): void {
    this.buys.clear();
    this.sells.clear();
    this.volume = 0;
  }
}
