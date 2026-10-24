// Deliver a built briefing to the Brain. For now: always log it, and POST it to
// BRAIN_URL if that env var is set (the Brain service arrives in Step 3).

import { envStr, renderBriefing, type Briefing } from "@pennyboi/shared";
import type { Logger } from "./log.js";

export type BriefingHandler = (b: Briefing) => Promise<void> | void;

export function makeHandoff(log: Logger): BriefingHandler {
  const brainUrl = envStr("BRAIN_URL");
  return async (b: Briefing) => {
    const text = renderBriefing(b);
    log.info(`threshold ${b.treasury.threshold_step} — mood=${b.mood}, balance=${b.treasury.balance_sol} SOL`);
    log.debug("briefing text:\n" + text);
    if (!brainUrl) {
      log.info("BRAIN_URL not set — briefing not forwarded (Brain lands in Step 3).");
      return;
    }
    try {
      const res = await fetch(brainUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ briefing: b, text }),
      });
      log.info(`forwarded briefing to Brain (${res.status})`);
    } catch (e) {
      log.error("failed to forward briefing to Brain", e);
    }
  };
}
