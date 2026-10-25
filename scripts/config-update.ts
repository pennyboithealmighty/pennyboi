// Timelocked admin config update (docs/03 §6). Caps/cooldowns/threshold can be
// changed, but only after the escape timelock elapses — so you can't silently
// raise them. Three subcommands:
//
//   pnpm --filter @pennyboi/scripts config:request   # propose new values (from VAULT_* env)
//   pnpm --filter @pennyboi/scripts config:execute   # apply, once the timelock has passed
//   pnpm --filter @pennyboi/scripts config:cancel    # drop a pending request
//
// `request` reads the same VAULT_* env vars as deploy and proposes ALL of them.
// It prints the unlock time; run `execute` after that.

import * as anchor from "@coral-xyz/anchor";
import {
  envNum,
  envStr,
  fetchVaultConfig,
  getConnection,
  solToLamports,
  tryLoadVault,
} from "@pennyboi/shared";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { assertDevnet, loadOrCreateKeypair, log } from "./lib.js";

/** Parse VAULT_VENUE_WHITELIST (comma list, up to 4) into a fixed [Pubkey; 4], zero-padded. */
function venueWhitelist(): PublicKey[] {
  const keys = envStr("VAULT_VENUE_WHITELIST")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new PublicKey(s));
  if (keys.length > 4) throw new Error("VAULT_VENUE_WHITELIST has more than 4 entries");
  while (keys.length < 4) keys.push(PublicKey.default);
  return keys;
}

function updateParams() {
  return {
    thresholdLamports: new BN(solToLamports(envNum("VAULT_THRESHOLD_SOL", 0.5))),
    burnCapLamports: new BN(solToLamports(envNum("VAULT_BURN_CAP_SOL", 0.1))),
    airdropCapLamports: new BN(solToLamports(envNum("VAULT_AIRDROP_CAP_SOL", 0.1))),
    airdropMaxRecipients: envNum("VAULT_AIRDROP_MAX", 20),
    bountyCapLamports: new BN(solToLamports(envNum("VAULT_BOUNTY_CAP_SOL", 0.05))),
    burnCooldownSecs: new BN(envNum("VAULT_BURN_COOLDOWN_SECS", 6 * 3600)),
    airdropCooldownSecs: new BN(envNum("VAULT_AIRDROP_COOLDOWN_SECS", 12 * 3600)),
    bountyCooldownSecs: new BN(envNum("VAULT_BOUNTY_COOLDOWN_SECS", 24 * 3600)),
    escapeTimelockSecs: new BN(envNum("VAULT_ESCAPE_TIMELOCK_SECS", 72 * 3600)),
    maxBankedActions: envNum("VAULT_MAX_BANKED_ACTIONS", 50),
    idleFloorSecs: new BN(envNum("VAULT_IDLE_FLOOR_SECS", 86400)),
    venueWhitelist: venueWhitelist(),
    burnFeeAllowanceLamports: new BN(envNum("VAULT_BURN_FEE_ALLOWANCE_LAMPORTS", 3_000_000)),
  };
}

async function main(): Promise<void> {
  assertDevnet();
  const cmd = process.argv[2];
  if (!cmd || !["request", "execute", "cancel"].includes(cmd)) {
    throw new Error("usage: config:request | config:execute | config:cancel");
  }

  const conn = getConnection();
  const admin = loadOrCreateKeypair("admin");
  const loaded = tryLoadVault(conn, new anchor.Wallet(admin.keypair));
  if (!loaded.ok) throw new Error(`vault not loaded: ${loaded.reason}`);
  const v = loaded.vault;
  const accounts = { config: v.configPda, admin: admin.keypair.publicKey };

  if (cmd === "request") {
    const cfg = await fetchVaultConfig(v.program, v.configPda);
    await (v.program.methods as any).requestConfigUpdate(updateParams()).accountsStrict(accounts).rpc();
    const unlock = new Date((Math.floor(Date.now() / 1000) + cfg.escapeTimelockSecs) * 1000);
    log(`config update requested. current timelock ${cfg.escapeTimelockSecs}s — execute after ${unlock.toISOString()}`);
  } else if (cmd === "execute") {
    await (v.program.methods as any).executeConfigUpdate().accountsStrict(accounts).rpc();
    log("config update executed.");
  } else {
    await (v.program.methods as any).cancelConfigUpdate().accountsStrict(accounts).rpc();
    log("pending config update cancelled.");
  }
}

main().catch((e) => {
  log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
