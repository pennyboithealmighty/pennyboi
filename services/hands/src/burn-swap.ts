// Buyback-and-burn build path for Hands (docs/13 §3), behind BURN_MODE.
//   stub (default): the old on-chain `burn` (SOL -> burn_route). Unchanged until
//     the owner redeploys with the docs/13 program.
//   swap: read the venue's reserves, plan a slippage-protected buy, and submit
//     `buyback_burn` so the swap happens inside the vault signed by the Treasury
//     PDA. This stage wires the MOCK venue; Pump.fun/PumpSwap builders are Stage 3.
//
// Nothing here runs unless BURN_MODE=swap AND the swap context is configured; the
// live exercise is the post-redeploy devnet dry run.

import {
  envNum,
  envStr,
  planBurn,
  type BurnPlan,
  type LoadedVault,
} from "@pennyboi/shared";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import {
  type Commitment,
  type Connection,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";

export type BurnMode = "stub" | "swap";

export function burnMode(): BurnMode {
  return envStr("BURN_MODE", "stub").toLowerCase() === "swap" ? "swap" : "stub";
}

export interface SwapContext {
  connection: Connection;
  mockVenue: anchor.Program; // the mock venue program (Stage 3 adds real venues)
  mint: PublicKey;
  slippageBps: number;
  maxImpactBps: number;
}

/** Build the swap context from env + the loaded programs, or null if unconfigured. */
export function swapContextFromEnv(connection: Connection, mockVenue: anchor.Program | null): SwapContext | null {
  const mintStr = envStr("TOKEN_MINT");
  if (!mockVenue || !mintStr) return null;
  return {
    connection,
    mockVenue,
    mint: new PublicKey(mintStr),
    slippageBps: envNum("BURN_SLIPPAGE_BPS", 300),
    maxImpactBps: envNum("BURN_MAX_IMPACT_BPS", 1000),
  };
}

export type BuybackResult =
  | { ok: true; signature: string; plan: BurnPlan }
  | { ok: false; reason: string };

/**
 * Read the mock pool's reserves, plan the buy, build the venue buy instruction,
 * wrap it in `buyback_burn`, and submit — one transaction, signed by the agent,
 * with the swap executed by the Treasury PDA inside the program.
 */
export async function buybackBurn(
  vault: LoadedVault,
  swap: SwapContext,
  amountLamports: number,
  commitment: Commitment
): Promise<BuybackResult> {
  const { connection, mockVenue, mint } = swap;
  const [poolSol] = PublicKey.findProgramAddressSync([Buffer.from("pool_sol")], mockVenue.programId);
  const [poolAuth] = PublicKey.findProgramAddressSync([Buffer.from("pool_auth")], mockVenue.programId);
  const poolVault = getAssociatedTokenAddressSync(mint, poolAuth, true);
  const treasuryAta = getAssociatedTokenAddressSync(mint, vault.treasuryPda, true);

  // Fresh reserves -> plan (amount may be halved; skip if impact too high).
  const solReserve = BigInt(await connection.getBalance(poolSol));
  const tokReserve = (await getAccount(connection, poolVault)).amount;
  const plan = planBurn({
    amountLamports: BigInt(amountLamports),
    solReserve,
    tokReserve,
    slippageBps: swap.slippageBps,
    maxImpactBps: swap.maxImpactBps,
  });
  if ("skip" in plan) return { ok: false, reason: plan.reason };

  const amountIn = new BN(plan.amountLamports.toString());
  const minOut = new BN(plan.minTokensOut.toString());

  // The venue buy ix (buyer = Treasury PDA). Flip the buyer to non-signer at the
  // outer level — the vault re-signs it via invoke_signed.
  const venueIx = await (mockVenue.methods as any)
    .buy(amountIn, minOut)
    .accountsStrict({
      buyer: vault.treasuryPda,
      poolSol,
      poolAuth,
      poolVault,
      buyerAta: treasuryAta,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const remaining = venueIx.keys.map((k: anchor.web3.AccountMeta) =>
    k.pubkey.equals(vault.treasuryPda) ? { ...k, isSigner: false } : k
  );

  const signature: string = await (vault.program.methods as any)
    .buybackBurn(amountIn, minOut, venueIx.data)
    .accountsStrict({
      config: vault.configPda,
      agent: vault.program.provider.publicKey!,
      treasury: vault.treasuryPda,
      treasuryTokenAta: treasuryAta,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      venueProgram: mockVenue.programId,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remaining)
    .rpc({ commitment });

  return { ok: true, signature, plan };
}
