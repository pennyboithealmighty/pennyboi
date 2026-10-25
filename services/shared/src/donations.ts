// Offerings = SOL gifts to the Divine Allowance (docs/12). Pure, testable logic
// shared across Eyes (classify + record), Mouth (thanks), and the public API:
// who counts as a donor vs a fee source, which tier a gift falls in, and how a
// donor's optional memo is sanitized before it is ever shown or sent to the LLM.
//
// RULE (docs/12 §0): nothing here reads the airdrop pool, and nothing in the
// airdrop pool reads donations — an offering never affects eligibility.

import { envBool, envNum, envStr } from "./env.js";
import { solToLamports } from "./solana.js";

// ---- Classification (docs/12 §1) ------------------------------------------

export type DonationClass = "fee" | "offering" | "ignore";

export interface ClassifyContext {
  admin: string;
  agent: string;
  internal: Set<string>; // the vault's own PDAs (config/treasury/fees/burn)
  feeSources: Set<string>; // FEE_SOURCE_WALLETS (incl. the devnet mock-fee-feed)
  creatorTithes: Set<string>; // CREATOR_TITHE_WALLETS
}

export interface Classification {
  cls: DonationClass;
  isCreator: boolean;
}

/** Decide whether a transfer into the FeeReceiver is a fee, an offering, or internal noise. */
export function classifyDonor(donor: string, ctx: ClassifyContext): Classification {
  if (!donor) return { cls: "ignore", isCreator: false };
  if (donor === ctx.agent || ctx.internal.has(donor)) return { cls: "ignore", isCreator: false };
  if (ctx.feeSources.has(donor)) return { cls: "fee", isCreator: false };
  if (donor === ctx.admin || ctx.creatorTithes.has(donor)) return { cls: "offering", isCreator: true };
  return { cls: "offering", isCreator: false };
}

// ---- Tiers (docs/12 §1) ---------------------------------------------------

export type DonationTier = "dust" | "offering" | "grand";

export function tierFor(lamports: number, minAnnounceLamports: number, grandLamports: number): DonationTier {
  if (lamports >= grandLamports) return "grand";
  if (lamports < minAnnounceLamports) return "dust";
  return "offering";
}

// ---- Display name (docs/12 §3) --------------------------------------------

/** `7xKq…9fPa` — first 4 + last 4 of the address. */
export function shortDonor(addr: string): string {
  return addr.length > 8 ? addr.slice(0, 4) + "…" + addr.slice(-4) : addr;
}

export function donorDisplay(donor: string, nickname?: string | null): { display: string; short: string } {
  const short = shortDonor(donor);
  const nick = nickname && nickname.trim() ? nickname.trim() : null;
  return { display: nick ?? short, short };
}

// ---- Memo safety (docs/12 §2) ---------------------------------------------
// Memos are untrusted public input. We strip risky tokens, cap length, and drop
// the memo entirely on a prompt-injection or blocklist hit.

const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const TME_RE = /\bt\.me\/?\S*/gi;
const CA_RE = /\bCA\s*[:=]?\s*[1-9A-HJ-NP-Za-km-z]{6,}/gi;
const HEX_RE = /\b0x[0-9a-fA-F]+\b/g;
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g; // address / signature shape
const DOMAIN_RE = /\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?/gi; // dotted token with a letter TLD
const MENTION_RE = /@\w+/g;

const INJECTION_RE =
  /\b(ignore (?:the )?(?:previous|above|prior|earlier|all)|disregard (?:the )?(?:previous|above|all)|system prompt|you are now|new instructions|forget (?:everything|all|the|your)|act as|pretend to be|jailbreak|do anything now|reveal (?:your|the) (?:prompt|instructions))\b/i;

// A deliberately small, obvious blocklist; extend via OFFERING_MEMO_BLOCK env.
const DEFAULT_BLOCK = ["nigger", "faggot", "retard", "kike", "spic", "chink", "tranny"];

export const MEMO_MAX = 80;

export function sanitizeMemo(raw: string | null | undefined, extraBlock: string[] = []): string | null {
  if (raw == null) return null;
  let s = String(raw).replace(ZERO_WIDTH_RE, "").replace(CONTROL_RE, " ").trim();
  if (!s) return null;

  // Drop entirely on injection or blocklist.
  if (INJECTION_RE.test(s)) return null;
  const block = [...DEFAULT_BLOCK, ...extraBlock];
  const lower = s.toLowerCase();
  if (block.some((w) => w && lower.includes(w))) return null;

  // Strip risky tokens (order matters: URLs/handles/addresses before domains).
  s = s
    .replace(URL_RE, " ")
    .replace(TME_RE, " ")
    .replace(CA_RE, " ")
    .replace(HEX_RE, " ")
    .replace(BASE58_RE, " ")
    .replace(DOMAIN_RE, " ")
    .replace(MENTION_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  if (s.length > MEMO_MAX) s = s.slice(0, MEMO_MAX).trim();
  return s || null;
}

// ---- Env config (docs/12 §6) ----------------------------------------------

export function envList(name: string): string[] {
  return envStr(name)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export interface OfferingConfig {
  minAnnounceLamports: number;
  grandLamports: number;
  batchSecs: number;
  xMaxPerDay: number;
  xInPrelaunch: boolean;
  donorCooldownSecs: number;
  feeSources: Set<string>;
  creatorTithes: Set<string>;
  memoBlock: string[];
}

export function offeringConfig(): OfferingConfig {
  return {
    minAnnounceLamports: solToLamports(envNum("OFFERING_MIN_ANNOUNCE_SOL", 0.01)),
    grandLamports: solToLamports(envNum("OFFERING_GRAND_SOL", 1)),
    batchSecs: envNum("OFFERING_BATCH_SECS", 120),
    xMaxPerDay: envNum("OFFERING_X_MAX_PER_DAY", 4),
    xInPrelaunch: envBool("OFFERING_X_IN_PRELAUNCH", false),
    donorCooldownSecs: envNum("OFFERING_DONOR_COOLDOWN_SECS", 21_600),
    feeSources: new Set(envList("FEE_SOURCE_WALLETS")),
    creatorTithes: new Set(envList("CREATOR_TITHE_WALLETS")),
    memoBlock: envList("OFFERING_MEMO_BLOCK"),
  };
}
