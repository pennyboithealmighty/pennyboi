// Helius webhook receiver. Verifies the shared secret, records trade activity
// from the payload, then pokes the threshold tracker.

import express, { type Express, type Request, type Response } from "express";
import type { ActivityWindow } from "./activity.js";
import { parseTrades } from "./parser.js";
import type { ThresholdTracker } from "./tracker.js";
import type { Logger } from "./log.js";

export interface ServerDeps {
  secret: string; // HELIUS_WEBHOOK_SECRET ("" = accept in dev)
  mint: string; // TOKEN_MINT ("" = no trade parsing yet)
  activity: ActivityWindow;
  tracker: ThresholdTracker;
  log: Logger;
}

export function createServer(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "eyes" });
  });

  app.post("/webhook", async (req: Request, res: Response) => {
    // Helius sends the configured auth value in the Authorization header.
    if (deps.secret) {
      const auth = req.header("authorization") ?? "";
      if (auth !== deps.secret) {
        deps.log.warn("rejected webhook: bad auth header");
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    } else {
      deps.log.warn("HELIUS_WEBHOOK_SECRET not set — accepting webhook unauthenticated (dev only).");
    }

    let parsed = 0;
    try {
      const trades = parseTrades(req.body, deps.mint);
      deps.activity.recordMany(trades);
      parsed = trades.length;
      deps.log.debug(`webhook: parsed ${parsed} trade event(s)`);
    } catch (e) {
      deps.log.error("failed to parse webhook payload", e);
    }

    // Re-check chain state in the background; don't block the webhook response.
    void deps.tracker.check();
    res.json({ ok: true, parsed });
  });

  return app;
}
