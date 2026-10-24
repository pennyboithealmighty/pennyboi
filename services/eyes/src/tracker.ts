// Watches the on-chain Config. Whenever a new threshold is crossed and the
// action flag is set (seen via webhook poke or the polling fallback), it builds
// a briefing, hands it to the Brain, and resets the activity window.

import {
  fetchVaultConfig,
  lamportsToSol,
  type LoadedVault,
} from "@pennyboi/shared";
import type { Connection } from "@solana/web3.js";
import type { ActivityWindow } from "./activity.js";
import { buildBriefing } from "./briefing-builder.js";
import type { BriefingHandler } from "./handoff.js";
import type { Logger } from "./log.js";

export interface TrackerDeps {
  vault: LoadedVault | null;
  connection: Connection;
  activity: ActivityWindow;
  onBrief: BriefingHandler;
  log: Logger;
}

export class ThresholdTracker {
  private lastBriefedStep = -1;
  private checking = false;
  private warnedNoVault = false;

  constructor(private deps: TrackerDeps) {}

  /** Re-read chain state and brief if a new threshold is pending a decision. */
  async check(): Promise<void> {
    const { vault, connection, activity, onBrief, log } = this.deps;
    if (!vault) {
      if (!this.warnedNoVault) {
        log.warn("vault not loaded (no IDL / program id yet) — chain checks disabled until deploy.");
        this.warnedNoVault = true;
      }
      return;
    }
    if (this.checking) return; // avoid overlapping reads
    this.checking = true;
    try {
      const cfg = await fetchVaultConfig(vault.program, vault.configPda);

      // Brief once per new threshold while the flag is set and unconsumed.
      if (cfg.actionAvailable && cfg.thresholdStep !== this.lastBriefedStep) {
        const lamports = await connection.getBalance(vault.treasuryPda);
        const nowSecs = Math.floor(Date.now() / 1000);
        const briefing = buildBriefing(cfg, lamportsToSol(lamports), activity, nowSecs);
        await onBrief(briefing);
        activity.reset();
        this.lastBriefedStep = cfg.thresholdStep;
      } else if (!cfg.actionAvailable) {
        // Flag consumed (action taken) — align so the next crossing re-fires.
        this.lastBriefedStep = cfg.thresholdStep;
      }
    } catch (e) {
      this.deps.log.error("tracker check failed", e);
    } finally {
      this.checking = false;
    }
  }
}
