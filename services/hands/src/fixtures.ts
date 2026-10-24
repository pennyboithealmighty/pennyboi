import type { VaultConfig } from "@pennyboi/shared";

export const RECIP = "So11111111111111111111111111111111111111112";

/** A config with the flag set and everything off cooldown at now=1000. */
export function fakeConfig(over: Partial<VaultConfig> = {}): VaultConfig {
  return {
    admin: "ADMIN",
    agent: "AGENT",
    tokenMint: "MINT",
    thresholdLamports: 2_000_000_000,
    lastThresholdBalance: 2_000_000_000,
    thresholdStep: 1,
    actionsAvailable: 1,
    maxBankedActions: 50,
    burnCapLamports: 100_000_000,
    airdropCapLamports: 100_000_000,
    airdropMaxRecipients: 20,
    bountyCapLamports: 50_000_000,
    burnCooldownSecs: 0,
    airdropCooldownSecs: 0,
    bountyCooldownSecs: 0,
    lastBurnTs: 0,
    lastAirdropTs: 0,
    lastBountyTs: 0,
    idleFloorSecs: 86400,
    lastActionTs: 0,
    escapeTimelockSecs: 3600,
    pendingWithdraw: false,
    pendingConfig: false,
    ...over,
  };
}
