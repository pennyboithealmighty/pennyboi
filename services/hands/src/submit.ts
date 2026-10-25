// Build, sign (with the agent wallet on the program's provider) and submit the
// Anchor instruction for a decision. Returns the confirmed signature.

import BN from "bn.js"; // @coral-xyz/anchor's BN isn't exposed under ESM; import it directly.
import type { LoadedVault } from "@pennyboi/shared";
import { PublicKey, SystemProgram, type Commitment } from "@solana/web3.js";
import { burnMode, buybackBurn, type SwapContext } from "./burn-swap.js";
import { log } from "./log.js";
import type { Decision } from "./types.js";

export type Submitter = (d: Decision) => Promise<string>;

export function makeSubmitter(
  vault: LoadedVault,
  commitment: Commitment,
  swap: SwapContext | null = null
): Submitter {
  const { program, configPda, treasuryPda, burnPda } = vault;
  // The agent key is the program provider's wallet, so .rpc() signs with it.
  const agent = program.provider.publicKey!;

  return async (d: Decision): Promise<string> => {
    switch (d.action) {
      case "burn": {
        // BURN_MODE=swap (docs/13): real buyback-and-burn through a venue. Falls
        // back to the stub when the swap context isn't wired yet (pre-redeploy).
        if (burnMode() === "swap" && swap) {
          const r = await buybackBurn(vault, swap, d.params.amount_lamports as number, commitment);
          if (!r.ok) throw new Error(`buyback skipped: ${r.reason}`);
          log.info(`buyback: spent ${r.plan.amountLamports} lamports (impact ${r.plan.impactBps}bps)`);
          return r.signature;
        }
        if (burnMode() === "swap" && !swap) {
          log.warn("BURN_MODE=swap but no swap context (venue/mint) — using the stub burn.");
        }
        const amount = new BN(d.params.amount_lamports as number);
        return (program.methods as any)
          .burn(amount)
          .accountsStrict({
            config: configPda,
            agent,
            treasury: treasuryPda,
            burnRoute: burnPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment });
      }

      case "airdrop": {
        const recips = (d.params.recipients as string[]).map((r) => new PublicKey(r));
        const amounts = (d.params.amounts as number[]).map((a) => new BN(a));
        return (program.methods as any)
          .airdrop(recips, amounts)
          .accountsStrict({
            config: configPda,
            agent,
            treasury: treasuryPda,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(
            recips.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false }))
          )
          .rpc({ commitment });
      }

      case "bounty": {
        const to = new PublicKey(d.params.to as string);
        const amount = new BN(d.params.amount_lamports as number);
        const memo = d.params.memo as string;
        return (program.methods as any)
          .bounty(to, amount, memo)
          .accountsStrict({
            config: configPda,
            agent,
            treasury: treasuryPda,
            recipient: to,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment });
      }

      case "none":
        throw new Error("submit() called for action 'none'");
    }
  };
}
