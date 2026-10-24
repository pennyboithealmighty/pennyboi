// HTTP endpoint Hands posts to after an action (MOUTH_URL=/narrate), plus a
// health check. Announces in #general + X, records the action, and extracts
// nickname/grudge/loyalty memory from the narration + action (docs/04 step 6).

import { extractMemory, type Briefing } from "@pennyboi/shared";
import express, { type Express, type Request, type Response } from "express";
import { announce } from "./announce.js";
import type { MouthCtx } from "./deps.js";
import { registerPublicApi } from "./public-api.js";

interface NarratePayload {
  decision?: {
    action?: string;
    params?: Record<string, unknown>;
    reasoning?: string;
    narration?: string;
  };
  result?: { status?: string; signature?: string; solscanUrl?: string };
  briefing?: Briefing;
  narration?: string;
}

export function createNarrateServer(m: MouthCtx): Express {
  const app = express();
  app.use(express.json({ limit: "512kb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "mouth" });
  });

  // Additive read-only public API for the website. Wrapped so a failure here can
  // never take down /narrate or affect the bot.
  try {
    registerPublicApi(app, { db: m.db, chain: m.chain, cfg: m.cfg, log: m.log });
  } catch (e) {
    m.log.error("failed to register public API (bot unaffected)", e);
  }

  app.post("/narrate", async (req: Request, res: Response) => {
    const b = req.body as NarratePayload;
    const narration = b.narration ?? b.decision?.narration ?? "";
    if (!narration) return res.status(400).json({ ok: false, error: "no narration" });

    const action = b.decision?.action ?? "none";
    const status = b.result?.status ?? "narrated";
    const now = Math.floor(Date.now() / 1000);

    await announce(m, {
      narration,
      action,
      status,
      signature: b.result?.signature,
      solscanUrl: b.result?.solscanUrl,
    });

    // Record the action row (full fields when the briefing is present).
    m.db.recordAction({
      now,
      thresholdStep: b.briefing?.treasury.threshold_step,
      mood: b.briefing?.mood,
      action,
      paramsJson: b.decision?.params ? JSON.stringify(b.decision.params) : undefined,
      reasoning: b.decision?.reasoning,
      narration,
      txSig: b.result?.signature,
      status,
    });

    // Extract loyalty/grudges/nicknames — only for actions that actually ran.
    if (status === "submitted" || action !== "none") {
      const update = extractMemory(
        { action, params: b.decision?.params ?? {}, narration },
        b.briefing
      );
      m.db.applyMemoryUpdate(update, now);
      if (update.loyal.length || update.grudges.length) {
        m.log.info(`memory: +${update.loyal.length} loyal, +${update.grudges.length} grudge`);
      }
    }

    res.json({ ok: true });
  });

  return app;
}
