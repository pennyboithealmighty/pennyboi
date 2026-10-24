// Layer 3 part 2 — the decision loop. Call the LLM, parse strictly, validate
// against the briefing. On any failure (network, parse, or validation) retry
// ONCE with the specific error appended; if it still fails, fall back to action
// "none" with the stock sulk line. This keeps the agent hands-off: it never
// blocks and never emits an invalid action.

import { renderBriefing, type Briefing } from "@pennyboi/shared";
import { parseDecision, validateDecision, type Decision } from "./schema.js";
import { STOCK_SULK, SYSTEM_PROMPT } from "./system-prompt.js";

/** Pluggable LLM call (injected for tests). */
export type CallLLM = (system: string, user: string) => Promise<string>;

export interface DecideInput {
  briefing: Briefing;
  /** Pre-rendered user message from Eyes; rendered from the briefing if absent. */
  text?: string;
  callLLM: CallLLM;
}

export interface DecideResult {
  decision: Decision;
  attempts: number;
  fellBack: boolean;
  errors: string[];
  raw?: string;
}

export function fallbackDecision(): Decision {
  return {
    action: "none",
    params: {},
    reasoning: "LLM failed to produce a valid decision after one retry; defaulting to none.",
    narration: STOCK_SULK,
  };
}

export async function decide(input: DecideInput): Promise<DecideResult> {
  const baseUser = input.text ?? renderBriefing(input.briefing);
  const allErrors: string[] = [];
  let lastRaw: string | undefined;

  // attempt 0 = first try; attempt 1 = one retry with the error appended.
  for (let attempt = 0; attempt <= 1; attempt++) {
    const user =
      attempt === 0
        ? baseUser
        : `${baseUser}\n\n---\nYour previous response was rejected: ${allErrors[allErrors.length - 1]}\nRespond again with ONLY the JSON object, no prose.`;

    let raw: string;
    try {
      raw = await input.callLLM(SYSTEM_PROMPT, user);
      lastRaw = raw;
    } catch (e) {
      allErrors.push(`LLM call failed: ${(e as Error).message}`);
      continue;
    }

    const parsed = parseDecision(raw);
    if (!parsed.ok) {
      allErrors.push(parsed.error);
      continue;
    }

    const vErrors = validateDecision(parsed.decision, input.briefing);
    if (vErrors.length > 0) {
      allErrors.push(vErrors.join("; "));
      continue;
    }

    return {
      decision: parsed.decision,
      attempts: attempt + 1,
      fellBack: false,
      errors: allErrors,
      raw,
    };
  }

  return {
    decision: fallbackDecision(),
    attempts: 2,
    fellBack: true,
    errors: allErrors,
    raw: lastRaw,
  };
}
