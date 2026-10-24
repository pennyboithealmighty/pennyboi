// HTTP endpoint Hands posts to after an action (MOUTH_URL=/narrate), plus a
// health check. Turns a {decision, result} into a #general announcement + X post.

import express, { type Express, type Request, type Response } from "express";
import { announce } from "./announce.js";
import type { MouthCtx } from "./deps.js";

interface NarratePayload {
  decision?: { action?: string; narration?: string };
  result?: { status?: string; signature?: string; solscanUrl?: string };
  narration?: string;
}

export function createNarrateServer(m: MouthCtx): Express {
  const app = express();
  app.use(express.json({ limit: "512kb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "mouth" });
  });

  app.post("/narrate", async (req: Request, res: Response) => {
    const b = req.body as NarratePayload;
    const narration = b.narration ?? b.decision?.narration ?? "";
    if (!narration) return res.status(400).json({ ok: false, error: "no narration" });

    await announce(m, {
      narration,
      action: b.decision?.action ?? "none",
      status: b.result?.status ?? "narrated",
      signature: b.result?.signature,
      solscanUrl: b.result?.solscanUrl,
    });
    res.json({ ok: true });
  });

  return app;
}
