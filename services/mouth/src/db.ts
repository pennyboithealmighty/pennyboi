// SQLite access for Mouth: offerings intake, member tracking, moderation state,
// and reads of grudges/loyal. Opens DATABASE_PATH and applies db/schema.sql.
//
// NOTE: build-plan Step 6 extracts this into a shared memory-DB module wired to
// eyes/brain/hands and adds nickname/grudge extraction. For Step 5 it lives here
// so the Telegram bot is self-sufficient.

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRoot } from "@pennyboi/shared";
import type { OfferingRecord } from "./offerings.js";

const DAY_SECS = 86_400;

export class MouthDb {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    const schema = readFileSync(join(repoRoot(), "db", "schema.sql"), "utf8");
    this.db.exec(schema);
    // Ensure the directory note: better-sqlite3 creates the file; the parent
    // dir must exist (db/ is in the repo).
    void dirname;
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
    if (!row) return true; // unseen = treat as new
    return now - row.first_seen < windowSecs;
  }

  bumpWarning(id: number): number {
    this.db
      .prepare(
        `INSERT INTO members (tg_user_id, first_seen, warnings) VALUES (?, 0, 1)
         ON CONFLICT(tg_user_id) DO UPDATE SET warnings = warnings + 1`
      )
      .run(id);
    const row = this.db
      .prepare(`SELECT warnings FROM members WHERE tg_user_id = ?`)
      .get(id) as { warnings: number };
    return row.warnings;
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
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM restrictions WHERE muted_until > ?`)
      .get(now) as { n: number };
    return r.n;
  }

  bannedCount(): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM restrictions WHERE banned = 1`)
      .get() as { n: number };
    return r.n;
  }

  // ---- mods ---------------------------------------------------------------

  addMod(id: number, now: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO mods (tg_user_id, added_ts) VALUES (?, ?)`)
      .run(id, now);
  }
  removeMod(id: number): void {
    this.db.prepare(`DELETE FROM mods WHERE tg_user_id = ?`).run(id);
  }
  isMod(id: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM mods WHERE tg_user_id = ?`).get(id);
  }

  // ---- mod log ------------------------------------------------------------

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

  // ---- offerings ----------------------------------------------------------

  /** Add an offering; returns false if the user already offered this step. */
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
      return false; // unique(tg_user_id, threshold_step) violation
    }
  }

  upvoteByMessageId(messageId: number, delta: number): void {
    this.db
      .prepare(
        `UPDATE offerings SET upvotes = MAX(0, upvotes + ?) WHERE message_id = ?`
      )
      .run(delta, messageId);
  }

  topOfferings(step: number, n: number): OfferingRecord[] {
    return this.db
      .prepare(
        `SELECT id, ts, wallet, text, upvotes, chosen FROM offerings
         WHERE threshold_step = ? ORDER BY upvotes DESC, ts ASC LIMIT ?`
      )
      .all(step, n) as OfferingRecord[];
  }

  markChosen(id: number): void {
    this.db.prepare(`UPDATE offerings SET chosen = 1 WHERE id = ?`).run(id);
  }

  // ---- grudges / loyal (reads; populated in Step 6) -----------------------

  listGrudges(n: number): Array<{ wallet: string; nickname: string | null; reason: string }> {
    return this.db
      .prepare(
        `SELECT g.wallet, w.nickname, g.reason
           FROM grudges g LEFT JOIN wallets w ON w.wallet = g.wallet
          WHERE g.cleared_ts IS NULL
          ORDER BY g.created_ts DESC LIMIT ?`
      )
      .all(n) as Array<{ wallet: string; nickname: string | null; reason: string }>;
  }

  listLoyal(n: number): Array<{ wallet: string; nickname: string | null; reason: string }> {
    return this.db
      .prepare(
        `SELECT l.wallet, w.nickname, l.reason
           FROM loyal l LEFT JOIN wallets w ON w.wallet = l.wallet
          ORDER BY l.created_ts DESC LIMIT ?`
      )
      .all(n) as Array<{ wallet: string; nickname: string | null; reason: string }>;
  }

  recordAction(args: {
    now: number;
    action: string;
    status: string;
    narration?: string;
    txSig?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO actions (ts, action, status, narration, tx_sig) VALUES (?, ?, ?, ?, ?)`
      )
      .run(args.now, args.action, args.status, args.narration ?? null, args.txSig ?? null);
  }

  lastActions(n: number): Array<{ ts: number; action: string; narration: string | null; tx_sig: string | null }> {
    return this.db
      .prepare(
        `SELECT ts, action, narration, tx_sig FROM actions ORDER BY id DESC LIMIT ?`
      )
      .all(n) as Array<{ ts: number; action: string; narration: string | null; tx_sig: string | null }>;
  }

  // ---- kv -----------------------------------------------------------------

  kvGet(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return r ? r.value : null;
  }
  kvSet(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }
}
