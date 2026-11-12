// Pure logic for X mention replies: which mentions get answered, what a poll
// may cost, and the day's spend ledger. No network here, so it is all
// unit-testable. The X calls live in x-mentions-client.ts; the loops live in
// mention-replier.ts.

import { looksLikeInjection, mentionsSecret, sanitizeMentionText } from "@pennyboi/shared";
import { isScam } from "./detect.js";

/** A mention as read from X, reduced to the fields the classifier needs. */
export interface RawMention {
  id: string;
  text: string;
  authorId: string;
  createdAt?: string;
  inReplyToUserId?: string;
  referenced: Array<{ type: string; id: string }>;
  /** Expanded URLs from the post's entities (media and quotes included). */
  urls: string[];
  mentionCount: number;
  cashtagCount: number;
}

export interface MentionsPage {
  mentions: RawMention[];
  newestId: string | null;
}

/** What the replier needs from X. Implemented by XMentionsClient; faked in tests. */
export interface MentionsClient {
  readonly ready: boolean;
  getBotUserId(): Promise<string | null>;
  fetchMentions(
    userId: string,
    opts: { sinceId?: string; startTime?: string; maxResults: number }
  ): Promise<MentionsPage>;
  reply(text: string, toTweetId: string): Promise<string | null>;
}

/** An X API failure, with the two facts the replier acts on. */
export class MentionsApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly rateLimited: boolean,
    /** Unix seconds when the rate limit resets, if X said. */
    readonly resetAt?: number
  ) {
    super(message);
  }
}

export type Classification = { action: "queue"; clean: string } | { action: "skip"; reason: string };

// Links to X itself (attached media, quoted posts) and the home page are fine.
const OWN_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "pic.x.com",
  "pic.twitter.com",
  "pennyboi.com",
  "www.pennyboi.com",
]);
const URL_IN_TEXT_RE = /\bhttps?:\/\/\S+/i;
const ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|\bCA\s*[:=]|\b0x[0-9a-fA-F]{6,}\b/;
const X_SPAM_RE =
  /\b(follow back|f4f|check (?:my|our) (?:bio|pin|pinned|profile)|promo(?:tion)?s? (?:dm|available)|whatsapp|t\.me\b|send me (?:sol|money|crypto)|recover(?:y|ed)? (?:your|my) (?:funds|wallet|account))\b/i;
const MASS_TAG = 5;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Decide, in order, whether a mention is answered at all. First hit wins. */
export function classifyMention(
  m: RawMention,
  ctx: { botUserId: string; secretWords: string[] }
): Classification {
  if (!m.authorId) return { action: "skip", reason: "no_author" };
  if (m.authorId === ctx.botUserId) return { action: "skip", reason: "own_post" };
  if (m.referenced.some((r) => r.type === "retweeted") || /^RT @/i.test(m.text)) {
    return { action: "skip", reason: "retweet" };
  }
  // A reply aimed at someone else, with his handle only carried along the thread.
  if (m.inReplyToUserId && m.inReplyToUserId !== ctx.botUserId) {
    return { action: "skip", reason: "reply_to_other" };
  }
  if (isScam(m.text)) return { action: "skip", reason: "scam_pattern" };
  if (X_SPAM_RE.test(m.text)) return { action: "skip", reason: "spam_pattern" };
  const foreign = m.urls.some((u) => {
    const h = hostOf(u);
    return !h || !OWN_HOSTS.has(h);
  });
  // A link in the text that X gave us no entity for cannot be vetted.
  if (foreign || (URL_IN_TEXT_RE.test(m.text) && m.urls.length === 0)) {
    return { action: "skip", reason: "external_link" };
  }
  if (ADDRESS_RE.test(m.text)) return { action: "skip", reason: "address" };
  if (m.mentionCount >= MASS_TAG) return { action: "skip", reason: "mass_tag" };
  if (m.cashtagCount >= 2) return { action: "skip", reason: "cashtag_spam" };
  // The secret word gets no answer at all: neither confirmed nor denied.
  if (mentionsSecret(m.text, ctx.secretWords)) return { action: "skip", reason: "secret_word" };
  if (looksLikeInjection(m.text)) return { action: "skip", reason: "injection" };
  const clean = sanitizeMentionText(m.text);
  if (clean.length < 2) return { action: "skip", reason: "empty" };
  return { action: "queue", clean };
}

/** X returns at least 5 mentions per page, so that is the smallest read we can buy. */
export const MIN_PAGE = 5;

/**
 * How many mentions the next poll may ask for, given the budget left today.
 * 0 means even the smallest page is unaffordable: do not poll.
 */
export function pollPageSize(remainingUsd: number, readCostUsd: number, maxPage: number): number {
  if (readCostUsd <= 0) return Math.max(MIN_PAGE, maxPage);
  const affordable = Math.floor((remainingUsd + 1e-9) / readCostUsd);
  if (affordable < MIN_PAGE) return 0;
  return Math.max(MIN_PAGE, Math.min(maxPage, affordable));
}

export function startOfDayLocalSecs(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function dayKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export interface Kv {
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
}

/**
 * The day's estimated X spend for this feature, kv-backed so a restart cannot
 * reset it. "Simulated" is what dry-run replies would have cost; it counts
 * against the cap too, so a dry run behaves exactly like the real thing.
 */
export class SpendLedger {
  constructor(private kv: Kv, private capUsd: number) {}

  private read(kind: "real" | "sim", nowMs: number): number {
    return Number(this.kv.kvGet(`x_mentions_spend_${kind}:${dayKey(nowMs)}`) ?? "0") || 0;
  }
  private bump(kind: "real" | "sim", usd: number, nowMs: number): void {
    this.kv.kvSet(`x_mentions_spend_${kind}:${dayKey(nowMs)}`, (this.read(kind, nowMs) + usd).toFixed(4));
  }

  spent(nowMs = Date.now()): number {
    return this.read("real", nowMs);
  }
  simulated(nowMs = Date.now()): number {
    return this.read("sim", nowMs);
  }
  remaining(nowMs = Date.now()): number {
    return Math.max(0, this.capUsd - this.spent(nowMs) - this.simulated(nowMs));
  }
  canAfford(usd: number, nowMs = Date.now()): boolean {
    return this.remaining(nowMs) + 1e-9 >= usd;
  }
  add(usd: number, nowMs = Date.now()): void {
    if (usd > 0) this.bump("real", usd, nowMs);
  }
  addSimulated(usd: number, nowMs = Date.now()): void {
    if (usd > 0) this.bump("sim", usd, nowMs);
  }
  summary(nowMs = Date.now()): string {
    const sim = this.simulated(nowMs);
    return `$${this.spent(nowMs).toFixed(4)}${sim > 0 ? ` (+$${sim.toFixed(4)} simulated)` : ""} of $${this.capUsd.toFixed(2)}`;
  }
}
