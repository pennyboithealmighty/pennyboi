// @pennyboi/hands — entrypoint.
// Receives a validated decision from the Brain, re-validates it against fresh
// on-chain state, signs with the agent key, submits, confirms, and returns the
// result (with a Solscan link). Owner /pause and /resume drive the kill switch.

import * as anchor from "@coral-xyz/anchor";
import {
  envNum,
  envStr,
  fetchVaultConfig,
  getConnection,
  tryLoadVault,
  type LoadedVault,
} from "@pennyboi/shared";
import type { Commitment } from "@solana/web3.js";
import express, { type Request, type Response } from "express";
import { executeDecision, type ExecDeps } from "./execute.js";
import { loadAgentKeypair } from "./keypair.js";
import { log } from "./log.js";
import { isPaused, setPaused } from "./pause.js";
import { solscanTx } from "./solscan.js";
import { makeSubmitter, type Submitter } from "./submit.js";
import type { Decision } from "./types.js";

// Lazily built so the server can boot without an agent key / deployed program;
// /execute then returns 503 with the reason until configured.
let cached: { vault: LoadedVault; submit: Submitter } | null = null;

function getChain(commitment: Commitment): { vault: LoadedVault; submit: Submitter } {
  if (cached) return cached;
  const connection = getConnection(commitment);
  const agent = loadAgentKeypair();
  const loaded = tryLoadVault(connection, new anchor.Wallet(agent));
  if (!loaded.ok) throw new Error(loaded.reason);
  cached = { vault: loaded.vault, submit: makeSubmitter(loaded.vault, commitment) };
  log.info(`agent ${agent.publicKey.toBase58()} ready for ${loaded.vault.programId.toBase58()}`);
  return cached;
}

async function forwardToMouth(payload: unknown): Promise<void> {
  const url = envStr("MOUTH_URL");
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    log.info(`forwarded result to Mouth (${res.status})`);
  } catch (e) {
    log.error("failed to forward result to Mouth", e);
  }
}

function main(): void {
  const port = envNum("HANDS_PORT", 8789);
  const commitment = envStr("TX_COMMITMENT", "confirmed") as Commitment;

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "hands", paused: isPaused() });
  });

  app.post("/execute", async (req: Request, res: Response) => {
    const body = req.body as { decision?: Decision; briefing?: unknown };
    const decision = body?.decision;
    if (!decision || typeof decision.action !== "string") {
      return res.status(400).json({ ok: false, error: "missing decision" });
    }

    let chain: { vault: LoadedVault; submit: Submitter };
    try {
      chain = getChain(commitment);
    } catch (e) {
      // Only needed for real submissions; "none" still succeeds below via deps.
      if (decision.action !== "none") {
        return res.status(503).json({ ok: false, error: (e as Error).message });
      }
      chain = null as never;
    }

    const deps: ExecDeps = {
      getConfig: () => fetchVaultConfig(chain.vault.program, chain.vault.configPda),
      submit: (d) => chain.submit(d),
      isPaused,
      solscan: solscanTx,
    };

    const result = await executeDecision(decision, deps);
    log.info(`execute ${decision.action} -> ${result.status}`, result.signature ?? result.error ?? "");

    // Pass the briefing through so Mouth can extract nickname/grudge memory.
    void forwardToMouth({ decision, result, briefing: body.briefing, narration: decision.narration });
    res.json({ ok: result.status !== "failed", result });
  });

  app.post("/pause", (_req: Request, res: Response) => {
    setPaused(true);
    log.warn("on-chain actions PAUSED (kill switch)");
    res.json({ ok: true, paused: true });
  });

  app.post("/resume", (_req: Request, res: Response) => {
    setPaused(false);
    log.info("on-chain actions resumed");
    res.json({ ok: true, paused: false });
  });

  app.listen(port, () => {
    log.info(`hands listening on :${port} (POST /execute, /pause, /resume; GET /health)`);
    if (isPaused()) log.warn("ACTIONS_PAUSED=true — starting paused.");
    if (!envStr("AGENT_KEYPAIR_PATH")) {
      log.warn("AGENT_KEYPAIR_PATH not set — /execute will 503 for on-chain actions until configured.");
    }
  });
}

main();
