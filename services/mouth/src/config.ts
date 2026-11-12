// Mouth configuration loaded from env (docs/07). Topic IDs may be empty until
// the owner runs /ids and fills them in.

import { envBool, envNum, envStr, secretWordsFromEnv } from "@pennyboi/shared";

export interface MouthConfig {
  botToken: string;
  ownerId: number;
  chatId: number;
  topics: {
    general?: number;
    offerings?: number;
    scripture?: number;
  };
  replyRateSecs: number;
  dbPath: string;
  httpPort: number;
  dailyHour: number;
  solscanBase: string;
  cluster: string;
  // Allowlists for the outbound URL filter + foreign-address moderation.
  allowedHosts: string[];
  allowedAddresses: string[];
  links: { pumpfun: string; github: string; group: string };
  x: {
    mode: XMode;
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessSecret: string;
    prelaunch: {
      postsPerDay: number;
      hoursStart: number; // local hour 0-23
      hoursEnd: number;
      linkRate: number; // 0..1
      launchDate: string; // ISO date or ""
    };
  };
  mentions: MentionConfig;
}

export type XMode = "off" | "prelaunch" | "live";

/** X mention replies. Off unless MENTION_REPLY_ENABLED; dry-run unless told otherwise. */
export interface MentionConfig {
  enabled: boolean;
  dryRun: boolean;
  maxPerDay: number;
  maxPerUserPerDay: number;
  spendCapUsd: number;
  minGapSecs: number;
  pollSecs: number;
  staleSecs: number; // a queued mention older than this is dropped unanswered
  pageMax: number; // most mentions read per poll
  botUsername: string;
  botUserId: string; // optional; looked up once and cached when empty
  costReadUsd: number;
  costReplyUsd: number;
  costUserLookupUsd: number;
  secretWords: string[];
}

/** Dry-run is the safe side: only an explicit false/0/no/off turns it off. */
function dryRunFlag(): boolean {
  return !/^(0|false|no|off)$/i.test(envStr("MENTION_REPLY_DRY_RUN", "true").trim());
}

export function loadMentionConfig(): MentionConfig {
  return {
    enabled: envBool("MENTION_REPLY_ENABLED", false),
    dryRun: dryRunFlag(),
    maxPerDay: envNum("MAX_REPLIES_PER_DAY", 20),
    maxPerUserPerDay: envNum("MAX_REPLIES_PER_USER_PER_DAY", 2),
    spendCapUsd: envNum("DAILY_X_SPEND_CAP_USD", 1.0),
    minGapSecs: envNum("MENTION_REPLY_MIN_GAP_SECS", 180),
    pollSecs: Math.max(60, envNum("MENTION_POLL_SECS", 300)),
    staleSecs: envNum("MENTION_REPLY_STALE_SECS", 21_600),
    pageMax: envNum("MENTION_POLL_MAX_RESULTS", 20),
    botUsername: envStr("X_BOT_USERNAME", "Pennyboi_Sol").replace(/^@/, ""),
    botUserId: envStr("X_BOT_USER_ID"),
    // Defaults are the higher published rates, so the cap errs toward spending less.
    costReadUsd: envNum("X_COST_PER_READ_USD", 0.005),
    costReplyUsd: envNum("X_COST_PER_REPLY_USD", 0.015),
    costUserLookupUsd: envNum("X_COST_PER_USER_LOOKUP_USD", 0.01),
    secretWords: secretWordsFromEnv(),
  };
}

// X_MODE replaces X_ENABLED; treat X_ENABLED=true as "live" for back-compat.
function xMode(): XMode {
  const m = envStr("X_MODE").toLowerCase();
  if (m === "off" || m === "prelaunch" || m === "live") return m;
  if (/^(1|true|yes|on)$/i.test(envStr("X_ENABLED"))) return "live";
  return "off";
}

function parseHours(s: string): { hoursStart: number; hoursEnd: number } {
  const m = s.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return { hoursStart: 9, hoursEnd: 22 };
  return { hoursStart: Number(m[1]), hoursEnd: Number(m[2]) };
}

/** General topic -> undefined (post to root). Real topics are >1. */
function generalTopic(v: number): number | undefined {
  return v > 1 ? v : undefined;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function loadMouthConfig(): MouthConfig {
  const solscanBase = envStr("SOLSCAN_BASE", "https://solscan.io");
  const pumpfun = envStr("PUMPFUN_URL");
  const github = envStr("GITHUB_URL");
  const group = envStr("TELEGRAM_GROUP_URL", "https://t.me/pennyboialmighty");

  const allowedHosts = ["solscan.io", "t.me"];
  for (const u of [solscanBase, pumpfun, github, group]) {
    const h = u ? hostOf(u) : null;
    if (h && !allowedHosts.includes(h)) allowedHosts.push(h);
  }

  const allowedAddresses = [envStr("TOKEN_MINT"), envStr("VAULT_PROGRAM_ID")].filter(
    (a) => a !== ""
  );

  return {
    botToken: envStr("TELEGRAM_BOT_TOKEN"),
    ownerId: envNum("TELEGRAM_OWNER_ID", 0),
    chatId: envNum("TELEGRAM_CHAT_ID", 0),
    topics: {
      // In a forum supergroup the General topic IS the root: messages post with
      // NO message_thread_id. /ids reports no thread for General, so 0 or 1 both
      // mean "root" here -> undefined -> posts land in General correctly.
      general: generalTopic(envNum("TELEGRAM_TOPIC_GENERAL", 0)),
      offerings: envNum("TELEGRAM_TOPIC_OFFERINGS", 0) || undefined,
      scripture: envNum("TELEGRAM_TOPIC_SCRIPTURE", 0) || undefined,
    },
    replyRateSecs: envNum("TELEGRAM_REPLY_RATE_SECS", 90),
    dbPath: envStr("DATABASE_PATH", "./db/pennyboi.db"),
    httpPort: envNum("MOUTH_PORT", 8790),
    dailyHour: envNum("DAILY_HOUR", 9),
    solscanBase,
    cluster: envStr("SOLANA_CLUSTER", "devnet"),
    allowedHosts,
    allowedAddresses,
    links: { pumpfun, github, group },
    x: {
      mode: xMode(),
      apiKey: envStr("X_API_KEY"),
      apiSecret: envStr("X_API_SECRET"),
      accessToken: envStr("X_ACCESS_TOKEN"),
      accessSecret: envStr("X_ACCESS_SECRET"),
      prelaunch: {
        // One scheduled X post a day (X_PROPHECY_PER_DAY); the old name still works.
        postsPerDay: envNum("X_PROPHECY_PER_DAY", envNum("X_PRELAUNCH_POSTS_PER_DAY", 1)),
        ...parseHours(envStr("X_PRELAUNCH_HOURS", "09-22")),
        linkRate: envNum("X_PRELAUNCH_LINK_RATE", 0.25),
        launchDate: envStr("X_LAUNCH_DATE"),
      },
    },
    mentions: loadMentionConfig(),
  };
}
