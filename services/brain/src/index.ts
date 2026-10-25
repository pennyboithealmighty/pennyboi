// @pennyboi/brain — entrypoint.
// HTTP endpoint that turns a situation briefing into a validated decision.
// Eyes POSTs here (BRAIN_URL); the decision is optionally forwarded to Hands
// (HANDS_URL), which re-validates against on-chain state before signing.

import express, { type Request, type Response } from "express";
import { envNum, envStr, type Briefing } from "@pennyboi/shared";
import { anthropicSettings, makeAnthropicCaller } from "./anthropic.js";
import { decide, type CallLLM } from "./decide.js";
import { generateProphecy, type ProphecyInput } from "./prophecy.js";
import { generateThank } from "./thank.js";
import { fallbackThanks, type ThankInput } from "@pennyboi/shared";
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

  // X pre-launch "Prophecy" generation (docs/09). Mouth schedules + sanitizes;
  // Brain just produces the in-character post text.
  app.post("/prophecy", async (req: Request, res: Response) => {
    const body = req.body as Partial<ProphecyInput>;
    if (!body?.theme || !body?.mood) {
      return res.status(400).json({ ok: false, error: "missing mood/theme" });
    }
    let callLLM: CallLLM;
    try {
      callLLM = getCaller();
    } catch (e) {
      return res.status(503).json({ ok: false, error: (e as Error).message });
    }
    const result = await generateProphecy(
      {
        mood: body.mood,
        theme: body.theme,
        daysUntilAwakening: body.daysUntilAwakening ?? null,
        recentPosts: Array.isArray(body.recentPosts) ? body.recentPosts : [],
      },
      callLLM
    );
    log.info(`prophecy: ${result.prophecy ? "generated" : "SKIPPED"} (attempts=${result.attempts})`);
    for (const a of result.attemptsLog) {
      if (a.ok) continue;
      log.warn(`prophecy attempt ${a.attempt} rejected: ${a.error}`);
      log.warn(`prophecy attempt ${a.attempt} raw:\n${a.raw ?? "(no response — the API call threw)"}`);
    }
    res.json({ ok: true, prophecy: result.prophecy, attempts: result.attempts });
  });

  // Offering thanks (docs/12 §3). Mouth POSTs the offering context; Brain
  // returns { telegram, x }. Falls back to templates if the LLM key is missing
  // or the call fails, so thanks are never blocked.
  app.post("/thank", async (req: Request, res: Response) => {
    const input = req.body as ThankInput;
    if (!input || typeof input.sol !== "number" || typeof input.donor_display !== "string") {
      return res.status(400).json({ ok: false, error: "missing offering input" });
    }
    let callLLM: CallLLM;
    try {
      callLLM = getCaller();
    } catch {
      // No key — still thank them with templates.
      return res.json({ ok: true, thanks: fallbackThanks(input), fellBack: true });
    }
    const result = await generateThank(input, callLLM);
    log.info(`thank: ${result.fellBack ? "TEMPLATE" : "generated"} (attempts=${result.attempts})`);
    res.json({ ok: true, thanks: result.thanks, fellBack: result.fellBack });
  });

  app.listen(port, () => {
    log.info(`brain listening on :${port} (POST /decide, /prophecy, /thank, GET /health), model=${settings.model}`);
    if (!envStr("ANTHROPIC_API_KEY")) {
      log.warn("ANTHROPIC_API_KEY not set — /decide will return 503 until configured.");
    }
  });
}

main();
