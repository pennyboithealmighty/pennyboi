// Shared memory DB (SQLite via better-sqlite3). One store, one file, used by
// eyes (briefing inputs), mouth (offerings, moderation, memory writes), and
// available to hands. Schema lives in db/schema.sql (docs/04 tables).

import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRoot, resolveFromRoot } from "./env.js";

export interface OfferingDbRow {
  id: number;
  ts: number;
  wallet: string;
  text: string;
  upvotes: number;
  chosen: number;
}

export interface MentionRow {
  wallet: string;
  nickname: string | null;
  reason: string;
}

export interface ActionRow {
  ts: number;
  action: string;
  narration: string | null;
  tx_sig: string | null;
}

export interface XPostRow {
  ts: number;
  theme: string | null;
  mood: string | null;
  text: string;
  x_post_id: string | null;
  status: string;
  rejection_reason: string | null;
}

/** A batch of memory changes derived from an action + its narration. */
export interface MemoryUpdate {
  seen: string[];
  loyal: Array<{ wallet: string; reason: string; nickname?: string }>;
  grudges: Array<{ wallet: string; reason: string }>;
}

const DAY_SECS = 86_400;

export class MemoryDb {
  private db: Database.Database;

  constructor(path: string) {
    const resolved = resolveFromRoot(path);
    mkdirSync(dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(readFileSync(join(repoRoot(), "db", "schema.sql"), "utf8"));
  }

  // ---- wallets ------------------------------------------------------------

  upsertWalletSeen(wallet: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO wallets (wallet, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(wallet) DO UPDATE SET last_seen = excluded.last_seen`
      )
      .run(wallet, now, now);
  }

  setNickname(wallet: string, nickname: string, now: number): void {
    this.upsertWalletSeen(wallet, now);
    this.db.prepare(`UPDATE wallets SET nickname = ? WHERE wallet = ?`).run(nickname, wallet);
  }

  bumpLoyalty(wallet: string, delta: number, now: number): void {
    this.upsertWalletSeen(wallet, now);
    this.db
      .prepare(`UPDATE wallets SET loyalty_score = loyalty_score + ? WHERE wallet = ?`)
      .run(delta, wallet);
  }

  // ---- grudges / loyal ----------------------------------------------------

  hasActiveGrudge(wallet: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM grudges WHERE wallet = ? AND cleared_ts IS NULL`)
      .get(wallet);
  }

  addGrudge(wallet: string, reason: string, now: number): void {
    if (this.hasActiveGrudge(wallet)) return; // one active grudge per wallet
    this.db
      .prepare(`INSERT INTO grudges (wallet, reason, created_ts) VALUES (?, ?, ?)`)
      .run(wallet, reason, now);
  }

  clearGrudge(wallet: string, now: number): void {
    this.db
      .prepare(`UPDATE grudges SET cleared_ts = ? WHERE wallet = ? AND cleared_ts IS NULL`)
      .run(now, wallet);
  }

  addLoyal(wallet: string, reason: string, now: number): void {
    this.db
      .prepare(`INSERT INTO loyal (wallet, reason, created_ts) VALUES (?, ?, ?)`)
      .run(wallet, reason, now);
  }

  listGrudges(n: number): MentionRow[] {
    return this.db
      .prepare(
        `SELECT g.wallet, w.nickname, g.reason
           FROM grudges g LEFT JOIN wallets w ON w.wallet = g.wallet
          WHERE g.cleared_ts IS NULL
          ORDER BY g.created_ts DESC LIMIT ?`
      )
      .all(n) as MentionRow[];
  }

  listLoyal(n: number): MentionRow[] {
    return this.db
      .prepare(
        `SELECT l.wallet, w.nickname, l.reason
           FROM loyal l LEFT JOIN wallets w ON w.wallet = l.wallet
          ORDER BY l.created_ts DESC LIMIT ?`
      )
      .all(n) as MentionRow[];
  }

  /** Apply a derived batch (seen wallets, loyalty, grudges). */
  applyMemoryUpdate(update: MemoryUpdate, now: number): void {
    const loyalWallets = new Set(update.loyal.map((l) => l.wallet));
    const tx = this.db.transaction(() => {
      for (const w of update.seen) this.upsertWalletSeen(w, now);
      for (const l of update.loyal) {
        this.bumpLoyalty(l.wallet, 1, now);
        this.addLoyal(l.wallet, l.reason, now);
        if (l.nickname) this.setNickname(l.wallet, l.nickname, now);
        this.clearGrudge(l.wallet, now); // blessing forgives
      }
      for (const g of update.grudges) {
        if (loyalWallets.has(g.wallet)) continue; // action-blessed wins
        this.addGrudge(g.wallet, g.reason, now);
      }
    });
    tx();
  }

  // ---- actions ------------------------------------------------------------

  recordAction(a: {
    now: number;
    thresholdStep?: number;
    mood?: string;
    action: string;
    paramsJson?: string;
    reasoning?: string;
    narration?: string;
    txSig?: string;
    status: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO actions
           (ts, threshold_step, mood, action, params_json, reasoning, narration, tx_sig, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        a.now,
        a.thresholdStep ?? null,
        a.mood ?? null,
        a.action,
        a.paramsJson ?? null,
        a.reasoning ?? null,
        a.narration ?? null,
        a.txSig ?? null,
        a.status
      );
  }

  lastActions(n: number): ActionRow[] {
    return this.db
      .prepare(`SELECT ts, action, narration, tx_sig FROM actions ORDER BY id DESC LIMIT ?`)
      .all(n) as ActionRow[];
  }

  private count(sql: string): number {
    return (this.db.prepare(sql).get() as { n: number }).n;
  }
  countActions(): number {
    return this.count(`SELECT COUNT(*) AS n FROM actions`);
  }
  countPostedXPosts(): number {
    return this.count(`SELECT COUNT(*) AS n FROM x_posts WHERE status = 'posted'`);
  }
  countActiveGrudges(): number {
    return this.count(`SELECT COUNT(*) AS n FROM grudges WHERE cleared_ts IS NULL`);
  }
  countLoyal(): number {
    return this.count(`SELECT COUNT(*) AS n FROM loyal`);
  }

  // ---- offerings ----------------------------------------------------------

  addOffering(args: {
    tgUserId: number;
    wallet: string;
    text: string;
    step: number;
    now: number;
    messageId?: number;
  }): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO offerings (ts, tg_user_id, wallet, text, upvotes, threshold_step, message_id)
           VALUES (?, ?, ?, ?, 0, ?, ?)`
        )
        .run(args.now, args.tgUserId, args.wallet, args.text, args.step, args.messageId ?? null);
      return true;
    } catch {
      return false; // unique(tg_user_id, threshold_step)
    }
  }

  upvoteByMessageId(messageId: number, delta: number): void {
    this.db
      .prepare(`UPDATE offerings SET upvotes = MAX(0, upvotes + ?) WHERE message_id = ?`)
      .run(delta, messageId);
  }

  topOfferings(step: number, n: number): OfferingDbRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, wallet, text, upvotes, chosen FROM offerings
          WHERE threshold_step = ? ORDER BY upvotes DESC, ts ASC LIMIT ?`
      )
      .all(step, n) as OfferingDbRow[];
  }

  /** Top not-yet-chosen offerings across steps — what the next briefing shows. */
  topOpenOfferings(n: number): OfferingDbRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, wallet, text, upvotes, chosen FROM offerings
          WHERE chosen = 0 ORDER BY upvotes DESC, ts DESC LIMIT ?`
      )
      .all(n) as OfferingDbRow[];
  }

  markChosen(id: number): void {
    this.db.prepare(`UPDATE offerings SET chosen = 1 WHERE id = ?`).run(id);
  }

  // ---- members / moderation ----------------------------------------------

  seenMember(id: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO members (tg_user_id, first_seen) VALUES (?, ?)
         ON CONFLICT(tg_user_id) DO NOTHING`
      )
      .run(id, now);
  }

  isNewMember(id: number, now: number, windowSecs = DAY_SECS): boolean {
    const row = this.db
      .prepare(`SELECT first_seen FROM members WHERE tg_user_id = ?`)
      .get(id) as { first_seen: number } | undefined;
    if (!row) return true;
    return now - row.first_seen < windowSecs;
  }

  bumpWarning(id: number): number {
    this.db
      .prepare(
        `INSERT INTO members (tg_user_id, first_seen, warnings) VALUES (?, 0, 1)
         ON CONFLICT(tg_user_id) DO UPDATE SET warnings = warnings + 1`
      )
      .run(id);
    return (this.db.prepare(`SELECT warnings FROM members WHERE tg_user_id = ?`).get(id) as {
      warnings: number;
    }).warnings;
  }

  mute(id: number, untilTs: number, reason: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO restrictions (tg_user_id, muted_until) VALUES (?, ?)
         ON CONFLICT(tg_user_id) DO UPDATE SET muted_until = excluded.muted_until`
      )
      .run(id, untilTs);
    this.logMod("mute", String(id), reason, now);
  }

  ban(id: number, reason: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO restrictions (tg_user_id, banned) VALUES (?, 1)
         ON CONFLICT(tg_user_id) DO UPDATE SET banned = 1`
      )
      .run(id);
    this.logMod("ban", String(id), reason, now);
  }

  mutedCount(now: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM restrictions WHERE muted_until > ?`).get(now) as {
      n: number;
    }).n;
  }

  bannedCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM restrictions WHERE banned = 1`).get() as {
      n: number;
    }).n;
  }

  // ---- mods / log / kv ----------------------------------------------------

  addMod(id: number, now: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO mods (tg_user_id, added_ts) VALUES (?, ?)`).run(id, now);
  }
  removeMod(id: number): void {
    this.db.prepare(`DELETE FROM mods WHERE tg_user_id = ?`).run(id);
  }
  isMod(id: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM mods WHERE tg_user_id = ?`).get(id);
  }

  logMod(action: string, target: string | null, reason: string, now: number): void {
    this.db
      .prepare(`INSERT INTO mod_log (ts, action, target, reason) VALUES (?, ?, ?, ?)`)
      .run(now, action, target, reason);
  }
  recentLog(n: number): Array<{ ts: number; action: string; target: string | null; reason: string }> {
    return this.db
      .prepare(`SELECT ts, action, target, reason FROM mod_log ORDER BY id DESC LIMIT ?`)
      .all(n) as Array<{ ts: number; action: string; target: string | null; reason: string }>;
  }

  kvGet(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return r ? r.value : null;
  }
  kvSet(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  // ---- X pre-launch posts (docs/09) --------------------------------------

  recordXPost(r: {
    now: number;
    theme?: string;
    mood?: string;
    text: string;
    xPostId?: string;
    status: "posted" | "rejected" | "skipped" | "error";
    rejectionReason?: string;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO x_posts (ts, theme, mood, text, x_post_id, status, rejection_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(r.now, r.theme ?? null, r.mood ?? null, r.text, r.xPostId ?? null, r.status, r.rejectionReason ?? null);
    return Number(info.lastInsertRowid);
  }

  recentXPosts(n: number): XPostRow[] {
    return this.db
      .prepare(
        `SELECT ts, theme, mood, text, x_post_id, status, rejection_reason
           FROM x_posts ORDER BY id DESC LIMIT ?`
      )
      .all(n) as XPostRow[];
  }

  /** Posts actually sent to X since `dayStartTs`. */
  xPostedTodayCount(dayStartTs: number): number {
    return (this.db
      .prepare(`SELECT COUNT(*) AS n FROM x_posts WHERE status = 'posted' AND ts >= ?`)
      .get(dayStartTs) as { n: number }).n;
  }

  /** Whether a posted tweet since `dayStartTs` already carried the pennyboi.com link. */
  xLinkUsedToday(dayStartTs: number): boolean {
    return (this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM x_posts
          WHERE status = 'posted' AND ts >= ? AND text LIKE '%pennyboi.com%'`
      )
      .get(dayStartTs) as { n: number }).n > 0;
  }

  lastXRejection(): { ts: number; text: string; rejection_reason: string | null } | null {
    const r = this.db
      .prepare(`SELECT ts, text, rejection_reason FROM x_posts WHERE status = 'rejected' ORDER BY id DESC LIMIT 1`)
      .get() as { ts: number; text: string; rejection_reason: string | null } | undefined;
    return r ?? null;
  }
}

/** Top `n` offerings by upvotes (ties: earliest). Pure helper for callers/tests. */
export function rankOfferings(rows: OfferingDbRow[], n = 5): OfferingDbRow[] {
  return [...rows].sort((a, b) => b.upvotes - a.upvotes || a.ts - b.ts).slice(0, n);
}
