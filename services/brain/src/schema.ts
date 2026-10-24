// Layer 3 part 1 — strict parse + validation of the LLM's decision against the
// briefing (docs/04). Hands re-validates against on-chain truth before signing;
// this is the first line of defense.

import type { Briefing } from "@pennyboi/shared";

export const NARRATION_MAX = 280;
export const MEMO_MAX = 140;

export type ActionKind = "burn" | "airdrop" | "bounty" | "none";
const ACTIONS: ActionKind[] = ["burn", "airdrop", "bounty", "none"];

export interface Decision {
  action: ActionKind;
  params: Record<string, unknown>;
  reasoning: string;
  narration: string;
}

export type ParseResult =
  | { ok: true; decision: Decision }
  | { ok: false; error: string };

/** Pull a JSON object out of the raw model text, tolerating code fences. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1]! : raw).trim();
  return body;
}

export function parseDecision(raw: string): ParseResult {
  let obj: unknown;
  try {
    obj = JSON.parse(extractJson(raw));
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, error: "top-level value must be a JSON object" };
  }
  const o = obj as Record<string, unknown>;

  if (typeof o.action !== "string" || !ACTIONS.includes(o.action as ActionKind)) {
    return { ok: false, error: `"action" must be one of ${ACTIONS.join(", ")}` };
  }
  if (typeof o.narration !== "string" || o.narration.trim() === "") {
    return { ok: false, error: `"narration" must be a non-empty string` };
  }
  const params =
    o.params && typeof o.params === "object" && !Array.isArray(o.params)
      ? (o.params as Record<string, unknown>)
      : {};
  const reasoning = typeof o.reasoning === "string" ? o.reasoning : "";

  return {
    ok: true,
    decision: {
      action: o.action as ActionKind,
      params,
      reasoning,
      narration: o.narration,
    },
  };
}

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Every wallet address that legitimately appears in the briefing. */
export function allowedPubkeys(b: Briefing): Set<string> {
  const s = new Set<string>();
  for (const x of b.since_last_threshold.top_new_buyers) s.add(x.wallet);
  for (const x of b.since_last_threshold.biggest_sellers) s.add(x.wallet);
  for (const x of b.offerings_from_telegram) s.add(x.wallet);
  for (const x of b.grudges) s.add(x.wallet);
  for (const x of b.loyal) s.add(x.wallet);
  return s;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Validate a parsed decision against the briefing. Returns a list of errors;
 * empty means valid.
 */
export function validateDecision(d: Decision, b: Briefing): string[] {
  const errs: string[] = [];

  if (d.narration.length > NARRATION_MAX) {
    errs.push(`narration is ${d.narration.length} chars (max ${NARRATION_MAX})`);
  }

  const avail = b.available_actions;
  const allowed = allowedPubkeys(b);

  switch (d.action) {
    case "none":
      // Always permitted.
      break;

    case "burn": {
      if (!avail.burn) {
        errs.push(`"burn" is not in available_actions`);
        break;
      }
      const amt = d.params.amount_lamports;
      if (!isPositiveInt(amt)) {
        errs.push(`burn.amount_lamports must be a positive integer`);
      } else if (amt > avail.burn.cap_lamports) {
        errs.push(`burn.amount_lamports ${amt} exceeds cap ${avail.burn.cap_lamports}`);
      }
      break;
    }

    case "airdrop": {
      if (!avail.airdrop) {
        errs.push(`"airdrop" is not in available_actions`);
        break;
      }
      // docs/11 §3: the model only picks `favored` (0..favored_max) from
      // `favored_candidates`. Code draws the rest of the pool by fortune and
      // sets the amounts — the model supplies no recipients/amounts.
      const favored = d.params.favored ?? [];
      if (!Array.isArray(favored)) {
        errs.push(`airdrop.favored must be an array of pubkeys (may be empty)`);
        break;
      }
      const favoredMax = avail.airdrop.favored_max ?? 0;
      if (favored.length > favoredMax) {
        errs.push(`airdrop has ${favored.length} favored (max ${favoredMax})`);
      }
      const candidates = new Set((avail.airdrop.favored_candidates ?? []).map((c) => c.wallet));
      const seen = new Set<string>();
      for (const w of favored) {
        if (typeof w !== "string" || !PUBKEY_RE.test(w)) {
          errs.push(`airdrop favored "${String(w)}" is not a valid pubkey`);
          continue;
        }
        if (!candidates.has(w)) {
          errs.push(`airdrop favored "${w}" is not in favored_candidates`);
        }
        if (seen.has(w)) {
          errs.push(`airdrop favored "${w}" is duplicated`);
        }
        seen.add(w);
      }
      break;
    }

    case "bounty": {
      if (!avail.bounty) {
        errs.push(`"bounty" is not in available_actions`);
        break;
      }
      const to = d.params.to;
      const amt = d.params.amount_lamports;
      const memo = d.params.memo;
      if (typeof to !== "string" || !PUBKEY_RE.test(to)) {
        errs.push(`bounty.to must be a valid pubkey`);
      } else if (!allowed.has(to)) {
        errs.push(`bounty.to "${to}" is not from the briefing`);
      }
      if (!isPositiveInt(amt)) {
        errs.push(`bounty.amount_lamports must be a positive integer`);
      } else if (amt > avail.bounty.cap_lamports) {
        errs.push(`bounty.amount_lamports ${amt} exceeds cap ${avail.bounty.cap_lamports}`);
      }
      if (typeof memo !== "string") {
        errs.push(`bounty.memo must be a string`);
      } else if (Buffer.byteLength(memo, "utf8") > MEMO_MAX) {
        errs.push(`bounty.memo exceeds ${MEMO_MAX} bytes`);
      }
      break;
    }
  }

  return errs;
}
