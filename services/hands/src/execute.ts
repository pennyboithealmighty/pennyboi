// The execute loop: decide whether to submit, re-validate against fresh chain
// state, submit, and classify the outcome. Dependencies are injected so the
// branching (paused / none / invalid / submit / failed) is unit-testable without
// a chain.

import type { VaultConfig } from "@pennyboi/shared";
import type { AirdropResolution, AirdropResolved } from "./airdrop-resolve.js";
import { validateOnchain } from "./validate.js";
import type { Decision, ExecResult } from "./types.js";

export interface ExecDeps {
  getConfig: () => Promise<VaultConfig>;
  submit: (d: Decision) => Promise<string>; // returns tx signature
  isPaused: () => boolean;
  solscan: (sig: string) => string;
  nowSecs?: () => number;
  // Airdrop only (docs/11): turn `favored` into concrete recipients + amounts
  // from the recorded pool snapshot, and record the round once it lands.
  resolveAirdrop?: (d: Decision, cfg: VaultConfig) => AirdropResolution;
  onAirdropResult?: (resolved: AirdropResolved, signature: string) => void;
}

export async function executeDecision(d: Decision, deps: ExecDeps): Promise<ExecResult> {
  const now = (deps.nowSecs ?? (() => Math.floor(Date.now() / 1000)))();

  if (d.action === "none") {
    return { status: "skipped", action: "none" };
  }

  // Kill switch: Pennyboi keeps talking (Mouth), but nothing moves on-chain.
  if (deps.isPaused()) {
    return { status: "paused", action: d.action };
  }

  let cfg: VaultConfig;
  try {
    cfg = await deps.getConfig();
  } catch (e) {
    return { status: "failed", action: d.action, error: `config read failed: ${(e as Error).message}` };
  }

  // Airdrop: resolve `favored` into recipients + amounts from the recorded pool
  // snapshot + seed before re-validating and submitting.
  let exec = d;
  let airdrop: AirdropResolved | undefined;
  if (d.action === "airdrop" && deps.resolveAirdrop) {
    const r = deps.resolveAirdrop(d, cfg);
    if (!r.ok) {
      return { status: "invalid", action: "airdrop", error: r.error };
    }
    airdrop = r.resolved;
    exec = { ...d, params: { ...d.params, recipients: r.resolved.recipients, amounts: r.resolved.amounts } };
  }

  const errs = validateOnchain(exec, cfg, now);
  if (errs.length > 0) {
    return { status: "invalid", action: exec.action, error: errs.join("; ") };
  }

  try {
    const signature = await deps.submit(exec);
    if (airdrop && deps.onAirdropResult) deps.onAirdropResult(airdrop, signature);
    return {
      status: "submitted",
      action: exec.action,
      signature,
      solscanUrl: deps.solscan(signature),
    };
  } catch (e) {
    return { status: "failed", action: exec.action, error: (e as Error).message };
  }
}
