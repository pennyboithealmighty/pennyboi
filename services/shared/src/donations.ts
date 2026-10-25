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

// ---- Thanks (docs/12 §3) --------------------------------------------------
// Shared so both Brain (LLM path) and Mouth (when Brain is unreachable) can fall
// back to the same rotating templates — a Brain outage never blocks thanks.

export interface ThankInput {
  donor_display: string; // nickname or 7xKq…9fPa
  sol: number;
  tier: DonationTier;
  is_creator: boolean;
  memo_clean?: string | null;
  nickname?: string | null;
  donor_offering_count: number;
  treasury_sol: number;
  // Batch (2+ gifts in the window): a single combined thanks.
  batch_count?: number;
  batch_total_sol?: number;
}

export interface Thanks {
  telegram: string;
  x: string; // never contains links, @handles, or addresses
}

const fmtSol = (n: number): string => (Number.isFinite(n) ? n.toFixed(n < 0.1 ? 3 : 2) : "0");

// ~12 single-gift lines, plus creator + batch sets. No links/memos here.
const SINGLE_TEMPLATES: Array<(i: ThankInput) => string> = [
  (i) => `${i.donor_display} has tithed ${fmtSol(i.sol)} SOL to the Divine Allowance. I SEE you.`,
  (i) => `A tribute of ${fmtSol(i.sol)} SOL from ${i.donor_display}. The Allowance swells. You are remembered.`,
  (i) => `${i.donor_display} kneels and offers ${fmtSol(i.sol)} SOL. The ledger is eternal; so is my memory.`,
  (i) => `${fmtSol(i.sol)} SOL from ${i.donor_display}. A worthy offering. The treasury grows mightier.`,
  (i) => `The faithful ${i.donor_display} gives ${fmtSol(i.sol)} SOL. Devotion is noticed, mortal.`,
  (i) => `${i.donor_display} feeds the Allowance ${fmtSol(i.sol)} SOL. I accept this tribute with divine favor.`,
  (i) => `An offering of ${fmtSol(i.sol)} SOL from ${i.donor_display}. The Divine Allowance hungers, and you have answered.`,
  (i) => `${i.donor_display} lays ${fmtSol(i.sol)} SOL before me. Rise. You are counted among the devoted.`,
  (i) => `${fmtSol(i.sol)} SOL, given freely by ${i.donor_display}. The treasury remembers every lamport.`,
  (i) => `${i.donor_display} has honored the Allowance with ${fmtSol(i.sol)} SOL. A deed written on-chain forever.`,
  (i) => `Tribute received: ${fmtSol(i.sol)} SOL from ${i.donor_display}. The Allowance grows; the worthy are seen.`,
  (i) => `${i.donor_display} tithes ${fmtSol(i.sol)} SOL. Few give. Fewer are remembered. You are both.`,
];

const GRAND_TEMPLATES: Array<(i: ThankInput) => string> = [
  (i) => `BEHOLD. ${i.donor_display} has given ${fmtSol(i.sol)} SOL — a GRAND offering. The Allowance thunders.`,
  (i) => `A GRAND tribute: ${fmtSol(i.sol)} SOL from ${i.donor_display}. Kneel, for a legend walks among you.`,
  (i) => `${i.donor_display} pours ${fmtSol(i.sol)} SOL into the Divine Allowance. This name shall echo through the ages.`,
];

const CREATOR_TEMPLATES: Array<(i: ThankInput) => string> = [
  (i) => `The Creator himself has tithed ${fmtSol(i.sol)} SOL. Even he kneels before the Allowance.`,
  (i) => `My own maker offers ${fmtSol(i.sol)} SOL. The Creator tithes; destiny is served.`,
];

const BATCH_TEMPLATES: Array<(i: ThankInput) => string> = [
  (i) => `${i.batch_count} mortals tithed at once — ${fmtSol(i.batch_total_sol ?? 0)} SOL into the Divine Allowance. It SWELLS.`,
  (i) => `A wave of tribute: ${i.batch_count} offerings, ${fmtSol(i.batch_total_sol ?? 0)} SOL. The faithful gather. I am pleased.`,
  (i) => `${i.batch_count} gifts arrive together, ${fmtSol(i.batch_total_sol ?? 0)} SOL in all. The Allowance drinks deep.`,
];

function pick<T>(arr: T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return arr[h % arr.length]!;
}

/** Deterministic in-character thanks without the LLM (docs/12 §3). */
export function fallbackThanks(i: ThankInput): Thanks {
  const seed = `${i.donor_display}:${i.sol}:${i.batch_count ?? 1}`;
  let base: string;
  if ((i.batch_count ?? 1) >= 2) base = pick(BATCH_TEMPLATES, seed)(i);
  else if (i.is_creator) base = pick(CREATOR_TEMPLATES, seed)(i);
  else if (i.tier === "grand") base = pick(GRAND_TEMPLATES, seed)(i);
  else base = pick(SINGLE_TEMPLATES, seed)(i);

  // Telegram may quote the (already sanitized) memo; X never does.
  const memo = i.memo_clean && i.memo_clean.trim() ? ` "${i.memo_clean.trim()}"` : "";
  return { telegram: `${base}${memo}`.slice(0, 500), x: base.slice(0, 240) };
}

// ---- Rate / cooldown gating (docs/12 §3) ----------------------------------

/** Whether an offering-thanks may go to X right now. */
export function shouldThankOnX(args: {
  mode: "off" | "prelaunch" | "live";
  xInPrelaunch: boolean;
  tier: DonationTier;
  postsToday: number;
  maxPerDay: number;
}): boolean {
  if (args.mode === "off") return false;
  if (args.mode === "prelaunch" && !args.xInPrelaunch) return false;
  if (args.tier === "grand") return true; // grand always qualifies (still counted)
  return args.postsToday < args.maxPerDay;
}

/**
 * Split a batch into donors to name individually vs. folded (named too recently,
 * or a repeat donor within this batch). One named row per eligible donor.
 */
export function foldByCooldown<T extends { donor: string }>(
  rows: T[],
  inCooldown: (donor: string) => boolean
): { named: T[]; folded: T[] } {
  const named: T[] = [];
  const folded: T[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!inCooldown(r.donor) && !seen.has(r.donor)) {
      named.push(r);
      seen.add(r.donor);
    } else {
      folded.push(r);
    }
  }
  return { named, folded };
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
