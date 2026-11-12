// Welcome clip (TG_WELCOME_CLIP_ENABLED). A new member is greeted with the
// fixed WELCOME template (not Brain-written text) carrying their sanitized
// first name, sent as the caption of assets/telegram/pennyboi-welcome.mp4.
//
//   - The name is the display name only, run through welcome-names.ts. A
//     suspicious name (link, handle, authority word, instruction, secret word)
//     is dropped and the member is greeted without one. The username is never
//     used in its place.
//   - Raid protection: everyone who joins within TG_WELCOME_CLIP_BATCH_SECS
//     shares ONE clip, and at most TG_WELCOME_CLIP_MAX_PER_HOUR clips go out
//     per hour. Past the cap, the same welcome is sent as plain text.
//   - If the video cannot be sent, the text welcome is sent instead.
//
// When the flag is off nothing here is registered, so the existing welcome in
// moderation.ts runs exactly as before. When it is on, this handler records
// the join the same way (seenMember), so the new-member link warning and the
// scam protections behave identically.

import { envBool, envNum, resolveFromRoot, secretWordsFromEnv } from "@pennyboi/shared";
import { existsSync } from "node:fs";
import { sendSafe } from "./announce.js";
import { sendClip } from "./decree-clips.js";
import type { MouthCtx } from "./deps.js";
import type { Logger } from "./log.js";
import * as P from "./personality.js";
import { stripDisallowedUrls } from "./sanitize.js";
import { joinNames, safeDisplayName } from "./welcome-names.js";
import type { Kv } from "./x-mentions.js";

export const WELCOME_CLIP_FILE = "assets/telegram/pennyboi-welcome.mp4";
/** Key under which Telegram's file id for the clip is cached (tg_clip_file_id:welcome). */
export const WELCOME_CLIP_KEY = "welcome";
/** How many names a combined welcome lists before "and N others". */
export const NAMES_SHOWN = 10;

export interface WelcomeClipConfig {
  enabled: boolean;
  maxPerHour: number;
  batchSecs: number;
  secretWords: string[];
}

export function loadWelcomeClipConfig(): WelcomeClipConfig {
  return {
    enabled: envBool("TG_WELCOME_CLIP_ENABLED", false),
    maxPerHour: envNum("TG_WELCOME_CLIP_MAX_PER_HOUR", 20),
    batchSecs: Math.max(0, envNum("TG_WELCOME_CLIP_BATCH_SECS", 60)),
    secretWords: secretWordsFromEnv(),
  };
}

/** Absolute path of the welcome clip, or null if it is not on disk. */
export function welcomeClipPath(): string | null {
  const path = resolveFromRoot(WELCOME_CLIP_FILE);
  return existsSync(path) ? path : null;
}

/**
 * The fixed welcome for one or more new members. Only display names are
 * considered; each is sanitized, and a dropped name is not replaced by
 * anything. Nobody named -> "Mortal" / "Mortals".
 */
export function welcomeTextFor(
  firstNames: Array<string | undefined>,
  fixed: (name: string) => string,
  secretWords: string[] = []
): string {
  const count = firstNames.length;
  const names = firstNames.map((n) => safeDisplayName(n, secretWords)).filter((n): n is string => n !== null);
  return fixed(joinNames(names, count, NAMES_SHOWN) ?? (count === 1 ? "Mortal" : "Mortals"));
}

export type WelcomeSent =
  | { via: "clip"; text: string; count: number }
  | { via: "text"; text: string; count: number; reason: "hourly_cap" | "clip_failed" };

export interface WelcomeClipDeps {
  kv: Kv;
  log: Logger;
  cfg: WelcomeClipConfig;
  /** Send the clip with this caption; false means it could not be sent. */
  sendClip: (caption: string) => Promise<boolean>;
  /** Send the plain text welcome, as it works today. */
  sendText: (text: string) => Promise<void>;
  /** The existing fixed template. */
  fixed: (name: string) => string;
  now?: () => number; // ms
  /** Injectable for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
}

function hourKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `tg_welcome_clips:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${d.getHours()}`;
}

export class WelcomeClipBatcher {
  private queue: Array<string | undefined> = [];
  private timerSet = false;
  private now: () => number;
  private schedule: (fn: () => void, ms: number) => void;

  constructor(private deps: WelcomeClipDeps) {
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  clipsThisHour(nowMs = this.now()): number {
    return Number(this.deps.kv.kvGet(hourKey(nowMs)) ?? "0") || 0;
  }

  /** Queue a new member by display name. The first one in a window starts the timer. */
  add(firstName: string | undefined): void {
    this.queue.push(firstName);
    if (this.timerSet) return;
    this.timerSet = true;
    this.schedule(() => void this.flush(), this.deps.cfg.batchSecs * 1000);
  }

  /** Welcome everyone queued so far with ONE message. Never throws. */
  async flush(): Promise<WelcomeSent | null> {
    this.timerSet = false;
    const batch = this.queue.splice(0);
    if (batch.length === 0) return null;
    const count = batch.length;
    const text = welcomeTextFor(batch, this.deps.fixed, this.deps.cfg.secretWords);
    try {
      const nowMs = this.now();
      if (this.clipsThisHour(nowMs) >= this.deps.cfg.maxPerHour) {
        await this.deps.sendText(text);
        this.deps.log.info(`welcome clip: text only for ${count} member(s) [hourly_cap]`);
        return { via: "text", text, count, reason: "hourly_cap" };
      }
      let sent = false;
      try {
        sent = await this.deps.sendClip(text);
      } catch (e) {
        this.deps.log.warn("welcome clip: sending the clip threw", e);
      }
      if (!sent) {
        await this.deps.sendText(text);
        this.deps.log.info(`welcome clip: text only for ${count} member(s) [clip_failed]`);
        return { via: "text", text, count, reason: "clip_failed" };
      }
      this.deps.kv.kvSet(hourKey(nowMs), String(this.clipsThisHour(nowMs) + 1));
      this.deps.log.info(`welcome clip: sent one clip for ${count} member(s)`);
      return { via: "clip", text, count };
    } catch (e) {
      this.deps.log.error("welcome clip: failed to welcome", e);
      return null;
    }
  }
}

/**
 * Register the welcome-clip handler. Must run BEFORE registerModeration (and
 * before registerUniqueWelcome) so it takes the join event first. Does nothing
 * at all when the flag is off.
 */
export function registerWelcomeClip(m: MouthCtx): void {
  const cfg = loadWelcomeClipConfig();
  if (!cfg.enabled) {
    m.log.info("welcome clip: OFF (TG_WELCOME_CLIP_ENABLED is not true)");
    return;
  }
  m.log.info(
    `welcome clip: ON — fixed welcome with the member's name as the clip caption | one per ${cfg.batchSecs}s batch, at most ${cfg.maxPerHour} clips per hour`
  );
  if (!welcomeClipPath()) m.log.warn(`welcome clip: ${WELCOME_CLIP_FILE} is missing — welcomes will be text only`);
  if (envBool("TG_UNIQUE_WELCOME_ENABLED", false)) {
    m.log.warn("welcome clip: TG_UNIQUE_WELCOME_ENABLED is also on — the clip welcome takes the join event; Brain-written welcomes will not be sent");
  }

  const batcher = new WelcomeClipBatcher({
    kv: m.db,
    log: m.log,
    cfg,
    // Same outbound link filter as every other group message.
    sendClip: (caption) =>
      sendClip(
        { api: m.bot.api, kv: m.db, log: m.log, pathFor: () => welcomeClipPath() },
        { chatId: m.cfg.chatId, threadId: m.cfg.topics.general },
        WELCOME_CLIP_KEY,
        stripDisallowedUrls(caption, m.cfg.allowedHosts)
      ),
    sendText: (text) => sendSafe(m, text, { threadId: m.cfg.topics.general }),
    fixed: P.WELCOME,
  });

  // Same bookkeeping as the fixed welcome in moderation.ts (no DM, bots
  // ignored, join time recorded for the new-member link protection). Not
  // calling next() keeps that handler from sending a second welcome.
  m.bot.on("message:new_chat_members", (c) => {
    if (c.chat.id !== m.cfg.chatId) return;
    const now = Math.floor(Date.now() / 1000);
    for (const u of c.message.new_chat_members) {
      if (u.is_bot) continue;
      m.db.seenMember(u.id, now);
      batcher.add(u.first_name); // display name only; the username is never used
    }
  });
}
