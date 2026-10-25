// READ-ONLY: decode the live devnet Config with the PINNED (deployed) IDL and
// print actions_available + any pending config update. Use this to confirm the
// pinned IDL still matches the on-chain program before `config:execute` / a pm2
// restart (docs/13 IDL-safety check). No on-chain changes — it only fetches.
//
// Run: pnpm --filter @pennyboi/scripts decode-config [path/to/idl.json]
// Defaults to idl/vault-deployed.json; forces VAULT_IDL_PATH for this process.

import { getConnection, repoRoot, tryLoadVault } from "@pennyboi/shared";
import { isAbsolute, join } from "node:path";
import { log } from "./lib.js";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const idlPath = arg
    ? isAbsolute(arg)
      ? arg
      : join(repoRoot(), arg)
    : join(repoRoot(), "idl", "vault-deployed.json");
  process.env.VAULT_IDL_PATH = idlPath; // force the pinned IDL for this read

  const conn = getConnection();
  const loaded = tryLoadVault(conn); // read-only (no signing wallet)
  if (!loaded.ok) throw new Error(loaded.reason);
  const { program, programId, configPda } = loaded.vault;

  log(`pinned IDL : ${idlPath}`);
  log(`program    : ${programId.toBase58()}`);
  log(`config PDA : ${configPda.toBase58()}`);

  const raw = (await (program.account as { config: { fetch: (k: unknown) => Promise<any> } }).config.fetch(
    configPda
  )) as any;

  log("");
  log(`actions_available (banked) : ${raw.actionsAvailable}`);
  log(`threshold_step             : ${raw.thresholdStep}`);
  log(`airdrop_max_recipients     : ${raw.airdropMaxRecipients}   (current on-chain)`);

  const pc = raw.pendingConfig;
  if (!pc) {
    log("pending_config             : (none)");
  } else {
    const unlockSec = Number(pc.unlockTs.toString());
    log("pending_config:");
    log(`  unlock_ts                : ${pc.unlockTs} (${new Date(unlockSec * 1000).toISOString()})`);
    log(`  airdrop_max_recipients   -> ${pc.airdropMaxRecipients}`);
    log(`  threshold_lamports       -> ${pc.thresholdLamports}`);
    log(`  burn/airdrop/bounty cap  -> ${pc.burnCapLamports} / ${pc.airdropCapLamports} / ${pc.bountyCapLamports}`);
    log(`  cooldowns b/a/b          -> ${pc.burnCooldownSecs} / ${pc.airdropCooldownSecs} / ${pc.bountyCooldownSecs}`);
    log(`  max_banked / idle_floor  -> ${pc.maxBankedActions} / ${pc.idleFloorSecs}`);
    log(`  escape_timelock_secs     -> ${pc.escapeTimelockSecs}`);
    const now = Math.floor(Date.now() / 1000);
    log(now >= unlockSec ? "  => timelock elapsed: config:execute is ready." : `  => executable in ${Math.ceil((unlockSec - now) / 3600)}h.`);
  }
}

main().catch((e) => {
  log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
