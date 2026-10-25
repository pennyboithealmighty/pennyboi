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

export interface ExclusionRow {
  address: string;
  reason: string | null;
  ts: number;
}

export interface DonationRow {
  tx_sig: string;
  ts: number;
  slot: number | null;
  donor: string;
  lamports: number;
  is_creator: number;
  reference: string | null;
  memo_raw: string | null;
  memo_clean: string | null;
  tier: string;
  announced_tg: number;
  announced_x: number;
  narration: string | null;
}

export interface AirdropRoundRow {
  step: number;
  ts: number;
  seed: string;
  blockhash: string;
  pool_hash: string;
  pool_size: number;
  pool_json: string;
  favored_json: string | null;
  fortune_json: string | null;
  amount_each: number | null;
  tx_sig: string | null;
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

  /** A wallet's Pennyboi nickname, if one has been coined. */
  nicknameOf(wallet: string): string | null {
    const r = this.db.prepare(`SELECT nickname FROM wallets WHERE wallet = ?`).get(wallet) as
      | { nickname: string | null }
      | undefined;
    return r?.nickname ?? null;
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

  // ---- airdrop eligibility & rounds (docs/11) -----------------------------

  addExclusion(address: string, reason: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO airdrop_exclusions (address, reason, ts) VALUES (?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET reason = excluded.reason, ts = excluded.ts`
      )
      .run(address, reason, now);
  }

  removeExclusion(address: string): void {
    this.db.prepare(`DELETE FROM airdrop_exclusions WHERE address = ?`).run(address);
  }

  listExclusions(): ExclusionRow[] {
    return this.db
      .prepare(`SELECT address, reason, ts FROM airdrop_exclusions ORDER BY ts DESC`)
      .all() as ExclusionRow[];
  }

  /** The exclusion addresses as a set, for the pool filter. */
  excludedSet(): Set<string> {
    const rows = this.db.prepare(`SELECT address FROM airdrop_exclusions`).all() as Array<{ address: string }>;
    return new Set(rows.map((r) => r.address));
  }

  /** Store (or replace) the pool snapshot + seed for a threshold step. */
  saveAirdropRound(r: {
    step: number;
    now: number;
    seed: string;
    blockhash: string;
    poolHash: string;
    poolSize: number;
    pool: string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO airdrop_rounds (step, ts, seed, blockhash, pool_hash, pool_size, pool_json)
         VALUES (@step, @ts, @seed, @blockhash, @pool_hash, @pool_size, @pool_json)
         ON CONFLICT(step) DO UPDATE SET
           ts = excluded.ts, seed = excluded.seed, blockhash = excluded.blockhash,
           pool_hash = excluded.pool_hash, pool_size = excluded.pool_size, pool_json = excluded.pool_json`
      )
      .run({
        step: r.step,
        ts: r.now,
        seed: r.seed,
        blockhash: r.blockhash,
        pool_hash: r.poolHash,
        pool_size: r.poolSize,
        pool_json: JSON.stringify(r.pool),
      });
  }

  /** Record what actually went out, once Hands has signed the airdrop. */
  recordAirdropResult(r: {
    step: number;
    favored: string[];
    fortune: string[];
    amountEach: number;
    txSig: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE airdrop_rounds
            SET favored_json = ?, fortune_json = ?, amount_each = ?, tx_sig = ?
          WHERE step = ?`
      )
      .run(JSON.stringify(r.favored), JSON.stringify(r.fortune), r.amountEach, r.txSig, r.step);
  }

  getAirdropRound(step: number): AirdropRoundRow | null {
    const r = this.db.prepare(`SELECT * FROM airdrop_rounds WHERE step = ?`).get(step) as
      | AirdropRoundRow
      | undefined;
    return r ?? null;
  }

  recentAirdropRounds(n: number): AirdropRoundRow[] {
    return this.db
      .prepare(`SELECT * FROM airdrop_rounds ORDER BY step DESC LIMIT ?`)
      .all(n) as AirdropRoundRow[];
  }

  /** Wallets that won an airdrop since `sinceTs` (for the repeat-cooldown rule). */
  airdropWinnersSince(sinceTs: number): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT ts, favored_json, fortune_json FROM airdrop_rounds WHERE ts >= ? AND tx_sig IS NOT NULL`)
      .all(sinceTs) as Array<{ ts: number; favored_json: string | null; fortune_json: string | null }>;
    const out = new Map<string, number>();
    for (const row of rows) {
      const won = [...safeArr(row.favored_json), ...safeArr(row.fortune_json)];
      for (const w of won) {
        const prev = out.get(w);
        if (prev == null || row.ts > prev) out.set(w, row.ts);
      }
    }
    return out;
  }

  // ---- offerings / donations (docs/12) ------------------------------------
  // Distinct from the Telegram `offerings` (stunt pitches) methods above.

  /** Record a detected SOL gift. Idempotent by tx_sig; returns true if new. */
  recordDonation(d: Omit<DonationRow, "announced_tg" | "announced_x" | "narration">): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO donations
           (tx_sig, ts, slot, donor, lamports, is_creator, reference, memo_raw, memo_clean, tier)
         VALUES (@tx_sig, @ts, @slot, @donor, @lamports, @is_creator, @reference, @memo_raw, @memo_clean, @tier)`
      )
      .run({
        tx_sig: d.tx_sig,
        ts: d.ts,
        slot: d.slot,
        donor: d.donor,
        lamports: d.lamports,
        is_creator: d.is_creator,
        reference: d.reference,
        memo_raw: d.memo_raw,
        memo_clean: d.memo_clean,
        tier: d.tier,
      });
    return info.changes > 0;
  }

  hasDonation(txSig: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM donations WHERE tx_sig = ?`).get(txSig);
  }

  getDonation(txSig: string): DonationRow | null {
    return (this.db.prepare(`SELECT * FROM donations WHERE tx_sig = ?`).get(txSig) as DonationRow | undefined) ?? null;
  }

  getDonationByRef(reference: string): DonationRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM donations WHERE reference = ? ORDER BY ts DESC LIMIT 1`)
        .get(reference) as DonationRow | undefined) ?? null
    );
  }

  /** Most recent gift signature (catch-up uses it as `until`). */
  lastDonationSig(): string | null {
    const r = this.db.prepare(`SELECT tx_sig FROM donations ORDER BY ts DESC LIMIT 1`).get() as
      | { tx_sig: string }
      | undefined;
    return r?.tx_sig ?? null;
  }

  /** How many gifts this donor has made (for the thanks context). */
  countDonationsByDonor(donor: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM donations WHERE donor = ?`).get(donor) as { n: number }).n;
  }

  /** Non-dust gifts not yet announced in Telegram (oldest first) — the thanks queue. */
  unannouncedOfferings(limit = 20): DonationRow[] {
    return this.db
      .prepare(`SELECT * FROM donations WHERE announced_tg = 0 AND tier != 'dust' ORDER BY ts ASC LIMIT ?`)
      .all(limit) as DonationRow[];
  }

  markOfferingAnnounced(txSig: string, which: { tg?: boolean; x?: boolean }): void {
    if (which.tg) this.db.prepare(`UPDATE donations SET announced_tg = 1 WHERE tx_sig = ?`).run(txSig);
    if (which.x) this.db.prepare(`UPDATE donations SET announced_x = 1 WHERE tx_sig = ?`).run(txSig);
  }

  setOfferingNarration(txSig: string, narration: string): void {
    this.db.prepare(`UPDATE donations SET narration = ? WHERE tx_sig = ?`).run(narration, txSig);
  }

  /** When this donor was last individually thanked (announced), for the cooldown. */
  lastThankedTs(donor: string): number | null {
    const r = this.db
      .prepare(`SELECT MAX(ts) AS ts FROM donations WHERE donor = ? AND announced_tg = 1`)
      .get(donor) as { ts: number | null };
    return r?.ts ?? null;
  }

  /** Offering rollup for the owner digest (docs/12 §3): totals include dust. */
  offeringDigest(sinceTs: number): {
    count: number;
    lamports: number;
    largest: DonationRow | null;
    dustCount: number;
    droppedMemos: number;
  } {
    const agg = this.db
      .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(lamports), 0) AS lamports FROM donations WHERE ts >= ?`)
      .get(sinceTs) as { count: number; lamports: number };
    const largest = (this.db
      .prepare(`SELECT * FROM donations WHERE ts >= ? ORDER BY lamports DESC LIMIT 1`)
      .get(sinceTs) as DonationRow | undefined) ?? null;
    const dustCount = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM donations WHERE ts >= ? AND tier = 'dust'`)
      .get(sinceTs) as { n: number }).n;
    const droppedMemos = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM donations WHERE ts >= ? AND memo_raw IS NOT NULL AND memo_clean IS NULL`)
      .get(sinceTs) as { n: number }).n;
    return { count: agg.count, lamports: agg.lamports, largest, dustCount, droppedMemos };
  }
}

function safeArr(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** Top `n` offerings by upvotes (ties: earliest). Pure helper for callers/tests. */
export function rankOfferings(rows: OfferingDbRow[], n = 5): OfferingDbRow[] {
  return [...rows].sort((a, b) => b.upvotes - a.upvotes || a.ts - b.ts).slice(0, n);
}
