// The Gate of the Almighty (TG_GATE_ENABLED). The group is set to approve new
// members; each join request gets a private trial from Pennyboi: a 2x2 grid
// with his true coin among three decoys, and buttons 1-4. Pass and the request
// is approved; fail twice or stay silent and it is declined, with a cooldown.
//
// Telegram's rules this is built around:
//   - A bot may message the requester (join request's user_chat_id) for only
//     5 MINUTES, and only until the request is processed. So every verdict DM
//     is sent BEFORE the request is approved or declined, and the whole trial
//     ends well inside that window.
//   - Receiving, approving and declining join requests all need the bot to be
//     an admin with the "invite users" right.
//
// Flood safety: every DM goes through ONE paced queue (GATE_DM_INTERVAL_MS
// apart), at most GATE_MAX_ACTIVE trials run at once, and requests beyond that
// are declined without a DM, through the same paced queue. A 429 from Telegram
// pauses the queue for as long as Telegram says.
//
// State lives in the gate_trials table, written before every outward step, so
// a restart finishes what it was doing and never approves anyone unproven.
//
// Nothing here touches moderation or the welcome: once a request is approved
// Telegram posts the join as usual and those handlers run exactly as today.

import { envBool, envNum, resolveFromRoot, type GateTrialRow } from "@pennyboi/shared";
import { InlineKeyboard, InputFile } from "grammy";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MouthCtx } from "./deps.js";
import type { Logger } from "./log.js";
import { safeDisplayName } from "./welcome-names.js";
import type { Kv } from "./x-mentions.js";

// ---- Telegram's window, and how much of it a trial may use -----------------
/** Bot API: user_chat_id is usable for 5 minutes after the join request. */
export const DM_WINDOW_SECS = 300;
/** The last DM of a trial must be on its way this long before the window shuts. */
export const WINDOW_MARGIN_SECS = 20;
/** A trial must end this long before the last-DM moment, so the verdict fits. */
const VERDICT_ROOM_SECS = 10;
/** Too little time left to answer fairly: do not start a trial. */
export const MIN_TRIAL_SECS = 45;

export const GRID_DIR = "assets/telegram/gate";

export interface GateConfig {
  enabled: boolean;
  timeoutSecs: number;
  cooldownSecs: number;
  dmIntervalMs: number;
  maxActive: number;
}

export function loadGateConfig(): GateConfig {
  return {
    enabled: envBool("TG_GATE_ENABLED", false),
    timeoutSecs: Math.max(30, envNum("GATE_TIMEOUT_SECS", 180)),
    cooldownSecs: Math.max(0, envNum("GATE_COOLDOWN_SECS", 1800)),
    dmIntervalMs: Math.max(250, envNum("GATE_DM_INTERVAL_MS", 1100)),
    maxActive: Math.max(1, envNum("GATE_MAX_ACTIVE", 20)),
  };
}

// ---- What he says (fixed; no Brain call) ------------------------------------
const mins = (secs: number): string => {
  const m = Math.max(1, Math.ceil(secs / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
};
export const GATE_TEXT = {
  trial:
    "Mortal, only the worthy may enter my temple. Which is my true coin? Press its number.\n\n(I ask for nothing else: no wallet, no key, no payment. Ever.)",
  retry: "Wrong. A god grants one more chance. Which is my true coin?",
  second: "Good. Now prove it was not luck. Which is my true coin?",
  approved: "You chose well. The gate opens. Enter, mortal.",
  wrong: (secs: number) => `Wrong again. The gate stays shut. Return in ${mins(secs)}, if you dare.`,
  timeout: (secs: number) => `You kept a god waiting. The gate stays shut. Return in ${mins(secs)}.`,
  cooldown: (secs: number) => `Not yet, mortal. The gate opens to you again in ${mins(secs)}.`,
} as const;

/** Button toasts. */
const TOAST = {
  ended: "This trial has ended.",
  notYours: "This trial is not yours.",
  late: "Too late, mortal.",
  open: "The gate opens.",
  more: "Good. One more.",
  again: "Wrong. One more chance.",
  shut: "Wrong. The gate stays shut.",
} as const;

// ---- Grids -------------------------------------------------------------------
export interface Grid {
  file: string;
  answer: number; // 1..4
}

export function loadGrids(): Grid[] {
  const path = resolveFromRoot(join(GRID_DIR, "manifest.json"));
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { grids?: Array<{ file?: unknown; answer?: unknown }> };
    return (raw.grids ?? []).filter(
      (g): g is Grid =>
        typeof g.file === "string" &&
        typeof g.answer === "number" &&
        g.answer >= 1 &&
        g.answer <= 4 &&
        existsSync(resolveFromRoot(join(GRID_DIR, g.file)))
    );
  } catch {
    return [];
  }
}

/** Buttons 1-4 only, laid out like the grid. The answer is only in the image. */
export function gateKeyboard(token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("1", `gate:${token}:1`)
    .text("2", `gate:${token}:2`)
    .row()
    .text("3", `gate:${token}:3`)
    .text("4", `gate:${token}:4`);
}

// ---- The one paced queue every outbound gate call goes through ---------------
export interface QueueJob {
  label: string;
  /** Past this moment (ms) the job is not sent at all. */
  expiresAtMs: number;
  send: () => Promise<void>;
  /** Called once: ok=true if it was sent. */
  done?: (ok: boolean, err?: unknown) => void | Promise<void>;
}

type Schedule = (fn: () => unknown, ms: number) => void;

/** Seconds Telegram asked us to wait, if this is a flood-limit error. */
export function retryAfterSecs(e: unknown): number | null {
  const err = e as { error_code?: number; parameters?: { retry_after?: number } } | null;
  if (typeof err?.parameters?.retry_after === "number") return err.parameters.retry_after;
  return err?.error_code === 429 ? 5 : null;
}

export class PacedQueue {
  private jobs: QueueJob[] = [];
  private pumping = false;
  private lastSendMs = -Infinity;
  private pausedUntilMs = 0;

  constructor(
    private intervalMs: number,
    private now: () => number,
    private schedule: Schedule,
    private log: Logger
  ) {}

  get length(): number {
    return this.jobs.length;
  }

  push(job: QueueJob, front = false): void {
    if (front) this.jobs.unshift(job);
    else this.jobs.push(job);
    if (this.pumping) return;
    this.pumping = true;
    this.schedule(() => this.pump(), this.delay());
  }

  private delay(): number {
    const now = this.now();
    return Math.max(0, this.lastSendMs + this.intervalMs - now, this.pausedUntilMs - now);
  }

  private async pump(): Promise<void> {
    const job = this.jobs.shift();
    if (!job) {
      this.pumping = false;
      return;
    }
    if (this.now() > job.expiresAtMs) {
      // Not sent, so it does not use up a send slot.
      await this.finish(job, false, new Error("too late to send"));
    } else {
      try {
        await job.send();
        this.lastSendMs = this.now();
        await this.finish(job, true);
      } catch (e) {
        const wait = retryAfterSecs(e);
        if (wait !== null) {
          this.pausedUntilMs = this.now() + wait * 1000;
          this.jobs.unshift(job); // try again once Telegram allows
          this.log.warn(`gate: Telegram flood limit — pausing all gate messages for ${wait}s`);
        } else {
          this.lastSendMs = this.now();
          await this.finish(job, false, e);
        }
      }
    }
    if (this.jobs.length > 0) this.schedule(() => this.pump(), this.delay());
    else this.pumping = false;
  }

  private async finish(job: QueueJob, ok: boolean, err?: unknown): Promise<void> {
    try {
      await job.done?.(ok, err);
    } catch (e) {
      this.log.error(`gate: follow-up for "${job.label}" failed`, e);
    }
  }
}

// ---- The gate ---------------------------------------------------------------
export interface GateApi {
  sendPhoto(
    chatId: number,
    photo: InputFile | string,
    other: { caption: string; reply_markup: InlineKeyboard }
  ): Promise<{ message_id: number; photo?: Array<{ file_id: string }> }>;
  sendMessage(chatId: number, text: string): Promise<unknown>;
  approveChatJoinRequest(chatId: number, userId: number): Promise<unknown>;
  declineChatJoinRequest(chatId: number, userId: number): Promise<unknown>;
  getUserProfilePhotos(userId: number, other: { limit: number }): Promise<{ total_count: number }>;
}

export interface GateStore {
  getGateTrial(userId: number): GateTrialRow | null;
  saveGateTrial(t: GateTrialRow): void;
  openGateTrials(): GateTrialRow[];
  gateTrialByToken(token: string): GateTrialRow | null;
}

export interface JoinRequest {
  chatId: number;
  userId: number;
  userChatId: number;
  date: number; // unix secs
  firstName?: string;
  username?: string;
}

export interface GateDeps {
  api: GateApi;
  store: GateStore;
  kv: Kv;
  log: Logger;
  cfg: GateConfig;
  chatId: number;
  /** Owner and moderators: never tested. */
  isTrusted: (userId: number) => boolean;
  grids: Grid[];
  now?: () => number; // ms
  schedule?: Schedule;
  rng?: () => number;
  newToken?: () => string;
  /** Injectable for tests. */
  photoFor?: (grid: Grid) => InputFile | string;
}

export type RequestOutcome = "ignored" | "trusted" | "cooldown" | "busy" | "stale" | "queued" | "no_grids";

const FINAL_REQUEST_ERRORS = /USER_ALREADY_PARTICIPANT|HIDE_REQUESTER_MISSING|not found|PARTICIPANT/i;
const fileIdKey = (file: string): string => `tg_gate_file_id:${file}`;

export class Gate {
  private api: GateApi;
  private store: GateStore;
  private log: Logger;
  private cfg: GateConfig;
  private now: () => number;
  private schedule: Schedule;
  private rng: () => number;
  private newToken: () => string;
  readonly queue: PacedQueue;

  constructor(private deps: GateDeps) {
    this.api = deps.api;
    this.store = deps.store;
    this.log = deps.log;
    this.cfg = deps.cfg;
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.rng = deps.rng ?? Math.random;
    this.newToken = deps.newToken ?? (() => randomBytes(8).toString("hex"));
    this.queue = new PacedQueue(deps.cfg.dmIntervalMs, this.now, this.schedule, deps.log);
  }

  private secs(): number {
    return Math.floor(this.now() / 1000);
  }
  /** The last moment (unix secs) a DM for this request may still be sent. */
  private lastDmAt(t: { requested_ts: number }): number {
    return t.requested_ts + DM_WINDOW_SECS - WINDOW_MARGIN_SECS;
  }
  /** Trials in progress (waiting to be sent, or waiting for an answer). */
  private activeTrials(): number {
    return this.store.openGateTrials().filter((t) => t.status === "queued" || t.status === "pending").length;
  }
  private who(t: GateTrialRow): string {
    return `user ${t.user_id}${t.name ? ` (${t.name})` : ""}`;
  }

  // ---- a join request arrives ---------------------------------------------

  async onJoinRequest(req: JoinRequest): Promise<RequestOutcome> {
    if (req.chatId !== this.deps.chatId) return "ignored";
    const now = this.secs();

    if (this.deps.isTrusted(req.userId)) {
      await this.api
        .approveChatJoinRequest(req.chatId, req.userId)
        .catch((e) => this.log.error(`gate: could not approve trusted user ${req.userId}`, e));
      this.log.info(`gate: user ${req.userId} is the owner or a moderator — approved without a trial`);
      return "trusted";
    }

    const prev = this.store.getGateTrial(req.userId);
    const base: GateTrialRow = {
      user_id: req.userId,
      user_chat_id: req.userChatId,
      chat_id: req.chatId,
      name: safeDisplayName(req.firstName),
      requested_ts: req.date,
      deadline_ts: req.date + DM_WINDOW_SECS - WINDOW_MARGIN_SECS - VERDICT_ROOM_SECS,
      status: "queued",
      reason: null,
      needed: 1,
      correct: 0,
      wrong: 0,
      answer: null,
      grid: null,
      token: null,
      message_id: null,
      cooldown_until: prev?.cooldown_until ?? 0,
      decided_ts: null,
      attempts: prev?.attempts ?? 0,
    };

    // Cancelling the request and asking again mid-trial does not buy a fresh
    // set of chances: a wrong answer already given still counts.
    if (prev && (prev.status === "queued" || prev.status === "pending")) base.wrong = Math.min(prev.wrong, 1);

    if (base.cooldown_until > now) {
      this.log.info(`gate: ${this.who(base)} asked again during the cooldown — declining`);
      this.decline(base, "cooldown", { dm: true, cooldown: false });
      return "cooldown";
    }

    // A wave of requests: beyond the cap nobody is messaged at all. They are
    // declined through the paced queue and may simply ask again later.
    if (this.activeTrials() >= this.cfg.maxActive) {
      this.log.warn(`gate: ${this.who(base)} declined without a trial — ${this.cfg.maxActive} trials already running`);
      this.decline(base, "busy", { dm: false, cooldown: false });
      return "busy";
    }

    if (this.deps.grids.length === 0) {
      this.log.error("gate: no trial images found — the request is left for an admin to decide");
      return "no_grids";
    }

    // A request we only learned of late (the bot was down): the window to
    // message them is nearly shut, so there can be no fair trial.
    if (this.lastDmAt(base) - VERDICT_ROOM_SECS - now < MIN_TRIAL_SECS) {
      this.log.warn(`gate: ${this.who(base)} declined without a trial — the request is too old to message`);
      this.decline(base, "stale_request", { dm: false, cooldown: false });
      return "stale";
    }

    base.needed = await this.roundsNeeded(req);
    base.attempts += 1;
    this.store.saveGateTrial(base);
    this.log.info(
      `gate: ${this.who(base)} asked to join — trial queued (${base.needed} correct round${base.needed === 1 ? "" : "s"} needed)`
    );
    this.sendRound(base.user_id, "trial");
    return "queued";
  }

  /** Two rounds for an account with neither a username nor a profile photo. */
  private async roundsNeeded(req: JoinRequest): Promise<number> {
    if (req.username) return 1;
    try {
      const photos = await this.api.getUserProfilePhotos(req.userId, { limit: 1 });
      return photos.total_count > 0 ? 1 : 2;
    } catch {
      return 2; // cannot tell, and there is no username: be strict
    }
  }

  // ---- rounds ---------------------------------------------------------------

  private pickGrid(not: string | null): Grid {
    const pool = this.deps.grids.filter((g) => g.file !== not);
    const from = pool.length > 0 ? pool : this.deps.grids;
    return from[Math.floor(this.rng() * from.length) % from.length]!;
  }

  private photo(grid: Grid): InputFile | string {
    if (this.deps.photoFor) return this.deps.photoFor(grid);
    return this.deps.kv.kvGet(fileIdKey(grid.file)) || new InputFile(resolveFromRoot(join(GRID_DIR, grid.file)));
  }

  /** Queue a fresh, newly randomized grid for this user. */
  private sendRound(userId: number, kind: "trial" | "retry" | "second"): void {
    const first = this.store.getGateTrial(userId);
    if (!first) return;
    this.queue.push({
      label: `${kind} to ${userId}`,
      expiresAtMs: (this.lastDmAt(first) - VERDICT_ROOM_SECS) * 1000,
      send: async () => {
        const t = this.store.getGateTrial(userId);
        if (!t || (t.status !== "queued" && t.status !== "pending")) return; // already settled
        const now = this.secs();
        if (t.status === "queued" && this.lastDmAt(t) - VERDICT_ROOM_SECS - now < MIN_TRIAL_SECS) {
          throw new Error("too little of Telegram's 5-minute window is left for a fair trial");
        }
        const grid = this.pickGrid(t.grid);
        const token = this.newToken();
        const msg = await this.api.sendPhoto(t.user_chat_id, this.photo(grid), {
          caption: GATE_TEXT[kind],
          reply_markup: gateKeyboard(token),
        });
        const fileId = msg.photo?.[msg.photo.length - 1]?.file_id;
        if (fileId) this.deps.kv.kvSet(fileIdKey(grid.file), fileId);

        const wasQueued = t.status === "queued";
        t.status = "pending";
        t.answer = grid.answer;
        t.grid = grid.file;
        t.token = token;
        t.message_id = msg.message_id;
        if (wasQueued) {
          // The clock starts when the trial is actually delivered.
          t.deadline_ts = Math.min(now + this.cfg.timeoutSecs, this.lastDmAt(t) - VERDICT_ROOM_SECS);
          this.schedule(() => this.expire(userId), (t.deadline_ts - now) * 1000 + 250);
        }
        this.store.saveGateTrial(t);
        this.log.info(`gate: ${kind} sent to ${this.who(t)} — answer by ${new Date(t.deadline_ts * 1000).toISOString()}`);
      },
      done: (ok, err) => {
        if (ok) return;
        const t = this.store.getGateTrial(userId);
        if (!t || (t.status !== "queued" && t.status !== "pending")) return;
        // Could not reach them (blocked, or the window shut): no trial, no penalty.
        this.log.warn(`gate: could not send the ${kind} to ${this.who(t)} — declining`, err);
        this.decline(t, "dm_failed", { dm: false, cooldown: false });
      },
    });
  }

  // ---- a button is pressed --------------------------------------------------

  /** Returns the short text shown to the person who pressed. */
  async onButton(press: { fromId: number; data: string }): Promise<string> {
    const m = /^gate:([0-9a-f]+):([1-4])$/.exec(press.data);
    if (!m) return TOAST.ended;
    const t = this.store.gateTrialByToken(m[1]!);
    if (!t) return TOAST.ended; // an old grid, or a settled trial
    if (t.user_id !== press.fromId) return TOAST.notYours; // only the person it was sent to
    if (t.status !== "pending") return TOAST.ended;
    if (this.secs() >= t.deadline_ts) {
      await this.expire(t.user_id);
      return TOAST.late;
    }

    t.token = null; // this grid is spent, whatever the answer
    if (Number(m[2]) === t.answer) {
      t.correct += 1;
      if (t.correct >= t.needed) {
        this.approve(t);
        return TOAST.open;
      }
      this.store.saveGateTrial(t);
      this.log.info(`gate: ${this.who(t)} answered correctly (${t.correct}/${t.needed}) — second round`);
      this.sendRound(t.user_id, "second");
      return TOAST.more;
    }
    t.wrong += 1;
    if (t.wrong >= 2) {
      this.log.info(`gate: ${this.who(t)} was wrong twice`);
      this.decline(t, "wrong", { dm: true, cooldown: true });
      return TOAST.shut;
    }
    this.store.saveGateTrial(t);
    this.log.info(`gate: ${this.who(t)} was wrong — one retry with a new grid`);
    this.sendRound(t.user_id, "retry");
    return TOAST.again;
  }

  private async expire(userId: number): Promise<void> {
    const t = this.store.getGateTrial(userId);
    if (!t || (t.status !== "queued" && t.status !== "pending")) return;
    if (this.secs() < t.deadline_ts) return;
    this.log.info(`gate: ${this.who(t)} did not answer in time`);
    this.decline(t, "timeout", { dm: true, cooldown: true });
  }

  // ---- verdicts: state first, then the DM, then Telegram ---------------------

  private approve(t: GateTrialRow): void {
    t.status = "approving";
    t.reason = "correct";
    t.token = null;
    this.store.saveGateTrial(t);
    // The confirmation must go out while the request is still open.
    this.queue.push(
      {
        label: `approval to ${t.user_id}`,
        expiresAtMs: this.lastDmAt(t) * 1000,
        send: () => this.api.sendMessage(t.user_chat_id, GATE_TEXT.approved).then(() => undefined),
        done: () => this.finishApprove(t.user_id, 0),
      },
      true
    );
  }

  private async finishApprove(userId: number, tries: number): Promise<void> {
    const t = this.store.getGateTrial(userId);
    if (!t || t.status !== "approving") return;
    try {
      await this.api.approveChatJoinRequest(t.chat_id, t.user_id);
      t.status = "approved";
      t.decided_ts = this.secs();
      this.store.saveGateTrial(t);
      this.log.info(`gate: ${this.who(t)} APPROVED — passed the trial`);
    } catch (e) {
      const text = String((e as { description?: string })?.description ?? e);
      if (FINAL_REQUEST_ERRORS.test(text)) {
        t.status = "declined";
        t.reason = "request_gone";
        t.decided_ts = this.secs();
        this.store.saveGateTrial(t);
        this.log.warn(`gate: ${this.who(t)} passed, but the join request no longer exists (${text})`);
      } else if (tries < 2) {
        const wait = (retryAfterSecs(e) ?? 10) * 1000;
        this.log.warn(`gate: approving ${this.who(t)} failed — retrying in ${wait / 1000}s`, e);
        this.schedule(() => this.finishApprove(userId, tries + 1), wait);
      } else {
        // Still "approving" in the table: the next start finishes it.
        this.log.error(`gate: approving ${this.who(t)} keeps failing — will retry at the next restart`, e);
      }
    }
  }

  private decline(t: GateTrialRow, reason: string, opts: { dm: boolean; cooldown: boolean }): void {
    const now = this.secs();
    const remaining = Math.max(0, t.cooldown_until - now);
    t.status = "declining";
    t.reason = reason;
    t.token = null;
    if (opts.cooldown) t.cooldown_until = now + this.cfg.cooldownSecs;
    this.store.saveGateTrial(t);

    const finish = (): Promise<void> => this.finishDecline(t.user_id, 0);
    if (!opts.dm) {
      // No message, but still paced, so a wave of declines cannot flood either.
      this.queue.push({ label: `decline of ${t.user_id}`, expiresAtMs: Infinity, send: finish });
      return;
    }
    const text =
      reason === "cooldown"
        ? GATE_TEXT.cooldown(remaining)
        : reason === "timeout"
          ? GATE_TEXT.timeout(this.cfg.cooldownSecs)
          : GATE_TEXT.wrong(this.cfg.cooldownSecs);
    // The verdict must go out while the request is still open; then decline.
    this.queue.push(
      {
        label: `verdict to ${t.user_id}`,
        expiresAtMs: this.lastDmAt(t) * 1000,
        send: () => this.api.sendMessage(t.user_chat_id, text).then(() => undefined),
        done: finish,
      },
      true
    );
  }

  private async finishDecline(userId: number, tries: number): Promise<void> {
    const t = this.store.getGateTrial(userId);
    if (!t || t.status !== "declining") return;
    try {
      await this.api.declineChatJoinRequest(t.chat_id, t.user_id);
    } catch (e) {
      const text = String((e as { description?: string })?.description ?? e);
      if (!FINAL_REQUEST_ERRORS.test(text)) {
        if (tries < 3) {
          const wait = (retryAfterSecs(e) ?? 10) * 1000;
          this.log.warn(`gate: declining ${this.who(t)} failed — retrying in ${wait / 1000}s`, e);
          this.schedule(() => this.finishDecline(userId, tries + 1), wait);
        } else {
          // Still "declining" in the table: the next start finishes it.
          this.log.error(`gate: declining ${this.who(t)} keeps failing — will retry at the next restart`, e);
        }
        return;
      }
      // The request is already gone (withdrawn, or handled by an admin).
    }
    t.status = "declined";
    t.decided_ts = this.secs();
    this.store.saveGateTrial(t);
    const until = t.cooldown_until > this.secs() ? `, cooldown until ${new Date(t.cooldown_until * 1000).toISOString()}` : "";
    this.log.info(`gate: ${this.who(t)} DECLINED [${t.reason}]${until}`);
  }

  // ---- after a restart --------------------------------------------------------

  /** Pick up every unfinished trial. Nobody is approved here who had not already passed. */
  restore(): number {
    const open = this.store.openGateTrials();
    const now = this.secs();
    for (const t of open) {
      if (t.status === "approving") {
        void this.finishApprove(t.user_id, 0);
      } else if (t.status === "declining") {
        this.queue.push({ label: `decline of ${t.user_id}`, expiresAtMs: Infinity, send: () => this.finishDecline(t.user_id, 0) });
      } else if (now >= t.deadline_ts) {
        // Timed out while we were away. Message them only if the window is still open.
        this.decline(t, "timeout", { dm: now < this.lastDmAt(t), cooldown: true });
      } else if (t.status === "queued") {
        if (this.lastDmAt(t) - VERDICT_ROOM_SECS - now < MIN_TRIAL_SECS) {
          this.decline(t, "stale_request", { dm: false, cooldown: false });
        } else {
          this.sendRound(t.user_id, "trial");
        }
      } else {
        // pending: keep the same deadline. If the grid was spent and the next
        // one never went out, send it now.
        this.schedule(() => this.expire(t.user_id), (t.deadline_ts - now) * 1000 + 250);
        if (t.token === null) this.sendRound(t.user_id, t.wrong > 0 ? "retry" : "second");
      }
    }
    if (open.length > 0) this.log.info(`gate: picked up ${open.length} unfinished trial(s) after the restart`);
    return open.length;
  }
}

// ---- wiring -------------------------------------------------------------------

/** Register the gate. Does nothing at all when the flag is off. */
export function registerGate(m: MouthCtx): void {
  const cfg = loadGateConfig();
  if (!cfg.enabled) {
    m.log.info("gate: OFF (TG_GATE_ENABLED is not true)");
    return;
  }
  const grids = loadGrids();
  m.log.info(
    `gate: ON — ${grids.length} trial images | answer within ${cfg.timeoutSecs}s | cooldown ${cfg.cooldownSecs}s | ` +
      `one message per ${cfg.dmIntervalMs}ms, at most ${cfg.maxActive} trials at once`
  );
  if (grids.length === 0) m.log.error(`gate: no trial images in ${GRID_DIR} — run scripts/make-gate-grids.swift`);

  const gate = new Gate({
    api: m.bot.api as unknown as GateApi,
    store: m.db,
    kv: m.db,
    log: m.log,
    cfg,
    chatId: m.cfg.chatId,
    isTrusted: (id) => (m.cfg.ownerId !== 0 && id === m.cfg.ownerId) || m.db.isMod(id),
    grids,
  });
  gate.restore();

  m.bot.on("chat_join_request", async (c) => {
    const r = c.chatJoinRequest;
    await gate.onJoinRequest({
      chatId: r.chat.id,
      userId: r.from.id,
      userChatId: r.user_chat_id,
      date: r.date,
      firstName: r.from.first_name,
      username: r.from.username,
    });
  });

  m.bot.callbackQuery(/^gate:/, async (c) => {
    const text = await gate.onButton({ fromId: c.from.id, data: c.callbackQuery.data });
    await c.answerCallbackQuery({ text }).catch(() => {});
  });

  // Without the "invite users" right Telegram sends the bot no join requests.
  void (async () => {
    try {
      const me = await m.bot.api.getMe();
      const member = await m.bot.api.getChatMember(m.cfg.chatId, me.id);
      const can = member.status === "administrator" && member.can_invite_users === true;
      if (!can) {
        m.log.warn(
          'gate: the bot is missing the "Invite Users via Link" admin right — join requests will not reach it and it cannot approve or decline'
        );
      }
    } catch (e) {
      m.log.warn("gate: could not check the bot's admin rights", e);
    }
  })();
}
