// The execute loop: decide whether to submit, re-validate against fresh chain
// state, submit, and classify the outcome. Dependencies are injected so the
// branching (paused / none / invalid / submit / failed) is unit-testable without
// a chain.

import type { VaultConfig } from "@pennyboi/shared";
import { validateOnchain } from "./validate.js";
import type { Decision, ExecResult } from "./types.js";

export interface ExecDeps {
  getConfig: () => Promise<VaultConfig>;
  submit: (d: Decision) => Promise<string>; // returns tx signature
  isPaused: () => boolean;
  solscan: (sig: string) => string;
  nowSecs?: () => number;
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

  const errs = validateOnchain(d, cfg, now);
  if (errs.length > 0) {
    return { status: "invalid", action: d.action, error: errs.join("; ") };
  }

  try {
    const signature = await deps.submit(d);
    return {
      status: "submitted",
      action: d.action,
      signature,
      solscanUrl: deps.solscan(signature),
    };
  } catch (e) {
    return { status: "failed", action: d.action, error: (e as Error).message };
  }
}
