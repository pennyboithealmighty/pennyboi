// @pennyboi/eyes — entrypoint.
// Boots the Helius webhook receiver, loads the vault (if deployed), and starts
// the polling fallback when no Helius key is present. On any threshold crossing
// it builds the situation briefing and hands it to the Brain.

import { envNum, envStr, getConnection, MemoryDb, tryLoadVault } from "@pennyboi/shared";
import { ActivityWindow } from "./activity.js";
import { makeHandoff } from "./handoff.js";
import { log } from "./log.js";
import { startOfferingWatcher } from "./offerings.js";
import { startPoller } from "./poller.js";
import { createServer } from "./server.js";
import { ThresholdTracker } from "./tracker.js";

function main(): void {
  const port = envNum("EYES_PORT", 8787);
  const heliusKey = envStr("HELIUS_API_KEY");
  const secret = envStr("HELIUS_WEBHOOK_SECRET");
  const mint = envStr("TOKEN_MINT");
  const pollInterval = envNum("EYES_POLL_INTERVAL_SECS", 30);

  const connection = getConnection();
  const loaded = tryLoadVault(connection);
  if (loaded.ok) {
    log.info(`vault loaded: ${loaded.vault.programId.toBase58()}`);
  } else {
    log.warn(`vault not loaded: ${loaded.reason}`);
  }
  const vault = loaded.ok ? loaded.vault : null;

  const activity = new ActivityWindow();
  const onBrief = makeHandoff(log);

  let db: MemoryDb | null = null;
  try {
    db = new MemoryDb(envStr("DATABASE_PATH", "./db/pennyboi.db"));
  } catch (e) {
    log.warn("could not open memory DB — briefings will omit offerings/grudges/loyal", e);
  }

  const tracker = new ThresholdTracker({ vault, connection, activity, db, onBrief, log });

  const app = createServer({ secret, mint, activity, tracker, log });
  app.listen(port, () => {
    log.info(`webhook receiver listening on :${port} (POST /webhook, GET /health)`);
    if (!mint) log.warn("TOKEN_MINT not set — trade activity parsing is disabled until launch.");
  });

  // Check once at startup (handles a flag already pending a decision).
  void tracker.check();

  // Watch the FeeReceiver for SOL offerings (docs/12). Needs the vault (for the
  // FeeReceiver PDA + admin/agent) and the DB; silently off until deployed.
  if (vault && db) {
    const offeringPoll = envNum("OFFERING_POLL_SECS", pollInterval);
    void startOfferingWatcher({ connection, vault, db, log, intervalSecs: offeringPoll });
  }

  // Spec: fall back to polling only when no Helius key is configured.
  if (!heliusKey) {
    startPoller(tracker, pollInterval, log);
  } else {
    log.info("Helius key present — relying on webhooks (no polling).");
  }
}

main();
