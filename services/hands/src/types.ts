// Wire types for the decision Hands receives and the result it returns.

export type ActionKind = "burn" | "airdrop" | "bounty" | "none";

/** The decision as it arrives from the Brain (over HTTP). */
export interface Decision {
  action: ActionKind;
  params: Record<string, unknown>;
  reasoning?: string;
  narration?: string;
}

export type ExecStatus =
  | "submitted" // signed + sent + confirmed on-chain
  | "skipped" // action "none" — nothing to submit
  | "paused" // kill switch engaged
  | "invalid" // failed on-chain re-validation
  | "failed"; // submission/confirmation threw

export interface ExecResult {
  status: ExecStatus;
  action: ActionKind;
  signature?: string;
  solscanUrl?: string;
  error?: string;
}
