// Mouth configuration loaded from env (docs/07). Topic IDs may be empty until
// the owner runs /ids and fills them in.

import { envNum, envStr } from "@pennyboi/shared";

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
}

export type XMode = "off" | "prelaunch" | "live";

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
        postsPerDay: envNum("X_PRELAUNCH_POSTS_PER_DAY", 3),
        ...parseHours(envStr("X_PRELAUNCH_HOURS", "09-22")),
        linkRate: envNum("X_PRELAUNCH_LINK_RATE", 0.25),
        launchDate: envStr("X_LAUNCH_DATE"),
      },
    },
  };
}
