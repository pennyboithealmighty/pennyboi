// Devnet deploy + initialize for the vault program. Idempotent: re-running
// skips build/deploy when the program is already on-chain and only runs
// initialize (and skips that too if the Config already exists).
//
// Steps: (1) refuse unless the RPC is devnet; (2) generate admin + agent
// keypairs into a gitignored keys/ folder (secret keys NEVER printed); (3) fund
// them from the devnet faucet; (4) if not already deployed, anchor
// build/keys sync/deploy; (5) initialize the on-chain Config with
// caps/cooldowns/threshold. Prints only public keys and the .env lines to paste.
//
// Run with: pnpm --filter @pennyboi/scripts deploy:devnet
// Env knobs (optional): SKIP_ANCHOR_DEPLOY=1 (force-skip build/deploy),
// VAULT_THRESHOLD_SOL, VAULT_BURN_CAP_SOL, VAULT_AIRDROP_CAP_SOL,
// VAULT_AIRDROP_MAX, VAULT_BOUNTY_CAP_SOL, VAULT_*_COOLDOWN_SECS,
// VAULT_ESCAPE_TIMELOCK_SECS, TOKEN_MINT.

import * as anchor from "@coral-xyz/anchor";
import {
  envBool,
  envNum,
  envStr,
  getConnection,
  repoRoot,
  solToLamports,
  tryLoadVault,
  type LoadedVault,
} from "@pennyboi/shared";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js"; // @coral-xyz/anchor's BN isn't exposed under ESM; import it directly.
import { execSync } from "node:child_process";
import { assertDevnet, ensureFunded, loadOrCreateKeypair, log, sol } from "./lib.js";

function initParams(agent: PublicKey, tokenMint: PublicKey) {
  return {
    agent,
    tokenMint,
    thresholdLamports: new BN(solToLamports(envNum("VAULT_THRESHOLD_SOL", 0.5))),
    burnCapLamports: new BN(solToLamports(envNum("VAULT_BURN_CAP_SOL", 0.1))),
    airdropCapLamports: new BN(solToLamports(envNum("VAULT_AIRDROP_CAP_SOL", 0.1))),
    airdropMaxRecipients: envNum("VAULT_AIRDROP_MAX", 20),
    bountyCapLamports: new BN(solToLamports(envNum("VAULT_BOUNTY_CAP_SOL", 0.05))),
    burnCooldownSecs: new BN(envNum("VAULT_BURN_COOLDOWN_SECS", 6 * 3600)),
    airdropCooldownSecs: new BN(envNum("VAULT_AIRDROP_COOLDOWN_SECS", 12 * 3600)),
    bountyCooldownSecs: new BN(envNum("VAULT_BOUNTY_COOLDOWN_SECS", 24 * 3600)),
    escapeTimelockSecs: new BN(envNum("VAULT_ESCAPE_TIMELOCK_SECS", 72 * 3600)),
  };
}

function runAnchor(cmd: string, adminPath: string, rpc: string): void {
  log(`$ ${cmd}`);
  execSync(cmd, {
    cwd: repoRoot(),
    stdio: "inherit",
    env: { ...process.env, ANCHOR_WALLET: adminPath, ANCHOR_PROVIDER_URL: rpc },
  });
}

/** True if the program id from the IDL/env is already an executable account. */
async function isDeployed(conn: Connection, admin: anchor.web3.Keypair): Promise<LoadedVault | null> {
  const pre = tryLoadVault(conn, new anchor.Wallet(admin));
  if (!pre.ok) return null; // no IDL / program id yet
  const acc = await conn.getAccountInfo(pre.vault.programId);
  return acc && acc.executable ? pre.vault : null;
}

async function main(): Promise<void> {
  const rpc = assertDevnet();
  log(`devnet confirmed: ${rpc}`);

  // (2) keys — secret keys are written to keys/ (gitignored) and never printed.
  const admin = loadOrCreateKeypair("admin");
  const agent = loadOrCreateKeypair("agent");
  log(`admin  ${admin.keypair.publicKey.toBase58()}  (${admin.created ? "generated" : "existing"}) -> ${admin.path}`);
  log(`agent  ${agent.keypair.publicKey.toBase58()}  (${agent.created ? "generated" : "existing"}) -> ${agent.path}`);

  // (3) fund from the faucet (best effort; devnet is rate-limited).
  const conn = getConnection();
  const adminBal = await ensureFunded(conn, admin.keypair.publicKey, 1.5, 2);
  const agentBal = await ensureFunded(conn, agent.keypair.publicKey, 0.3, 1);
  log(`admin balance ${sol(adminBal)} SOL, agent balance ${sol(agentBal)} SOL`);

  // (4) build + deploy, unless already deployed (idempotent) or forced off.
  // FORCE_DEPLOY=1 always builds/deploys (used to stand up a fresh instance:
  // `rm -f target/deploy/vault-keypair.json target/idl/vault.json` + clear
  // VAULT_PROGRAM_ID in .env first to get a new program id).
  const deployedVault = envBool("FORCE_DEPLOY", false)
    ? null
    : await isDeployed(conn, admin.keypair);
  if (deployedVault) {
    log(`program ${deployedVault.programId.toBase58()} already deployed on devnet — skipping build/deploy.`);
  } else if (envBool("SKIP_ANCHOR_DEPLOY", false)) {
    log("SKIP_ANCHOR_DEPLOY set — skipping build/deploy (expecting an already-deployed program).");
  } else {
    if (adminBal < solToLamports(1.4)) {
      log(
        "WARNING: admin balance may be too low to deploy. Run `solana airdrop 2 " +
          admin.keypair.publicKey.toBase58() +
          " --url devnet` (repeat if rate-limited), then re-run."
      );
    }
    try {
      runAnchor("anchor build", admin.path, rpc);
      runAnchor("anchor keys sync", admin.path, rpc);
      runAnchor("anchor build", admin.path, rpc);
      runAnchor(`anchor deploy --provider.cluster devnet --provider.wallet ${admin.path}`, admin.path, rpc);
    } catch (e) {
      log("anchor build/deploy failed. Fix the cause, or run those four commands manually,");
      log("then re-run (deploy is idempotent and will skip straight to initialize).");
      throw e;
    }
  }

  // (5) load the deployed program (IDL carries the real address) + initialize.
  const loaded = tryLoadVault(conn, new anchor.Wallet(admin.keypair));
  if (!loaded.ok) throw new Error(`cannot load vault: ${loaded.reason}`);
  const v = loaded.vault;

  const existing = await (v.program.account as any).config.fetchNullable(v.configPda);
  if (existing) {
    log("config already initialized — skipping initialize.");
  } else {
    const tokenMint = envStr("TOKEN_MINT")
      ? new PublicKey(envStr("TOKEN_MINT"))
      : anchor.web3.Keypair.generate().publicKey; // placeholder until launch (unused in v0.1 burn)
    log(`initializing config (token_mint=${tokenMint.toBase58()})`);
    await (v.program.methods as any)
      .initialize(initParams(agent.keypair.publicKey, tokenMint))
      .accountsStrict({
        admin: admin.keypair.publicKey,
        config: v.configPda,
        treasury: v.treasuryPda,
        fees: v.feesPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    log("config initialized.");
  }

  log("");
  log(`DEPLOYED. program id: ${v.programId.toBase58()}`);
  log(`  config   PDA: ${v.configPda.toBase58()}`);
  log(`  treasury PDA: ${v.treasuryPda.toBase58()}`);
  log(`  fees     PDA: ${v.feesPda.toBase58()}`);
  log("");
  log("Add these to your .env (no secrets shown):");
  log(`  VAULT_PROGRAM_ID=${v.programId.toBase58()}`);
  log(`  AGENT_KEYPAIR_PATH=${agent.path}`);
  log(`  ADMIN_KEYPAIR_PATH=${admin.path}`);
}

main().catch((e) => {
  log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
