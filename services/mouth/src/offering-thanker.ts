// Offering thanks (docs/12 §3). Polls the `donations` table for gifts Eyes has
// recorded but not yet announced, batches them within OFFERING_BATCH_SECS, asks
// Brain for in-character thanks (falling back to shared templates if Brain is
// unreachable), announces them in the Telegram Offerings topic with a Solscan
// link per named donor, and — subject to X_MODE, the daily cap, and the
// per-donor cooldown — posts one thanks to X with no links.
//
// Pennyboi never DMs a donor (docs/12 §0). A gift never affects airdrops.

import {
  donorDisplay,
  envStr,
  fallbackThanks,
  foldByCooldown,
  lamportsToSol,
  offeringConfig,
  shouldThankOnX,
  type DonationRow,
  type DonationTier,
  type OfferingConfig,
  type ThankInput,
  type Thanks,
} from "@pennyboi/shared";
import { sendSafe } from "./announce.js";
import type { MouthCtx } from "./deps.js";
import { solscanTx } from "./links.js";

const TIER_RANK: Record<DonationTier, number> = { dust: 0, offering: 1, grand: 2 };

function dayKey(now = Date.now()): string {
  const d = new Date(now);
  return `offering_x_count:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * The Offerings topic thread id. Prefer the configured id; otherwise use the one
 * learned from /offer usage (people pitch offerings in that same topic). Returns
 * undefined only when neither is known (then thanks fall back to General).
 */
export function offeringsThreadId(m: MouthCtx): number | undefined {
  if (m.cfg.topics.offerings != null) return m.cfg.topics.offerings;
  const learned = Number(m.db.kvGet("offerings_thread_id"));
  return learned > 1 ? learned : undefined;
}

/** Thanks text + one "<name> — <sol> SOL · <solscan>" line per named donor. */
export function composeOfferingThanks(
  thanksText: string,
  named: Array<{ display: string; sol: number; solscanUrl: string }>
): string {
  const lines = named.map((n) => `${n.display} — ${n.sol.toFixed(3)} SOL · ${n.solscanUrl}`);
  return lines.length ? `${thanksText}\n\n${lines.join("\n")}` : thanksText;
}

export class OfferingThanker {
  private cfg: OfferingConfig;
  private running = false;

  constructor(private m: MouthCtx) {
    this.cfg = offeringConfig();
  }

  private brainThankUrl(): string {
    const base = new URL(envStr("BRAIN_URL", "http://127.0.0.1:8788/decide"));
    return `${base.origin}/thank`;
  }

  private xPostsToday(): number {
    return Number(this.m.db.kvGet(dayKey()) ?? "0") || 0;
  }
  private bumpXToday(): void {
    this.m.db.kvSet(dayKey(), String(this.xPostsToday() + 1));
  }

  /** Ask Brain for thanks; fall back to shared templates if Brain is unreachable. */
  private async getThanks(input: ThankInput): Promise<Thanks> {
    try {
      const res = await fetch(this.brainThankUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = (await res.json()) as { thanks?: Thanks };
      if (data?.thanks?.telegram && data.thanks.x) return data.thanks;
    } catch (e) {
      this.m.log.warn("offering thanks: Brain unreachable, using templates", e);
    }
    return fallbackThanks(input);
  }

  /** One pass over the thanks queue. Returns the number of gifts announced. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const rows = this.m.db.unannouncedOfferings(20);
      if (!rows.length) return 0;

      const now = Math.floor(Date.now() / 1000);
      const inCooldown = (donor: string): boolean => {
        const last = this.m.db.lastThankedTs(donor);
        return last != null && now - last < this.cfg.donorCooldownSecs;
      };
      const { named } = foldByCooldown(rows, inCooldown);

      const totalSol = rows.reduce((s, r) => s + lamportsToSol(r.lamports), 0);
      const lead = named[0] ?? rows[0]!;
      const topTier = rows.reduce<DonationTier>(
        (t, r) => (TIER_RANK[r.tier as DonationTier] > TIER_RANK[t] ? (r.tier as DonationTier) : t),
        "offering"
      );
      const treasurySol = await this.m.chain.treasuryStatus().then((s) => s?.balanceSol ?? 0).catch(() => 0);
      const nickname = this.m.db.nicknameOf(lead.donor);

      const input: ThankInput = {
        donor_display: donorDisplay(lead.donor, nickname).display,
        sol: lamportsToSol(lead.lamports),
        tier: lead.tier as DonationTier,
        is_creator: lead.is_creator === 1,
        memo_clean: lead.memo_clean,
        nickname,
        donor_offering_count: this.m.db.countDonationsByDonor(lead.donor),
        treasury_sol: treasurySol,
        batch_count: rows.length >= 2 ? rows.length : undefined,
        batch_total_sol: rows.length >= 2 ? totalSol : undefined,
      };

      const thanks = await this.getThanks(input);

      // Telegram, in the Offerings topic: thanks + one named line (nickname or
      // 4+4 short) with a Solscan link per named donor (docs/12 §3).
      const namedViews = (named.length ? named : [lead]).map((r) => ({
        display: donorDisplay(r.donor, this.m.db.nicknameOf(r.donor)).display,
        sol: lamportsToSol(r.lamports),
        solscanUrl: solscanTx(this.m.cfg, r.tx_sig),
      }));
      const message = composeOfferingThanks(thanks.telegram, namedViews);
      await sendSafe(this.m, message, { threadId: offeringsThreadId(this.m) });

      // Write the final narration back so /public/offering/receipt returns it.
      for (const r of rows) {
        this.m.db.markOfferingAnnounced(r.tx_sig, { tg: true });
        this.m.db.setOfferingNarration(r.tx_sig, thanks.telegram);
      }

      // X: one thanks, no links — subject to mode, daily cap, and the tier rule.
      if (
        shouldThankOnX({
          mode: this.m.cfg.x.mode,
          xInPrelaunch: this.cfg.xInPrelaunch,
          tier: topTier,
          postsToday: this.xPostsToday(),
          maxPerDay: this.cfg.xMaxPerDay,
        })
      ) {
        const id = await this.m.x.post(thanks.x);
        if (id) {
          this.bumpXToday();
          for (const r of rows) this.m.db.markOfferingAnnounced(r.tx_sig, { x: true });
        }
      }

      this.m.log.info(`offering thanks: announced ${rows.length} gift(s) (${named.length} named)`);
      return rows.length;
    } catch (e) {
      this.m.log.error("offering thanker tick failed", e);
      return 0;
    } finally {
      this.running = false;
    }
  }

  start(): void {
    const everyMs = Math.max(15, this.cfg.batchSecs) * 1000;
    this.m.log.info(`offering thanker polling every ${everyMs / 1000}s`);
    setInterval(() => void this.tick(), everyMs);
  }
}
