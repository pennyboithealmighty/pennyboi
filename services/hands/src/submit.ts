// Build, sign (with the agent wallet on the program's provider) and submit the
// Anchor instruction for a decision. Returns the confirmed signature.

import * as anchor from "@coral-xyz/anchor";
import type { LoadedVault } from "@pennyboi/shared";
import { PublicKey, SystemProgram, type Commitment } from "@solana/web3.js";
import type { Decision } from "./types.js";

export type Submitter = (d: Decision) => Promise<string>;

export function makeSubmitter(vault: LoadedVault, commitment: Commitment): Submitter {
  const { program, configPda, treasuryPda, burnPda } = vault;
  // The agent key is the program provider's wallet, so .rpc() signs with it.
  const agent = program.provider.publicKey!;

  return async (d: Decision): Promise<string> => {
    switch (d.action) {
      case "burn": {
        const amount = new anchor.BN(d.params.amount_lamports as number);
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
        const amounts = (d.params.amounts as number[]).map((a) => new anchor.BN(a));
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
        const amount = new anchor.BN(d.params.amount_lamports as number);
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
