// @pennyboi/brain — entrypoint.
// HTTP endpoint that turns a situation briefing into a validated decision.
// Eyes POSTs here (BRAIN_URL); the decision is optionally forwarded to Hands
// (HANDS_URL), which re-validates against on-chain state before signing.

import express, { type Request, type Response } from "express";
import { envNum, envStr, type Briefing } from "@pennyboi/shared";
import { anthropicSettings, makeAnthropicCaller } from "./anthropic.js";
import { decide, type CallLLM } from "./decide.js";
import { log } from "./log.js";

function getCaller(): CallLLM {
  // Created once, lazily, so the server can boot without a key (returns 503).
  if (!cachedCaller) cachedCaller = makeAnthropicCaller();
  return cachedCaller;
}
let cachedCaller: CallLLM | null = null;

async function forwardToHands(payload: unknown): Promise<void> {
  const url = envStr("HANDS_URL");
  if (!url) {
    log.info("HANDS_URL not set — decision not forwarded (Hands lands in Step 4).");
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    log.info(`forwarded decision to Hands (${res.status})`);
  } catch (e) {
    log.error("failed to forward decision to Hands", e);
  }
}

function main(): void {
  const port = envNum("BRAIN_PORT", 8788);
  const settings = anthropicSettings();

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "brain", model: settings.model });
  });

  app.post("/decide", async (req: Request, res: Response) => {
    const body = req.body as { briefing?: Briefing; text?: string };
    if (!body?.briefing || typeof body.briefing !== "object") {
      return res.status(400).json({ ok: false, error: "missing briefing" });
    }

    let callLLM: CallLLM;
    try {
      callLLM = getCaller();
    } catch (e) {
      return res.status(503).json({ ok: false, error: (e as Error).message });
    }

    const result = await decide({
      briefing: body.briefing,
      text: body.text,
      callLLM,
    });

    log.info(
      `decision: ${result.decision.action} (attempts=${result.attempts}, fellBack=${result.fellBack})`
    );
    // Log the raw model output + rejection reason for any attempt that failed,
    // so a fallback-to-none can be diagnosed. Logs only; never sent to Telegram.
    for (const a of result.attemptsLog) {
      if (a.ok) continue;
      log.warn(`attempt ${a.attempt} rejected: ${a.error}`);
      log.warn(`attempt ${a.attempt} raw LLM output:\n${a.raw ?? "(no response — the API call threw)"}`);
    }

    // Forward in the background; still return the decision to the caller.
    void forwardToHands({ briefing: body.briefing, decision: result.decision });

    res.json({ ok: true, ...result });
  });

  app.listen(port, () => {
    log.info(`brain listening on :${port} (POST /decide, GET /health), model=${settings.model}`);
    if (!envStr("ANTHROPIC_API_KEY")) {
      log.warn("ANTHROPIC_API_KEY not set — /decide will return 503 until configured.");
    }
  });
}

main();
