// Solana connection, vault PDA derivation, and a read-only Anchor program loader.

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  type Commitment,
} from "@solana/web3.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { envStr, readJson, repoRoot } from "./env.js";

export const LAMPORTS_PER_SOL = 1_000_000_000;

export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function getRpcUrl(): string {
  return envStr("SOLANA_RPC_URL", "https://api.devnet.solana.com");
}

export function getConnection(commitment: Commitment = "confirmed"): Connection {
  return new Connection(getRpcUrl(), commitment);
}

// ---- PDAs (must match programs/vault/src/lib.rs seeds) --------------------

export function deriveConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}
export function deriveTreasuryPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("treasury")], programId)[0];
}
export function deriveFeesPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("fees")], programId)[0];
}
export function deriveBurnPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("burn")], programId)[0];
}

// ---- Program loader -------------------------------------------------------

/** Default location of the Anchor-generated IDL after `anchor build`. */
export function defaultIdlPath(): string {
  return envStr("VAULT_IDL_PATH", join(repoRoot(), "target", "idl", "vault.json"));
}

export interface LoadedVault {
  program: anchor.Program;
  programId: PublicKey;
  configPda: PublicKey;
  treasuryPda: PublicKey;
  feesPda: PublicKey;
  burnPda: PublicKey;
}

/**
 * Load the vault IDL and return an Anchor program plus its PDAs. Pass a `wallet`
 * to get a signing program (e.g. the Hands agent); omit it for read-only use (a
 * throwaway wallet that never signs). Returns a reason instead of throwing when
 * the IDL or program id isn't available yet — e.g. before the first devnet
 * deploy — so callers can degrade gracefully.
 */
export function tryLoadVault(
  connection: Connection,
  wallet?: anchor.Wallet
): { ok: true; vault: LoadedVault } | { ok: false; reason: string } {
  const idlPath = defaultIdlPath();
  if (!existsSync(idlPath)) {
    return { ok: false, reason: `IDL not found at ${idlPath} (run \`anchor build\`)` };
  }

  let idl: anchor.Idl;
  try {
    idl = readJson<anchor.Idl>(idlPath);
  } catch (e) {
    return { ok: false, reason: `failed to parse IDL: ${String(e)}` };
  }

  // Program id: env override wins, else the address baked into the IDL.
  const envId = envStr("VAULT_PROGRAM_ID");
  const addr = envId || (idl as { address?: string }).address;
  if (!addr) {
    return { ok: false, reason: "no VAULT_PROGRAM_ID and no address in IDL" };
  }

  let programId: PublicKey;
  try {
    programId = new PublicKey(addr);
  } catch {
    return { ok: false, reason: `invalid program id: ${addr}` };
  }

  // Signing provider when a wallet is given; otherwise a throwaway read-only one.
  const provider = new anchor.AnchorProvider(
    connection,
    wallet ?? new anchor.Wallet(Keypair.generate()),
    { commitment: connection.commitment ?? "confirmed" }
  );
  const idlWithAddr = { ...idl, address: programId.toBase58() } as anchor.Idl;
  const program = new anchor.Program(idlWithAddr, provider);

  return {
    ok: true,
    vault: {
      program,
      programId,
      configPda: deriveConfigPda(programId),
      treasuryPda: deriveTreasuryPda(programId),
      feesPda: deriveFeesPda(programId),
      burnPda: deriveBurnPda(programId),
    },
  };
}
