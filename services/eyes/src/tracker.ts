// Watches the on-chain Config. Whenever a new threshold is crossed and the
// action flag is set (seen via webhook poke or the polling fallback), it builds
// a briefing, hands it to the Brain, and resets the activity window.

import {
  computeAvailableActions,
  envNum,
  fetchVaultConfig,
  lamportsToSol,
  type LoadedVault,
  type MemoryDb,
} from "@pennyboi/shared";
import type { Connection } from "@solana/web3.js";
import type { ActivityWindow } from "./activity.js";
import { buildBriefing, type BuildOpts } from "./briefing-builder.js";
import type { BriefingHandler } from "./handoff.js";
import type { Logger } from "./log.js";

export interface TrackerDeps {
  vault: LoadedVault | null;
  connection: Connection;
  activity: ActivityWindow;
  db: MemoryDb | null;
  onBrief: BriefingHandler;
  log: Logger;
}

export class ThresholdTracker {
  private lastBriefAt = 0; // ms; throttle so a standing backlog doesn't spam
  private checking = false;
  private warnedNoVault = false;
  private minBriefMs: number;

  constructor(private deps: TrackerDeps) {
    this.minBriefMs = envNum("EYES_BRIEF_MIN_SECS", 900) * 1000;
  }

  /** Pull the memory-backed sections of the briefing from the shared DB. */
  private memoryOpts(): BuildOpts {
    const db = this.deps.db;
    if (!db) return {};
    return {
      offerings: db.topOpenOfferings(5).map((o) => ({
        id: o.id,
        wallet: o.wallet,
        text: o.text,
        upvotes: o.upvotes,
      })),
      grudges: db.listGrudges(10).map((g) => ({
        wallet: g.wallet,
        nickname: g.nickname ?? undefined,
        reason: g.reason,
      })),
      loyal: db.listLoyal(10).map((l) => ({
        wallet: l.wallet,
        nickname: l.nickname ?? undefined,
        reason: l.reason,
      })),
      lastActions: db.lastActions(3).map((a) => ({
        ts: a.ts,
        action: a.action,
        summary: a.narration ?? "",
      })),
    };
  }

  /** Re-read chain state and brief while he owes banked acts he can spend. */
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
      const nowSecs = Math.floor(Date.now() / 1000);

      // Brief when he has banked acts AND at least one menu action is off
      // cooldown (something is actually spendable), throttled so a standing
      // backlog or a backlog stuck behind cooldowns doesn't re-brief every poll.
      const offCooldown = Object.keys(computeAvailableActions(cfg, nowSecs)).length > 0;
      const throttled = Date.now() - this.lastBriefAt < this.minBriefMs;
      if (cfg.actionsAvailable > 0 && offCooldown && !throttled) {
        const lamports = await connection.getBalance(vault.treasuryPda);
        const briefing = buildBriefing(cfg, lamportsToSol(lamports), activity, nowSecs, this.memoryOpts());
        await onBrief(briefing);
        activity.reset();
        this.lastBriefAt = Date.now();
      }
    } catch (e) {
      this.deps.log.error("tracker check failed", e);
    } finally {
      this.checking = false;
    }
  }
}
