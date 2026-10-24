// Permissionless sweep driver. Calls the vault's sweep() to forward FeeReceiver
// lamports into the Treasury and run the threshold check. sweep() takes no
// privileged signer — any funded wallet can call it; here the agent key pays the
// (tiny) tx fee.
//
// Default: one sweep per invocation (drop this in a system/cloud cron). Pass
// --loop to self-schedule every SWEEP_INTERVAL_SECS instead.

import * as anchor from "@coral-xyz/anchor";
import {
  envNum,
  fetchVaultConfig,
  getConnection,
  tryLoadVault,
  type LoadedVault,
} from "@pennyboi/shared";
import { SystemProgram } from "@solana/web3.js";
import { assertDevnet, loadOrCreateKeypair, log } from "./lib.js";

async function sweepOnce(vault: LoadedVault): Promise<void> {
  const before = await fetchVaultConfig(vault.program, vault.configPda);
  const sig = await (vault.program.methods as any)
    .sweep()
    .accountsStrict({
      config: vault.configPda,
      treasury: vault.treasuryPda,
      fees: vault.feesPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  const after = await fetchVaultConfig(vault.program, vault.configPda);
  const crossed = after.thresholdStep > before.thresholdStep;
  log(
    `swept (${sig.slice(0, 16)}…) — step ${before.thresholdStep} -> ${after.thresholdStep}` +
      (crossed ? `  ★ THRESHOLD CROSSED, action flag set` : "")
  );
}

async function main(): Promise<void> {
  assertDevnet();
  const conn = getConnection();
  // sweep is permissionless; the agent key just pays the fee.
  const agent = loadOrCreateKeypair("agent");

  const loaded = tryLoadVault(conn, new anchor.Wallet(agent.keypair));
  if (!loaded.ok) throw new Error(`vault not loaded: ${loaded.reason} (deploy first)`);
  const vault = loaded.vault;

  const loop = process.argv.includes("--loop");
  const intervalSecs = envNum("SWEEP_INTERVAL_SECS", 300);

  await sweepOnce(vault);
  if (!loop) return;

  log(`looping sweep every ${intervalSecs}s`);
  setInterval(() => {
    sweepOnce(vault).catch((e) => log(`sweep failed: ${e.message}`));
  }, Math.max(5, intervalSecs) * 1000);
}

main().catch((e) => {
  log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
