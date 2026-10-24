// Devnet deploy + initialize for the vault program.
//
// Steps: (1) refuse unless the RPC is devnet; (2) generate admin + agent
// keypairs into a gitignored keys/ folder (secret keys NEVER printed); (3) fund
// them from the devnet faucet; (4) anchor build/keys sync/deploy; (5) initialize
// the on-chain Config with caps/cooldowns/threshold. Prints only public keys and
// the .env lines to paste.
//
// Env knobs (optional): SKIP_ANCHOR_DEPLOY=1 (program already deployed),
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
} from "@pennyboi/shared";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { execSync } from "node:child_process";
import { assertDevnet, ensureFunded, loadOrCreateKeypair, log, sol } from "./lib.js";

function initParams(agent: PublicKey, tokenMint: PublicKey) {
  return {
    agent,
    tokenMint,
    thresholdLamports: new anchor.BN(solToLamports(envNum("VAULT_THRESHOLD_SOL", 0.5))),
    burnCapLamports: new anchor.BN(solToLamports(envNum("VAULT_BURN_CAP_SOL", 0.1))),
    airdropCapLamports: new anchor.BN(solToLamports(envNum("VAULT_AIRDROP_CAP_SOL", 0.1))),
    airdropMaxRecipients: envNum("VAULT_AIRDROP_MAX", 20),
    bountyCapLamports: new anchor.BN(solToLamports(envNum("VAULT_BOUNTY_CAP_SOL", 0.05))),
    burnCooldownSecs: new anchor.BN(envNum("VAULT_BURN_COOLDOWN_SECS", 6 * 3600)),
    airdropCooldownSecs: new anchor.BN(envNum("VAULT_AIRDROP_COOLDOWN_SECS", 12 * 3600)),
    bountyCooldownSecs: new anchor.BN(envNum("VAULT_BOUNTY_COOLDOWN_SECS", 24 * 3600)),
    escapeTimelockSecs: new anchor.BN(envNum("VAULT_ESCAPE_TIMELOCK_SECS", 72 * 3600)),
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
  if (adminBal < solToLamports(1.4)) {
    log("WARNING: admin balance may be too low to deploy. Run `solana airdrop 2 " +
      admin.keypair.publicKey.toBase58() + " --url devnet` (repeat if rate-limited).");
  }

  // (4) build + sync program id + deploy (skippable if already deployed).
  if (!envBool("SKIP_ANCHOR_DEPLOY", false)) {
    try {
      runAnchor("anchor build", admin.path, rpc);
      runAnchor("anchor keys sync", admin.path, rpc);
      runAnchor("anchor build", admin.path, rpc);
      runAnchor(`anchor deploy --provider.cluster devnet --provider.wallet ${admin.path}`, admin.path, rpc);
    } catch (e) {
      log("anchor build/deploy failed. If the `anchor` CLI is missing, install it, or run the");
      log("four commands above manually, then re-run with SKIP_ANCHOR_DEPLOY=1.");
      throw e;
    }
  } else {
    log("SKIP_ANCHOR_DEPLOY set — using the already-deployed program.");
  }

  // (5) load the deployed program (IDL now carries the real address) + init.
  const loaded = tryLoadVault(conn, new anchor.Wallet(admin.keypair));
  if (!loaded.ok) throw new Error(`cannot load vault after deploy: ${loaded.reason}`);
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
