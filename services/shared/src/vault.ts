// Vault Config decoding + the menu/caps logic shared across services.
// Mirrors programs/vault/src/lib.rs. Lamport fields are small (< 1 SOL) so
// Number() is safe here.

import type { Program } from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";
import { lamportsToSol } from "./solana.js";

/** Normalized snapshot of the on-chain Config account. */
export interface VaultConfig {
  admin: string;
  agent: string;
  tokenMint: string;
  thresholdLamports: number;
  lastThresholdBalance: number;
  thresholdStep: number;
  actionAvailable: boolean;
  burnCapLamports: number;
  airdropCapLamports: number;
  airdropMaxRecipients: number;
  bountyCapLamports: number;
  burnCooldownSecs: number;
  airdropCooldownSecs: number;
  bountyCooldownSecs: number;
  lastBurnTs: number;
  lastAirdropTs: number;
  lastBountyTs: number;
  escapeTimelockSecs: number;
  pendingWithdraw: boolean;
  pendingConfig: boolean;
}

// anchor returns BN for u64/i64; coerce defensively.
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as { toNumber?: () => number }).toNumber === "function") {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v);
}

export async function fetchVaultConfig(
  program: Program,
  configPda: PublicKey
): Promise<VaultConfig> {
  // `config` is the account name in the IDL.
  const raw: any = await (program.account as any).config.fetch(configPda);
  return {
    admin: raw.admin.toBase58(),
    agent: raw.agent.toBase58(),
    tokenMint: raw.tokenMint.toBase58(),
    thresholdLamports: toNum(raw.thresholdLamports),
    lastThresholdBalance: toNum(raw.lastThresholdBalance),
    thresholdStep: toNum(raw.thresholdStep),
    actionAvailable: Boolean(raw.actionAvailable),
    burnCapLamports: toNum(raw.burnCapLamports),
    airdropCapLamports: toNum(raw.airdropCapLamports),
    airdropMaxRecipients: toNum(raw.airdropMaxRecipients),
    bountyCapLamports: toNum(raw.bountyCapLamports),
    burnCooldownSecs: toNum(raw.burnCooldownSecs),
    airdropCooldownSecs: toNum(raw.airdropCooldownSecs),
    bountyCooldownSecs: toNum(raw.bountyCooldownSecs),
    lastBurnTs: toNum(raw.lastBurnTs),
    lastAirdropTs: toNum(raw.lastAirdropTs),
    lastBountyTs: toNum(raw.lastBountyTs),
    escapeTimelockSecs: toNum(raw.escapeTimelockSecs),
    pendingWithdraw: raw.pendingWithdraw !== null,
    pendingConfig: raw.pendingConfig !== null,
  };
}

/** The three menu actions. */
export type MenuAction = "burn" | "airdrop" | "bounty";

/** Actions currently OFF cooldown, with their caps — shape per docs/04. */
export interface AvailableActions {
  burn?: { cap_lamports: number };
  airdrop?: { cap_lamports: number; max_recipients: number };
  bounty?: { cap_lamports: number };
}

function offCooldown(nowSecs: number, lastTs: number, cooldown: number): boolean {
  return nowSecs >= lastTs + cooldown;
}

/**
 * Which menu actions are off cooldown right now. The on-chain `action_available`
 * flag still gates whether anything may run; this only reports cooldown state,
 * so the briefing can omit actions that aren't choosable yet.
 */
export function computeAvailableActions(
  cfg: VaultConfig,
  nowSecs: number
): AvailableActions {
  const out: AvailableActions = {};
  if (offCooldown(nowSecs, cfg.lastBurnTs, cfg.burnCooldownSecs)) {
    out.burn = { cap_lamports: cfg.burnCapLamports };
  }
  if (offCooldown(nowSecs, cfg.lastAirdropTs, cfg.airdropCooldownSecs)) {
    out.airdrop = {
      cap_lamports: cfg.airdropCapLamports,
      max_recipients: cfg.airdropMaxRecipients,
    };
  }
  if (offCooldown(nowSecs, cfg.lastBountyTs, cfg.bountyCooldownSecs)) {
    out.bounty = { cap_lamports: cfg.bountyCapLamports };
  }
  return out;
}

export function thresholdSol(cfg: VaultConfig): number {
  return lamportsToSol(cfg.thresholdLamports);
}
