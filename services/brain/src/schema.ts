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
      const recips = d.params.recipients;
      const amounts = d.params.amounts;
      if (!Array.isArray(recips) || !Array.isArray(amounts)) {
        errs.push(`airdrop requires "recipients" and "amounts" arrays`);
        break;
      }
      if (recips.length !== amounts.length) {
        errs.push(`airdrop recipients/amounts length mismatch`);
      }
      if (recips.length === 0) {
        errs.push(`airdrop has no recipients`);
      }
      if (recips.length > avail.airdrop.max_recipients) {
        errs.push(
          `airdrop has ${recips.length} recipients (max ${avail.airdrop.max_recipients})`
        );
      }
      for (const r of recips) {
        if (typeof r !== "string" || !PUBKEY_RE.test(r)) {
          errs.push(`airdrop recipient "${String(r)}" is not a valid pubkey`);
        } else if (!allowed.has(r)) {
          errs.push(`airdrop recipient "${r}" is not from the briefing`);
        }
      }
      let sum = 0;
      for (const a of amounts) {
        if (!isPositiveInt(a)) {
          errs.push(`airdrop amount "${String(a)}" must be a positive integer`);
        } else {
          sum += a;
        }
      }
      if (sum > avail.airdrop.cap_lamports) {
        errs.push(`airdrop total ${sum} exceeds cap ${avail.airdrop.cap_lamports}`);
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
