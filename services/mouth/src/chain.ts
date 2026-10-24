// Read-only chain access for Mouth (used by /treasury, /last, digests).
// Degrades to null before the program is deployed.

import {
  computeAvailableActions,
  fetchVaultConfig,
  getConnection,
  lamportsToSol,
  tryLoadVault,
  type LoadedVault,
} from "@pennyboi/shared";

export interface TreasuryStatus {
  balanceSol: number;
  step: number;
  untilNextSol: number;
  available: string[];
  actionsBanked: number; // banked acts he owes
}

export class ChainReader {
  private vault: LoadedVault | null;
  private connection = getConnection();

  constructor() {
    const loaded = tryLoadVault(this.connection);
    this.vault = loaded.ok ? loaded.vault : null;
  }

  get available(): boolean {
    return this.vault !== null;
  }

  async treasuryStatus(): Promise<TreasuryStatus | null> {
    if (!this.vault) return null;
    const cfg = await fetchVaultConfig(this.vault.program, this.vault.configPda);
    const lamports = await this.connection.getBalance(this.vault.treasuryPda);
    const balance = lamportsToSol(lamports);
    const nowSecs = Math.floor(Date.now() / 1000);
    const avail = computeAvailableActions(cfg, nowSecs);

    // SOL still needed before the next threshold flips the flag.
    const target = cfg.lastThresholdBalance + cfg.thresholdLamports;
    const untilNext = Math.max(0, lamportsToSol(target) - balance);

    return {
      balanceSol: balance,
      step: cfg.thresholdStep,
      untilNextSol: untilNext,
      available: Object.keys(avail),
      actionsBanked: cfg.actionsAvailable,
    };
  }
}
