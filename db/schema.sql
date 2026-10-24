-- Pennyboi memory DB — SQLite schema (docs/04-agent-prompt.md).
-- Created/loaded via better-sqlite3 by the services. The memory tables
-- (wallets/grudges/actions) are finalized and wired to eyes/brain/hands in
-- build-plan Step 6; Mouth (Step 5) already uses the offerings + moderation
-- tables below and reads grudges/loyal.

PRAGMA journal_mode = WAL;

-- ---- Memory (docs/04) ----------------------------------------------------
CREATE TABLE IF NOT EXISTS wallets (
  wallet        TEXT PRIMARY KEY,
  nickname      TEXT,
  loyalty_score REAL NOT NULL DEFAULT 0,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grudges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  cleared_ts INTEGER
);

CREATE TABLE IF NOT EXISTS loyal (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  threshold_step INTEGER,
  mood           TEXT,
  action         TEXT NOT NULL,
  params_json    TEXT,
  reasoning      TEXT,
  narration      TEXT,
  tx_sig         TEXT,
  status         TEXT
);

-- ---- Offerings (docs/06 §2C) ---------------------------------------------
CREATE TABLE IF NOT EXISTS offerings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  tg_user_id     INTEGER NOT NULL,
  wallet         TEXT NOT NULL,   -- telegram handle / id stand-in for now
  text           TEXT NOT NULL,
  upvotes        INTEGER NOT NULL DEFAULT 0,
  chosen         INTEGER NOT NULL DEFAULT 0,
  threshold_step INTEGER NOT NULL DEFAULT 0,
  message_id     INTEGER
);

-- one offering per user per threshold step
CREATE UNIQUE INDEX IF NOT EXISTS offerings_user_step
  ON offerings (tg_user_id, threshold_step);

-- ---- Telegram moderation (docs/06 §3, §5, §8) ----------------------------
CREATE TABLE IF NOT EXISTS members (
  tg_user_id  INTEGER PRIMARY KEY,
  first_seen  INTEGER NOT NULL,
  warnings    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS restrictions (
  tg_user_id   INTEGER PRIMARY KEY,
  muted_until  INTEGER NOT NULL DEFAULT 0,
  banned       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mods (
  tg_user_id INTEGER PRIMARY KEY,
  added_ts   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mod_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  reason TEXT
);

-- Small runtime key/value store (quiet-until, etc.).
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---- X pre-launch "Prophecy" posts (docs/09) ----------------------------
CREATE TABLE IF NOT EXISTS x_posts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  theme            TEXT,
  mood             TEXT,
  text             TEXT NOT NULL,
  x_post_id        TEXT,
  status           TEXT NOT NULL,   -- posted | rejected | skipped | error
  rejection_reason TEXT
);
