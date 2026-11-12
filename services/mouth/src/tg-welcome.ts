// Unique welcomes (TG_UNIQUE_WELCOME_ENABLED). When a new member joins, the
// welcome is written by pb-brain /welcome instead of the fixed WELCOME
// template. Members who join within TG_WELCOME_BATCH_SECS of each other get one
// combined welcome. Names are untrusted: a suspicious name is simply left out.
// The same outbound guard as the replies has the final say.
//
// The fixed template is sent instead when the Brain is down or rejected twice,
// when the guard refuses the text, or when TG_WELCOME_MAX_PER_HOUR generated
// welcomes have already gone out this hour.
//
// When the flag is off nothing here is registered, so the existing welcome in
// moderation.ts runs exactly as before. When it is on, this handler records
// the join the same way (seenMember), so the new-member link warning and the
// scam protections behave identically.

import { envBool, envNum, envStr, pickMood, rejectReply, secretWordsFromEnv, shapeReply } from "@pennyboi/shared";
import { sendSafe } from "./announce.js";
import type { MouthCtx } from "./deps.js";
import type { Logger } from "./log.js";
import * as P from "./personality.js";
import { joinNames, safeMemberName } from "./welcome-names.js";
import type { Kv } from "./x-mentions.js";

export interface WelcomeConfig {
  enabled: boolean;
  maxPerHour: number;
  batchSecs: number;
  secretWords: string[];
}

export function loadWelcomeConfig(): WelcomeConfig {
  return {
    enabled: envBool("TG_UNIQUE_WELCOME_ENABLED", false),
    maxPerHour: envNum("TG_WELCOME_MAX_PER_HOUR", 20),
    batchSecs: Math.max(0, envNum("TG_WELCOME_BATCH_SECS", 60)),
    secretWords: secretWordsFromEnv(),
  };
}

/** Fixed, trusted pointer appended after a generated welcome has passed the guard. */
export const WELCOME_TAIL = "Read #scripture.";
const NAMES_TO_BRAIN = 3;

export type GeneratedWelcome =
  | { kind: "welcome"; text: string }
  | { kind: "rejected"; reason: string }
  | { kind: "unavailable"; reason: string };
export type GenerateWelcome = (input: { names: string[]; count: number }) => Promise<GeneratedWelcome>;

/** Ask Brain /welcome for an in-character greeting for already vetted names. */
export function brainWelcomeGenerator(): GenerateWelcome {
  return async ({ names, count }) => {
    const url = `${new URL(envStr("BRAIN_URL", "http://127.0.0.1:8788/decide")).origin}/welcome`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ names, count, mood: pickMood() }),
      });
    } catch (e) {
      return { kind: "unavailable", reason: `Brain unreachable: ${(e as Error).message}` };
    }
    if (!res.ok) return { kind: "unavailable", reason: `Brain /welcome returned HTTP ${res.status}` };
    const data = (await res.json().catch(() => null)) as { welcome?: string | null; reason?: string } | null;
    if (data?.welcome) return { kind: "welcome", text: data.welcome };
    return { kind: "rejected", reason: data?.reason ?? "no welcome" };
  };
}

export interface JoinedMember {
  firstName?: string;
  username?: string;
}

export type Welcomed =
  | { source: "brain"; text: string; count: number }
  | { source: "fixed"; text: string; count: number; reason: string };

export interface WelcomeDeps {
  kv: Kv;
  log: Logger;
  cfg: WelcomeConfig;
  generate: GenerateWelcome;
  send: (text: string) => Promise<void>;
  /** The existing fixed template. */
  fixed: (name: string) => string;
  now?: () => number; // ms
  /** Injectable for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
}

function hourKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `tg_welcomes:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${d.getHours()}`;
}

export class WelcomeBatcher {
  private queue: JoinedMember[] = [];
  private timerSet = false;
  private now: () => number;
  private schedule: (fn: () => void, ms: number) => void;

  constructor(private deps: WelcomeDeps) {
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  generatedThisHour(nowMs = this.now()): number {
    return Number(this.deps.kv.kvGet(hourKey(nowMs)) ?? "0") || 0;
  }

  /** Queue a new member. The first one in a window starts the batch timer. */
  add(member: JoinedMember): void {
    this.queue.push(member);
    if (this.timerSet) return;
    this.timerSet = true;
    this.schedule(() => void this.flush(), this.deps.cfg.batchSecs * 1000);
  }

  /** Welcome everyone queued so far with one message. Never throws. */
  async flush(): Promise<Welcomed | null> {
    this.timerSet = false;
    const batch = this.queue.splice(0);
    if (batch.length === 0) return null;
    try {
      const out = await this.compose(batch);
      await this.deps.send(out.text);
      this.deps.log.info(
        out.source === "brain"
          ? `welcome: brain wrote one for ${out.count} member(s): ${JSON.stringify(out.text)}`
          : `welcome: fixed template for ${out.count} member(s) [${out.reason}]`
      );
      return out;
    } catch (e) {
      this.deps.log.error("welcome: failed to send", e);
      return null;
    }
  }

  private async compose(batch: JoinedMember[]): Promise<Welcomed> {
    const count = batch.length;
    // Suspicious names are dropped; the member is still counted and greeted.
    const names = [
      ...new Set(
        batch.map((b) => safeMemberName(b, this.deps.cfg.secretWords)).filter((n): n is string => n !== null)
      ),
    ];
    const fixed = (reason: string): Welcomed => ({
      source: "fixed",
      count,
      reason,
      text: this.deps.fixed(joinNames(names, count) ?? (count === 1 ? "Mortal" : "Mortals")),
    });

    const nowMs = this.now();
    if (this.generatedThisHour(nowMs) >= this.deps.cfg.maxPerHour) return fixed("hourly_cap");
    this.deps.kv.kvSet(hourKey(nowMs), String(this.generatedThisHour(nowMs) + 1));

    let gen: GeneratedWelcome;
    try {
      gen = await this.deps.generate({ names: names.slice(0, NAMES_TO_BRAIN), count });
    } catch (e) {
      return fixed(`brain_error: ${(e as Error).message}`);
    }
    if (gen.kind === "unavailable") return fixed(`brain_unavailable: ${gen.reason}`);
    if (gen.kind === "rejected") return fixed(`brain_rejected: ${gen.reason}`);

    // Final gate: Mouth re-shapes and re-checks whatever the Brain returned.
    const text = shapeReply(gen.text);
    const guard = rejectReply(text, { secretWords: this.deps.cfg.secretWords });
    if (!guard.ok) return fixed(`guard: ${guard.reason}`);
    return { source: "brain", count, text: `${text} ${WELCOME_TAIL}` };
  }
}

/**
 * Register the unique-welcome handler. Must run BEFORE registerModeration so it
 * takes the join event first. Does nothing at all when the flag is off.
 */
export function registerUniqueWelcome(m: MouthCtx): void {
  const cfg = loadWelcomeConfig();
  if (!cfg.enabled) {
    m.log.info("welcomes: fixed template (TG_UNIQUE_WELCOME_ENABLED is not true)");
    return;
  }
  m.log.info(
    `welcomes: ON — Brain-written | one per ${cfg.batchSecs}s batch, at most ${cfg.maxPerHour} generated per hour`
  );
  const batcher = new WelcomeBatcher({
    kv: m.db,
    log: m.log,
    cfg,
    generate: brainWelcomeGenerator(),
    send: (text) => sendSafe(m, text, { threadId: m.cfg.topics.general }),
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
      batcher.add({ firstName: u.first_name, username: u.username });
    }
  });
}
