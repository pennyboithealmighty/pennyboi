// X pre-launch "Prophecy" scheduler (docs/09). Posts a few jittered in-character
// teases per day via Brain /prophecy, runs them through the outbound sanitizer,
// applies the link policy, posts to X, and records every outcome. Nothing
// on-chain/devnet ever reaches X — this path never touches the briefing.

import { envStr, pickMood } from "@pennyboi/shared";
import type { MouthCtx } from "./deps.js";
import {
  planDaySlots,
  rejectProphecy,
  shouldAppendLink,
  themeAt,
} from "./x-prophecy.js";

export interface ProduceResult {
  status: "posted" | "rejected" | "skipped" | "error" | "dryrun";
  text?: string;
  theme?: string;
  reason?: string;
  xPostId?: string;
}

const OPENINGS = ["mortals", "congregation", "pennies", "none"] as const;
const CODE_PHRASE = "the code owns everything";

function startOfDayLocal(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function daysUntil(launchDate: string): number | null {
  if (!launchDate) return null;
  const t = Date.parse(launchDate);
  if (Number.isNaN(t)) return null;
  const d = Math.ceil((t - Date.now()) / 86_400_000);
  return d > 0 ? d : null; // countdown retires at/after launch
}

export class ProphecyScheduler {
  private paused = false;
  private themeIndex = 0;
  private openingIndex = 0;
  private todaySlots: number[] = [];

  constructor(private m: MouthCtx) {
    this.paused = m.db.kvGet("x_paused") === "1";
  }

  private brainProphecyUrl(): string {
    const base = new URL(envStr("BRAIN_URL", "http://127.0.0.1:8788/decide"));
    return `${base.origin}/prophecy`;
  }

  start(): void {
    if (this.m.cfg.x.mode === "off") {
      this.m.log.info("X_MODE=off — prophecy scheduler not started.");
      return;
    }
    this.scheduleToday();
  }

  private scheduleToday(): void {
    const now = Date.now();
    const dayStart = startOfDayLocal(now);
    const p = this.m.cfg.x.prelaunch;
    this.todaySlots = planDaySlots({
      dayStartMs: dayStart,
      postsPerDay: p.postsPerDay,
      hoursStart: p.hoursStart,
      hoursEnd: p.hoursEnd,
    });
    const upcoming = this.todaySlots.filter((s) => s > now);
    for (const s of upcoming) {
      setTimeout(() => {
        if (!this.paused) void this.produceAndPost(false);
      }, s - now);
    }
    // Re-plan at next local midnight.
    setTimeout(() => this.scheduleToday(), dayStart + 86_400_000 - now + 1000);
    this.m.log.info(`prophecy: planned ${upcoming.length} post(s) for today (mode=${this.m.cfg.x.mode})`);
  }

  private async callBrain(
    theme: string,
    mood: string,
    opening: string,
    avoidPhrases: string[]
  ): Promise<{ post: string; theme: string } | null> {
    const recentPosts = this.m.db.recentXPosts(5).map((r) => r.text);
    try {
      const res = await fetch(this.brainProphecyUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mood,
          theme,
          daysUntilAwakening: daysUntil(this.m.cfg.x.prelaunch.launchDate),
          recentPosts,
          opening,
          avoidPhrases,
        }),
      });
      const data = (await res.json()) as { prophecy?: { post: string; theme: string } | null };
      return data.prophecy ?? null;
    } catch (e) {
      this.m.log.error("prophecy: Brain call failed", e);
      return null;
    }
  }

  /** Generate (+ optionally post) one prophecy. dryrun=true never posts to X. */
  async produceAndPost(dryrun: boolean): Promise<ProduceResult> {
    const now = Math.floor(Date.now() / 1000);
    const mood = pickMood();
    const hasLaunch = daysUntil(this.m.cfg.x.prelaunch.launchDate) !== null;
    const theme = themeAt(this.themeIndex++, hasLaunch);
    const opening = OPENINGS[this.openingIndex++ % OPENINGS.length]!;

    // Keep "the code owns everything" to at most once per 5 posts: if it appeared
    // in the last 4 posted ones, tell Brain to avoid it this time.
    const recentPosted = this.m.db
      .recentXPosts(10)
      .filter((r) => r.status === "posted")
      .slice(0, 4)
      .map((r) => r.text);
    const avoidPhrases = recentPosted.some((t) => t.toLowerCase().includes(CODE_PHRASE))
      ? [CODE_PHRASE]
      : [];

    const prophecy = await this.callBrain(theme, mood, opening, avoidPhrases);
    if (!prophecy) {
      if (!dryrun) this.m.db.recordXPost({ now, theme, mood, text: "", status: "skipped" });
      return { status: "skipped", theme };
    }

    const check = rejectProphecy(prophecy.post);
    if (!check.ok) {
      this.m.log.warn(`prophecy rejected (${check.reason}): ${prophecy.post}`);
      if (!dryrun) {
        this.m.db.recordXPost({ now, theme: prophecy.theme, mood, text: prophecy.post, status: "rejected", rejectionReason: check.reason });
      }
      return { status: "rejected", text: prophecy.post, theme: prophecy.theme, reason: check.reason };
    }

    // Link policy.
    let text = prophecy.post;
    const dayStart = startOfDayLocal();
    if (
      shouldAppendLink({
        isFirstOfDay: this.m.db.xPostedTodayCount(dayStart) === 0,
        linkedToday: this.m.db.xLinkUsedToday(dayStart),
        rate: this.m.cfg.x.prelaunch.linkRate,
      })
    ) {
      text = `${text} pennyboi.com`;
    }

    if (dryrun) return { status: "dryrun", text, theme: prophecy.theme };

    const id = await this.m.x.post(text);
    if (id) {
      this.m.db.recordXPost({ now, theme: prophecy.theme, mood, text, xPostId: id, status: "posted" });
      return { status: "posted", text, theme: prophecy.theme, xPostId: id };
    }
    this.m.db.recordXPost({ now, theme: prophecy.theme, mood, text, status: "error" });
    return { status: "error", text, theme: prophecy.theme };
  }

  /** /xpost — post exact owner text now (bypasses Brain, still sanitized). */
  async postExact(text: string): Promise<ProduceResult> {
    const now = Math.floor(Date.now() / 1000);
    const check = rejectProphecy(text);
    if (!check.ok) {
      this.m.db.recordXPost({ now, text, status: "rejected", rejectionReason: check.reason });
      return { status: "rejected", text, reason: check.reason };
    }
    const id = await this.m.x.post(text);
    if (id) {
      this.m.db.recordXPost({ now, text, xPostId: id, status: "posted" });
      return { status: "posted", text, xPostId: id };
    }
    this.m.db.recordXPost({ now, text, status: "error" });
    return { status: "error", text };
  }

  pause(): void {
    this.paused = true;
    this.m.db.kvSet("x_paused", "1");
  }
  resume(): void {
    this.paused = false;
    this.m.db.kvSet("x_paused", "0");
  }
  isPaused(): boolean {
    return this.paused;
  }

  status(): {
    mode: string;
    paused: boolean;
    postsToday: number;
    nextSlotIso: string | null;
  } {
    const now = Date.now();
    const next = this.todaySlots.find((s) => s > now);
    return {
      mode: this.m.cfg.x.mode,
      paused: this.paused,
      postsToday: this.m.db.xPostedTodayCount(startOfDayLocal()),
      nextSlotIso: next ? new Date(next).toISOString() : null,
    };
  }
}
