// Authoritative on-chain re-validation (defense in depth). The Brain already
// validated against the briefing; here we re-check against a FRESH read of the
// Config account before signing. The program enforces all of this a third time
// on-chain — this layer just avoids wasting a tx on a sure-reject.

import { computeAvailableActions, type VaultConfig } from "@pennyboi/shared";
import type { Decision } from "./types.js";

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MEMO_MAX = 140;

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** Returns a list of errors; empty means the decision is safe to submit. */
export function validateOnchain(
  d: Decision,
  cfg: VaultConfig,
  nowSecs: number
): string[] {
  if (d.action === "none") return [];

  const errs: string[] = [];
  if (!cfg.actionAvailable) {
    errs.push("action flag is not set on-chain (no threshold pending)");
  }
  const avail = computeAvailableActions(cfg, nowSecs);

  switch (d.action) {
    case "burn": {
      if (!avail.burn) errs.push("burn is on cooldown");
      const amt = d.params.amount_lamports;
      if (!isPositiveInt(amt)) errs.push("burn.amount_lamports must be a positive integer");
      else if (amt > cfg.burnCapLamports) errs.push(`burn amount ${amt} exceeds cap ${cfg.burnCapLamports}`);
      break;
    }
    case "airdrop": {
      if (!avail.airdrop) errs.push("airdrop is on cooldown");
      const recips = d.params.recipients;
      const amounts = d.params.amounts;
      if (!Array.isArray(recips) || !Array.isArray(amounts)) {
        errs.push("airdrop requires recipients[] and amounts[]");
        break;
      }
      if (recips.length !== amounts.length) errs.push("airdrop recipients/amounts length mismatch");
      if (recips.length === 0) errs.push("airdrop has no recipients");
      if (recips.length > cfg.airdropMaxRecipients) {
        errs.push(`airdrop has ${recips.length} recipients (max ${cfg.airdropMaxRecipients})`);
      }
      for (const r of recips) {
        if (typeof r !== "string" || !PUBKEY_RE.test(r)) errs.push(`invalid recipient pubkey: ${String(r)}`);
      }
      let sum = 0;
      for (const a of amounts) {
        if (!isPositiveInt(a)) errs.push(`invalid airdrop amount: ${String(a)}`);
        else sum += a;
      }
      if (sum > cfg.airdropCapLamports) errs.push(`airdrop total ${sum} exceeds cap ${cfg.airdropCapLamports}`);
      break;
    }
    case "bounty": {
      if (!avail.bounty) errs.push("bounty is on cooldown");
      const to = d.params.to;
      const amt = d.params.amount_lamports;
      const memo = d.params.memo;
      if (typeof to !== "string" || !PUBKEY_RE.test(to)) errs.push("bounty.to must be a valid pubkey");
      if (!isPositiveInt(amt)) errs.push("bounty.amount_lamports must be a positive integer");
      else if (amt > cfg.bountyCapLamports) errs.push(`bounty amount ${amt} exceeds cap ${cfg.bountyCapLamports}`);
      if (typeof memo !== "string") errs.push("bounty.memo must be a string");
      else if (Buffer.byteLength(memo, "utf8") > MEMO_MAX) errs.push(`bounty.memo exceeds ${MEMO_MAX} bytes`);
      break;
    }
  }

  return errs;
}
