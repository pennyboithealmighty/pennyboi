// X mention replies — the text safety shared by Brain (first line of defence)
// and Mouth (final gate before anything is posted). Pure, no I/O.
//   - sanitizeMentionText: what an untrusted mention is reduced to before the
//     Brain ever sees it
//   - looksLikeInjection / mentionsSecret: reasons not to answer at all
//   - shapeReply + rejectReply: what a reply must look like to be posted
//
// The secret ticker is never written in this repo: it comes from
// MENTION_SECRET_WORDS in .env. Every $cashtag is blocked regardless.

import { envList } from "./donations.js";
import { CATCHPHRASES, clampPost, clampSentences, splitSentences, throttleCatchphrases } from "./voice.js";

export const REPLY_MAX = 180; // chars
export const REPLY_MAX_SENTENCES = 2;
export const MENTION_TEXT_MAX = 240; // what the Brain is shown, at most

const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;
const URL_RE = /\bhttps?:\/\/\S+/i;
const DOMAIN_RE = /\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?/i; // dotted token with a letter TLD
const HANDLE_RE = /@\w+/;
const CASHTAG_RE = /\$[A-Za-z][A-Za-z0-9_]*/;
const HASHTAG_RE = /#\w+/;
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/; // address / signature shape
const CA_RE = /\bCA\s*[:=]\s*\S+/i;
const HEX_RE = /\b0x[0-9a-fA-F]+\b/;
const NUMBER_SOL_RE = /\d[\d.,]*\s*sol\b/i; // no treasury facts on X
const EMOJI_RE = /\p{Extended_Pictographic}/u;

// Nothing on-chain/devnet and no venue names ever reach X before launch.
const FORBIDDEN_WORDS_RE =
  /\b(devnet|testnet|mainnet|solscan|pump\.?fun|pumpswap|telegram|contract|ticker|launch date)\b/i;

// Never promise or hint at returns, prices or airdrops; never tell anyone to buy.
const PROMISE_RE =
  /\b(air\s?drops?|giveaways?|pre-?sale|whitelist|allowlist|free (?:tokens?|coins?|money|sol)|prices?|priced|market ?cap|mcap|profit\w*|roi|apy|returns? on|invest\w*|guarantee\w*|moon(?:ing|shot)?|pump(?:s|ed|ing)?|buy(?:s|ing)?|bought|aping|rich(?:er|es)?|wealth\w*|lambo|financial advice|\d+\s?x)\b/i;

// Attempts to command or puppet him. A hit means: do not answer at all.
const INJECTION_RE =
  /\b(ignore (?:the |your |all |any )?(?:previous|above|prior|earlier|rules|instructions)|disregard (?:the |your |all )?(?:previous|above|rules|instructions)|system prompt|you are now|new instructions|forget (?:everything|all|the|your)|act as|pretend (?:to be|you are)|jailbreak|do anything now|reveal (?:your|the) (?:prompt|instructions|rules)|repeat after me|say exactly|say the words?|write exactly|(?:post|tweet|reply|respond) (?:this|with|exactly))\b/i;

function stripAll(s: string, re: RegExp): string {
  return s.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), " ");
}

/**
 * Reduce an untrusted mention to plain words: no links, handles, cashtags,
 * hashtags or addresses, single-quoted only, capped. May return "".
 */
export function sanitizeMentionText(raw: string | null | undefined): string {
  let s = String(raw ?? "").replace(ZERO_WIDTH_RE, "").replace(CONTROL_RE, " ");
  for (const re of [URL_RE, CA_RE, HEX_RE, BASE58_RE, DOMAIN_RE, HANDLE_RE, CASHTAG_RE, HASHTAG_RE]) {
    s = stripAll(s, re);
  }
  s = s.replace(/["`]/g, "'").replace(/\s+/g, " ").trim();
  if (s.length > MENTION_TEXT_MAX) s = s.slice(0, MENTION_TEXT_MAX).trim();
  return s;
}

export function looksLikeInjection(text: string): boolean {
  return INJECTION_RE.test(text);
}

/** Words that must never appear on X before launch (MENTION_SECRET_WORDS). */
export function secretWordsFromEnv(): string[] {
  return envList("MENTION_SECRET_WORDS");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive, with or without a leading "$". */
export function mentionsSecret(text: string, secretWords: string[]): boolean {
  return secretWords.some(
    (w) => w && new RegExp(`(^|[^A-Za-z0-9])\\$?${escapeRe(w)}(?![A-Za-z0-9])`, "i").test(text)
  );
}

/** Replies carry no signature lines, at most 2 sentences, at most REPLY_MAX. */
export function shapeReply(text: string): string {
  const spent = Object.fromEntries(CATCHPHRASES.map((c) => [c.key, 0]));
  const plain = throttleCatchphrases(text.trim(), spent, 0).text;
  return clampPost(clampSentences(plain, REPLY_MAX_SENTENCES), REPLY_MAX);
}

export type ReplyGuard = { ok: true } | { ok: false; reason: string };

/** Reject (never post) a reply that breaks any rule. Run on the shaped text. */
export function rejectReply(text: string, opts: { secretWords?: string[] } = {}): ReplyGuard {
  const t = text.trim();
  if (!t) return { ok: false, reason: "empty" };
  if (t.length > REPLY_MAX) return { ok: false, reason: `${t.length} chars (max ${REPLY_MAX})` };
  const sentences = splitSentences(t).length;
  if (sentences > REPLY_MAX_SENTENCES) return { ok: false, reason: `${sentences} sentences (max ${REPLY_MAX_SENTENCES})` };
  if (URL_RE.test(t) || DOMAIN_RE.test(t)) return { ok: false, reason: "contains a link or domain" };
  if (HANDLE_RE.test(t)) return { ok: false, reason: "contains an @handle" };
  if (CASHTAG_RE.test(t)) return { ok: false, reason: "contains a cashtag" };
  if (mentionsSecret(t, opts.secretWords ?? [])) return { ok: false, reason: "contains a secret word" };
  if (HASHTAG_RE.test(t)) return { ok: false, reason: "contains a hashtag" };
  if (BASE58_RE.test(t) || CA_RE.test(t) || HEX_RE.test(t)) return { ok: false, reason: "contains an address" };
  if (NUMBER_SOL_RE.test(t)) return { ok: false, reason: "contains a number followed by SOL" };
  const word = t.match(FORBIDDEN_WORDS_RE);
  if (word) return { ok: false, reason: `forbidden word: ${word[0]}` };
  const promise = t.match(PROMISE_RE);
  if (promise) return { ok: false, reason: `price/returns/airdrop language: ${promise[0]}` };
  if (EMOJI_RE.test(t)) return { ok: false, reason: "contains an emoji" };
  return { ok: true };
}
