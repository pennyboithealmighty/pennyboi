// Brain-written Telegram replies (TG_MENTION_REPLY_ENABLED). When someone @'s
// the bot, says "pennyboi" or replies to it in the group, the reply is written
// by pb-brain /reply instead of the canned REACTIONS.mention line. Same inbound
// sanitizer and outbound guard as the X replies. The bribe, sell and
// treasury-question reactions are not handled here and stay canned.
//
// Limits: one reply per user per TG_REPLY_USER_COOLDOWN_SECS and
// TG_REPLY_MAX_PER_DAY in total. Over a limit he stays silent. If the Brain is
// down, or its reply is rejected, the canned line is sent instead.

import {
  envBool,
  envNum,
  looksLikeInjection,
  mentionsSecret,
  rejectReply,
  sanitizeMentionText,
  secretWordsFromEnv,
  shapeReply,
} from "@pennyboi/shared";
import type { Logger } from "./log.js";
import { brainReplyGenerator, type GenerateReply } from "./mention-replier.js";
import type { Kv } from "./x-mentions.js";

export interface TgReplyConfig {
  enabled: boolean;
  userCooldownSecs: number;
  maxPerDay: number;
  secretWords: string[];
}

export function loadTgReplyConfig(): TgReplyConfig {
  return {
    enabled: envBool("TG_MENTION_REPLY_ENABLED", false),
    userCooldownSecs: envNum("TG_REPLY_USER_COOLDOWN_SECS", 600),
    maxPerDay: envNum("TG_REPLY_MAX_PER_DAY", 30),
    secretWords: secretWordsFromEnv(),
  };
}

export type ReplyGate = { ok: true } | { ok: false; reason: "user_cooldown" | "daily_limit" };

export type Composed =
  | { source: "brain"; text: string }
  | { source: "canned"; text: string; reason: string };

export interface TgReplierDeps {
  kv: Kv;
  log: Logger;
  cfg: TgReplyConfig;
  generate: GenerateReply;
  /** The fixed line used whenever the Brain cannot be trusted with this one. */
  canned: string;
  now?: () => number; // ms
}

function dayKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `tg_brain_replies:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export class TgReplier {
  private lastByUser = new Map<number, number>(); // user id -> ms of last reply
  private now: () => number;

  constructor(private deps: TgReplierDeps) {
    this.now = deps.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.deps.cfg.enabled;
  }

  repliesToday(nowMs = this.now()): number {
    return Number(this.deps.kv.kvGet(dayKey(nowMs)) ?? "0") || 0;
  }

  /** May this user get a reply right now? Checks only; nothing is recorded. */
  mayReply(userId: number, nowMs = this.now()): ReplyGate {
    if (this.repliesToday(nowMs) >= this.deps.cfg.maxPerDay) return { ok: false, reason: "daily_limit" };
    const last = this.lastByUser.get(userId);
    if (last !== undefined && nowMs - last < this.deps.cfg.userCooldownSecs * 1000) {
      return { ok: false, reason: "user_cooldown" };
    }
    return { ok: true };
  }

  /** Count a reply that was sent (Brain-written or canned). */
  record(userId: number, nowMs = this.now()): void {
    this.lastByUser.set(userId, nowMs);
    this.deps.kv.kvSet(dayKey(nowMs), String(this.repliesToday(nowMs) + 1));
    // Keep the map small: forget users whose cooldown has long passed.
    if (this.lastByUser.size > 2000) {
      const cutoff = nowMs - this.deps.cfg.userCooldownSecs * 1000;
      for (const [id, ts] of this.lastByUser) if (ts < cutoff) this.lastByUser.delete(id);
    }
  }

  private canned(reason: string): Composed {
    this.deps.log.info(`tg reply: canned line [${reason}]`);
    return { source: "canned", text: this.deps.canned, reason };
  }

  /** The reply to send for this message. Never throws; never returns unvetted text. */
  async compose(rawText: string): Promise<Composed> {
    // A message that tries to command him, or names the secret word, never
    // reaches the Brain: it gets the fixed line, which confirms nothing.
    if (looksLikeInjection(rawText)) return this.canned("injection");
    if (mentionsSecret(rawText, this.deps.cfg.secretWords)) return this.canned("secret_word");
    const clean = sanitizeMentionText(rawText);
    if (clean.length < 2) return this.canned("empty");

    let gen;
    try {
      gen = await this.deps.generate(clean);
    } catch (e) {
      return this.canned(`brain_error: ${(e as Error).message}`);
    }
    if (gen.kind === "unavailable") return this.canned(`brain_unavailable: ${gen.reason}`);
    if (gen.kind === "rejected") return this.canned(`brain_rejected: ${gen.reason}`);

    // Final gate: Mouth re-shapes and re-checks whatever the Brain returned.
    const text = shapeReply(gen.text);
    const guard = rejectReply(text, { secretWords: this.deps.cfg.secretWords });
    if (!guard.ok) return this.canned(`guard: ${guard.reason}`);
    this.deps.log.info(`tg reply: brain wrote ${JSON.stringify(text)}`);
    return { source: "brain", text };
  }
}

let shared: TgReplier | null = null;

/** The process-wide replier, built on first use from env. */
export function tgReplier(m: { db: Kv; log: Logger }, canned: string): TgReplier {
  if (!shared) {
    const cfg = loadTgReplyConfig();
    shared = new TgReplier({ kv: m.db, log: m.log, cfg, generate: brainReplyGenerator("telegram"), canned });
    m.log.info(
      cfg.enabled
        ? `tg replies: ON — Brain-written | 1 per user per ${cfg.userCooldownSecs}s, ${cfg.maxPerDay}/day`
        : "tg replies: OFF (TG_MENTION_REPLY_ENABLED is not true) — canned line"
    );
  }
  return shared;
}
