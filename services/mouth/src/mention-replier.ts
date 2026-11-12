// X mention replies (dry-run first). Two decoupled loops:
//   - poll: every MENTION_POLL_SECS read new mentions since the saved since_id,
//     classify each, and record it as pending or skipped (with the reason)
//   - drain: answer the oldest pending mention, one at a time, never closer
//     together than MENTION_REPLY_MIN_GAP_SECS, and only inside every cap
// Everything is persisted (since_id, the queue, the day's spend, the next
// allowed reply time), so a restart neither re-reads nor re-replies.
//
// Separate from the once-a-day post: this never touches PostGuard, x_posts or
// the catchphrase counter. In dry-run nothing is posted; the reply it would
// have sent is logged and stored instead.

import {
  envStr,
  pickMood,
  rejectReply,
  sanitizeMentionText,
  shapeReply,
  type MemoryDb,
} from "@pennyboi/shared";
import type { MentionConfig } from "./config.js";
import type { Logger } from "./log.js";
import {
  MIN_PAGE,
  MentionsApiError,
  SpendLedger,
  classifyMention,
  pollPageSize,
  startOfDayLocalSecs,
  type MentionsClient,
  type RawMention,
} from "./x-mentions.js";

export type Generated =
  | { kind: "reply"; text: string }
  | { kind: "rejected"; reason: string }
  | { kind: "unavailable"; reason: string };
export type GenerateReply = (mentionText: string) => Promise<Generated>;

/** Ask Brain /reply for an in-character answer to an already sanitized mention. */
export function brainReplyGenerator(): GenerateReply {
  return async (mentionText) => {
    const url = `${new URL(envStr("BRAIN_URL", "http://127.0.0.1:8788/decide")).origin}/reply`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mention_text: mentionText, mood: pickMood() }),
      });
    } catch (e) {
      return { kind: "unavailable", reason: `Brain unreachable: ${(e as Error).message}` };
    }
    if (res.status === 400) return { kind: "rejected", reason: "Brain refused the input" };
    if (!res.ok) return { kind: "unavailable", reason: `Brain /reply returned HTTP ${res.status}` };
    const data = (await res.json().catch(() => null)) as { reply?: string | null; reason?: string } | null;
    if (data?.reply) return { kind: "reply", text: data.reply };
    return { kind: "rejected", reason: data?.reason ?? "no reply" };
  };
}

const KV = {
  sinceId: "x_mentions_since_id",
  primedAt: "x_mentions_primed_at",
  botUserId: "x_bot_user_id",
  nextReplyAt: "x_mentions_next_reply_at",
} as const;

const DRAIN_SECS = 30;
const MAX_DECISIONS_PER_DRAIN = 25;
const RATE_LIMIT_BACKOFF_SECS = 900;

export interface ReplierDeps {
  db: MemoryDb;
  log: Logger;
  cfg: MentionConfig;
  client: MentionsClient;
  generate: GenerateReply;
  now?: () => number; // ms; injectable for tests
  rng?: () => number;
}

export interface PollOutcome {
  status: "primed" | "ok" | "skipped" | "error" | "busy";
  reason?: string;
  fetched: number;
  queued: number;
  skipped: number;
}

export interface DrainOutcome {
  decided: number;
  replied: number;
  waiting?: "min_gap" | "brain_unavailable" | "busy";
}

const NOTHING = { fetched: 0, queued: 0, skipped: 0 };

function quote(s: string): string {
  return JSON.stringify(s.replace(/\s+/g, " ").trim().slice(0, 140));
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function newestOf(mentions: RawMention[]): string | null {
  let best: string | null = null;
  for (const m of mentions) {
    if (best === null || BigInt(m.id) > BigInt(best)) best = m.id;
  }
  return best;
}

export class MentionReplier {
  private db: MemoryDb;
  private log: Logger;
  private cfg: MentionConfig;
  private client: MentionsClient;
  private generate: GenerateReply;
  private now: () => number;
  private rng: () => number;
  private ledger: SpendLedger;
  private polling = false;
  private draining = false;
  private backoffUntil = 0; // unix secs; set when X rate-limits us

  constructor(deps: ReplierDeps) {
    this.db = deps.db;
    this.log = deps.log;
    this.cfg = deps.cfg;
    this.client = deps.client;
    this.generate = deps.generate;
    this.now = deps.now ?? Date.now;
    this.rng = deps.rng ?? Math.random;
    this.ledger = new SpendLedger(deps.db, deps.cfg.spendCapUsd);
  }

  start(): void {
    const c = this.cfg;
    if (!c.enabled) {
      this.log.info("mentions: OFF (MENTION_REPLY_ENABLED is not true) — not polling.");
      return;
    }
    if (!this.client.ready) {
      this.log.warn("mentions: enabled, but the X client is not ready — not polling.");
      return;
    }
    this.log.info(
      `mentions: ON — ${c.dryRun ? "DRY-RUN (nothing will be posted)" : "LIVE (replies will be posted)"}` +
        ` | poll every ${c.pollSecs}s | caps ${c.maxPerDay}/day, ${c.maxPerUserPerDay}/user/day,` +
        ` $${c.spendCapUsd.toFixed(2)}/day | min gap ${c.minGapSecs}s`
    );
    const tick = async (): Promise<void> => {
      await this.pollOnce();
      await this.drainOnce();
    };
    setTimeout(() => void tick(), 3000);
    setInterval(() => void tick(), c.pollSecs * 1000);
    // The queue drains on its own clock so a gap-delayed reply needs no new read.
    setInterval(() => void this.drainOnce(), DRAIN_SECS * 1000);
  }

  // ---- poll ---------------------------------------------------------------

  async pollOnce(): Promise<PollOutcome> {
    if (this.polling) return { status: "busy", ...NOTHING };
    this.polling = true;
    try {
      return await this.poll();
    } catch (e) {
      return { status: "error", reason: this.noteApiError("poll", e), ...NOTHING };
    } finally {
      this.polling = false;
    }
  }

  /** Log an X failure; back off on a rate limit. Returns a short reason. */
  private noteApiError(what: string, e: unknown): string {
    const now = Math.floor(this.now() / 1000);
    if (e instanceof MentionsApiError) {
      if (e.rateLimited) {
        this.backoffUntil = e.resetAt && e.resetAt > now ? e.resetAt : now + RATE_LIMIT_BACKOFF_SECS;
        this.log.warn(
          `mentions: X rate limit hit during ${what} — pausing until ${isoSeconds(this.backoffUntil * 1000)}`
        );
        return "rate_limited";
      }
      this.log.error(
        `mentions: X API error during ${what}${e.status ? ` (HTTP ${e.status})` : ""}: ${e.message}`
      );
      return e.status ? `http_${e.status}` : "api_error";
    }
    this.log.error(`mentions: ${what} failed`, e);
    return "error";
  }

  private async botUserId(nowMs: number): Promise<string | null> {
    const known = this.cfg.botUserId || this.db.kvGet(KV.botUserId);
    if (known) return known;
    if (!this.ledger.canAfford(this.cfg.costUserLookupUsd, nowMs)) return null;
    const id = await this.client.getBotUserId();
    this.ledger.add(this.cfg.costUserLookupUsd, nowMs);
    if (id) {
      this.db.kvSet(KV.botUserId, id);
      this.log.info(`mentions: looked up the bot's user id (${id}) and cached it`);
    }
    return id;
  }

  private async poll(): Promise<PollOutcome> {
    const nowMs = this.now();
    const now = Math.floor(nowMs / 1000);
    if (now < this.backoffUntil) {
      this.log.info(`mentions: poll skipped — rate limited until ${isoSeconds(this.backoffUntil * 1000)}`);
      return { status: "skipped", reason: "rate_limited", ...NOTHING };
    }
    const botId = await this.botUserId(nowMs);
    if (!botId) {
      this.log.warn("mentions: poll skipped — the bot's user id is unavailable (set X_BOT_USER_ID to skip the lookup)");
      return { status: "skipped", reason: "no_bot_id", ...NOTHING };
    }

    const sinceId = this.db.kvGet(KV.sinceId) ?? undefined;
    const primedAt = this.db.kvGet(KV.primedAt) ?? undefined;
    if (!sinceId && !primedAt) return this.prime(botId, nowMs);

    const size = pollPageSize(this.ledger.remaining(nowMs), this.cfg.costReadUsd, this.cfg.pageMax);
    if (size === 0) {
      this.log.info(`mentions: poll skipped — daily X spend cap reached (${this.ledger.summary(nowMs)})`);
      return { status: "skipped", reason: "spend_cap", ...NOTHING };
    }

    const page = await this.client.fetchMentions(botId, {
      sinceId,
      startTime: sinceId ? undefined : primedAt,
      maxResults: size,
    });
    this.ledger.add(page.mentions.length * this.cfg.costReadUsd, nowMs);
    // Advance since_id before anything else, so a crash can never re-read.
    const newest = page.newestId ?? newestOf(page.mentions);
    if (newest) this.db.kvSet(KV.sinceId, newest);

    let queued = 0;
    let skipped = 0;
    const oldestFirst = [...page.mentions].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    for (const m of oldestFirst) {
      const c = classifyMention(m, { botUserId: botId, secretWords: this.cfg.secretWords });
      const created = m.createdAt ? Math.floor(Date.parse(m.createdAt) / 1000) : NaN;
      const inserted = this.db.insertXMention({
        now,
        mentionId: m.id,
        createdTs: Number.isFinite(created) ? created : null,
        authorId: m.authorId || "unknown",
        text: m.text.slice(0, 1000),
        status: c.action === "queue" ? "pending" : "skipped",
        reason: c.action === "skip" ? c.reason : undefined,
      });
      if (!inserted) {
        this.log.info(`mentions: ${m.id} already seen — ignored`);
        continue;
      }
      if (c.action === "queue") {
        queued++;
        this.log.info(`mentions: ${m.id} queued (author ${m.authorId}): ${quote(m.text)}`);
      } else {
        skipped++;
        this.log.info(`mentions: ${m.id} skipped [${c.reason}] (author ${m.authorId || "unknown"}): ${quote(m.text)}`);
      }
    }
    if (page.mentions.length >= size) {
      this.log.warn(`mentions: page full (${size}) — older unread mentions in this window were not fetched`);
    }
    this.log.info(
      `mentions: poll ok — ${page.mentions.length} new (${queued} queued, ${skipped} skipped)` +
        ` | pending ${this.db.pendingXMentionCount()} | spend ${this.ledger.summary(nowMs)}` +
        ` | next poll in ${this.cfg.pollSecs}s`
    );
    return { status: "ok", fetched: page.mentions.length, queued, skipped };
  }

  /** First run: remember where the timeline is now and answer nothing older. */
  private async prime(botId: string, nowMs: number): Promise<PollOutcome> {
    if (!this.ledger.canAfford(MIN_PAGE * this.cfg.costReadUsd, nowMs)) {
      this.log.info(`mentions: priming skipped — daily X spend cap reached (${this.ledger.summary(nowMs)})`);
      return { status: "skipped", reason: "spend_cap", ...NOTHING };
    }
    const page = await this.client.fetchMentions(botId, { maxResults: MIN_PAGE });
    this.ledger.add(page.mentions.length * this.cfg.costReadUsd, nowMs);
    const newest = page.newestId ?? newestOf(page.mentions);
    const at = isoSeconds(nowMs);
    this.db.kvSet(KV.primedAt, at);
    if (newest) this.db.kvSet(KV.sinceId, newest);
    this.log.info(
      (newest
        ? `mentions: primed since_id=${newest} — ${page.mentions.length} existing mention(s) ignored, nothing answered`
        : `mentions: primed with no existing mentions — watching from ${at}`) +
        ` | spend ${this.ledger.summary(nowMs)} | next poll in ${this.cfg.pollSecs}s`
    );
    return { status: "primed", fetched: page.mentions.length, queued: 0, skipped: 0 };
  }

  // ---- drain --------------------------------------------------------------

  async drainOnce(): Promise<DrainOutcome> {
    if (this.draining) return { decided: 0, replied: 0, waiting: "busy" };
    this.draining = true;
    try {
      return await this.drain();
    } catch (e) {
      this.log.error("mentions: drain failed", e);
      return { decided: 0, replied: 0 };
    } finally {
      this.draining = false;
    }
  }

  private async drain(): Promise<DrainOutcome> {
    let decided = 0;
    const startSecs = Math.floor(this.now() / 1000);
    const expired = this.db.expirePendingXMentions(startSecs - this.cfg.staleSecs, startSecs);
    if (expired > 0) this.log.info(`mentions: ${expired} queued mention(s) expired unanswered [stale]`);

    for (let i = 0; i < MAX_DECISIONS_PER_DRAIN; i++) {
      const row = this.db.nextPendingXMention();
      if (!row) break;
      const nowMs = this.now();
      const now = Math.floor(nowMs / 1000);

      // Never two replies close together, even in dry-run.
      const nextAt = Number(this.db.kvGet(KV.nextReplyAt) ?? "0") || 0;
      if (now < nextAt) return { decided, replied: 0, waiting: "min_gap" };

      const skip = (reason: string): void => {
        this.db.decideXMention(row.mention_id, { now, status: "skipped", reason });
        decided++;
        this.log.info(`mentions: ${row.mention_id} skipped [${reason}] (author ${row.author_id})`);
      };

      const dayStart = startOfDayLocalSecs(nowMs);
      if (this.db.xMentionRepliesSince(dayStart) >= this.cfg.maxPerDay) {
        skip("daily_limit");
        continue;
      }
      if (this.db.xMentionRepliesSince(dayStart, row.author_id) >= this.cfg.maxPerUserPerDay) {
        skip("user_limit");
        continue;
      }
      if (!this.ledger.canAfford(this.cfg.costReplyUsd, nowMs)) {
        skip("spend_cap");
        continue;
      }
      const clean = sanitizeMentionText(row.text);
      if (clean.length < 2) {
        skip("empty");
        continue;
      }

      const gen = await this.generate(clean);
      if (gen.kind === "unavailable") {
        this.log.warn(`mentions: ${row.mention_id} left queued — ${gen.reason}`);
        return { decided, replied: 0, waiting: "brain_unavailable" };
      }
      if (gen.kind === "rejected") {
        skip(`brain_rejected: ${gen.reason}`);
        continue;
      }
      // Final gate: Mouth re-shapes and re-checks whatever Brain returned.
      const text = shapeReply(gen.text);
      const guard = rejectReply(text, { secretWords: this.cfg.secretWords });
      if (!guard.ok) {
        skip(`guard: ${guard.reason}`);
        continue;
      }

      const gap = this.cfg.minGapSecs + Math.floor(this.rng() * (this.cfg.minGapSecs / 3));
      this.db.kvSet(KV.nextReplyAt, String(now + gap));

      if (this.cfg.dryRun) {
        this.db.decideXMention(row.mention_id, { now, status: "dry_run", replyText: text });
        this.ledger.addSimulated(this.cfg.costReplyUsd, nowMs);
        this.log.info(
          `mentions: DRY-RUN would reply to ${row.mention_id} (author ${row.author_id}): ${quote(text)}` +
            ` | spend ${this.ledger.summary(nowMs)}`
        );
        return { decided: decided + 1, replied: 1 };
      }

      let replyId: string | null = null;
      let failure = "post_failed";
      try {
        replyId = await this.client.reply(text, row.mention_id);
      } catch (e) {
        failure = this.noteApiError("reply", e);
      }
      if (!replyId) {
        this.db.decideXMention(row.mention_id, { now, status: "error", reason: failure, replyText: text });
        this.log.error(`mentions: ${row.mention_id} reply failed [${failure}] — not retried`);
        return { decided: decided + 1, replied: 0 };
      }
      this.db.decideXMention(row.mention_id, { now, status: "replied", replyText: text, replyId });
      this.ledger.add(this.cfg.costReplyUsd, nowMs);
      this.log.info(
        `mentions: replied to ${row.mention_id} (author ${row.author_id}) -> ${replyId}: ${quote(text)}` +
          ` | spend ${this.ledger.summary(nowMs)}`
      );
      return { decided: decided + 1, replied: 1 };
    }
    return { decided, replied: 0 };
  }
}
