// Anchor TS integration tests for the Divine Allowance vault program, including
// treasury banking + the idle floor (docs/10-treasury-banking.md).
//
// Proves:
//  - non-agent signers are rejected; sweep() is permissionless
//  - one sweep crosses N thresholds and banks exactly N (capped at max_banked)
//  - each menu call decrements the counter and stamps last_action_ts
//  - a menu call is rejected when actions_available == 0
//  - cooldown still blocks a second same-function act even with counter > 1
//  - the idle floor grants exactly one act when funded + idle, not below the cap,
//    and does not stack
//  - caps cannot be exceeded; escape hatch cannot execute before unlock
//
// Runs against an ephemeral local validator via `anchor test --validator legacy`.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { Vault } from "../target/types/vault";

const SOL = LAMPORTS_PER_SOL;

describe("vault (banking + idle floor)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;
  const connection = provider.connection;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const agent = Keypair.generate();
  const stranger = Keypair.generate();
  const tokenMint = Keypair.generate().publicKey;

  const pid = program.programId;
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], pid);
  const [feesPda] = PublicKey.findProgramAddressSync([Buffer.from("fees")], pid);
  const [burnPda] = PublicKey.findProgramAddressSync([Buffer.from("burn")], pid);

  const THRESHOLD = new anchor.BN(2 * SOL);
  const BURN_CAP = new anchor.BN(0.1 * SOL);
  const AIRDROP_CAP = new anchor.BN(0.1 * SOL);
  const BOUNTY_CAP = new anchor.BN(0.05 * SOL); // smallest cap -> idle-floor affordability
  const COOLDOWN = new anchor.BN(3600);
  const TIMELOCK = new anchor.BN(3600);
  const MAX_RECIPIENTS = 20;
  const MAX_BANKED = 3; // small, to exercise the cap
  const IDLE_FLOOR = new anchor.BN(0); // 0 -> idle-floor time condition always met

  async function fund(pubkey: PublicKey, lamports: number) {
    const sig = await connection.requestAirdrop(pubkey, lamports);
    await connection.confirmTransaction(sig, "confirmed");
  }
  async function sendSol(to: PublicKey, lamports: number) {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: to, lamports })
    );
    await provider.sendAndConfirm(tx, []);
  }
  function sweepIx() {
    return program.methods.sweep().accountsStrict({
      config: configPda,
      treasury: treasuryPda,
      fees: feesPda,
      systemProgram: SystemProgram.programId,
    });
  }
  async function feedAndSweep(lamports: number) {
    if (lamports > 0) await sendSol(feesPda, lamports);
    await sweepIx().rpc();
    return program.account.config.fetch(configPda);
  }
  async function sweepAs(payer: Keypair) {
    const tx = await sweepIx().transaction();
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(payer);
    await connection.confirmTransaction(
      await connection.sendRawTransaction(tx.serialize()),
      "confirmed"
    );
    return program.account.config.fetch(configPda);
  }
  const banked = (cfg: any) => (cfg.actionsAvailable as number);

  async function expectError(p: Promise<unknown>, code: string) {
    try {
      await p;
      assert.fail(`expected error "${code}" but the call succeeded`);
    } catch (e: any) {
      const needle = String(e?.error?.errorCode?.code ?? "") + " " + String(e);
      assert.include(needle, code, `expected "${code}", got: ${e}`);
    }
  }

  before(async () => {
    await fund(admin.publicKey, 100 * SOL);
    await fund(stranger.publicKey, 5 * SOL);
  });

  it("initializes with the banking config", async () => {
    await program.methods
      .initialize({
        agent: agent.publicKey,
        tokenMint,
        thresholdLamports: THRESHOLD,
        burnCapLamports: BURN_CAP,
        airdropCapLamports: AIRDROP_CAP,
        airdropMaxRecipients: MAX_RECIPIENTS,
        bountyCapLamports: BOUNTY_CAP,
        burnCooldownSecs: COOLDOWN,
        airdropCooldownSecs: COOLDOWN,
        bountyCooldownSecs: COOLDOWN,
        escapeTimelockSecs: TIMELOCK,
        maxBankedActions: MAX_BANKED,
        idleFloorSecs: IDLE_FLOOR,
      })
      .accountsStrict({
        admin: admin.publicKey,
        config: configPda,
        treasury: treasuryPda,
        fees: feesPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await program.account.config.fetch(configPda);
    assert.equal(banked(cfg), 0);
    assert.equal(cfg.maxBankedActions, MAX_BANKED);
    assert.equal(cfg.idleFloorSecs.toNumber(), 0);
    assert.equal(cfg.lastActionTs.toNumber(), 0);
  });

  it("rejects a non-agent signer on a menu instruction", async () => {
    await expectError(
      program.methods
        .burn(new anchor.BN(0.01 * SOL))
        .accountsStrict({
          config: configPda,
          agent: stranger.publicKey,
          treasury: treasuryPda,
          burnRoute: burnPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc(),
      "ConstraintHasOne"
    );
  });

  it("sweep is permissionless; idle floor does NOT grant below the smallest cap", async () => {
    // Fees empty, treasury ~0 (< bounty cap). A stranger-paid sweep crosses
    // nothing and must not grant an idle act.
    const cfg = await sweepAs(stranger);
    assert.equal(banked(cfg), 0);
    assert.equal(cfg.thresholdStep.toNumber(), 0);
  });

  it("idle floor grants exactly one act when funded + idle", async () => {
    // 1.5 SOL: below the 2 SOL threshold (no crossing) but above the smallest cap.
    const cfg = await feedAndSweep(1.5 * SOL);
    assert.equal(banked(cfg), 1);
    assert.equal(cfg.thresholdStep.toNumber(), 0); // no threshold crossed
  });

  it("idle floor does not stack", async () => {
    const cfg = await feedAndSweep(0); // sweep again, no new fees
    assert.equal(banked(cfg), 1);
  });

  it("rejects a burn above the cap (counter > 0)", async () => {
    await expectError(
      program.methods
        .burn(new anchor.BN(0.2 * SOL))
        .accountsStrict({
          config: configPda,
          agent: agent.publicKey,
          treasury: treasuryPda,
          burnRoute: burnPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc(),
      "CapExceeded"
    );
  });

  it("burn decrements the counter and stamps last_action_ts", async () => {
    await program.methods
      .burn(new anchor.BN(0.05 * SOL))
      .accountsStrict({
        config: configPda,
        agent: agent.publicKey,
        treasury: treasuryPda,
        burnRoute: burnPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    const cfg = await program.account.config.fetch(configPda);
    assert.equal(banked(cfg), 0); // 1 -> 0
    assert.ok(cfg.lastActionTs.toNumber() > 0);
    assert.ok(cfg.lastBurnTs.toNumber() > 0);
  });

  it("rejects a menu call when the counter is 0", async () => {
    await expectError(
      program.methods
        .bounty(stranger.publicKey, new anchor.BN(0.01 * SOL), "offering")
        .accountsStrict({
          config: configPda,
          agent: agent.publicKey,
          treasury: treasuryPda,
          recipient: stranger.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc(),
      "ActionNotAvailable"
    );
  });

  it("one sweep crossing N thresholds banks exactly N", async () => {
    // treasury ~1.45 + 3 = ~4.45 -> crosses 2 and 4 (two crossings), banks 2.
    const cfg = await feedAndSweep(3 * SOL);
    assert.equal(banked(cfg), 2);
    assert.equal(cfg.thresholdStep.toNumber(), 2);
  });

  it("banking caps at max_banked_actions", async () => {
    // +5 SOL -> treasury ~9.45; from last_threshold 4 it crosses 6 and 8 (+2),
    // which would make 4 but caps at MAX_BANKED (3).
    const cfg = await feedAndSweep(5 * SOL);
    assert.equal(banked(cfg), MAX_BANKED);
  });

  it("cooldown blocks a second same-function act even with counter > 1", async () => {
    // counter is 3, but burn is still on its 1h cooldown from earlier.
    await expectError(
      program.methods
        .burn(new anchor.BN(0.05 * SOL))
        .accountsStrict({
          config: configPda,
          agent: agent.publicKey,
          treasury: treasuryPda,
          burnRoute: burnPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc(),
      "CooldownActive"
    );
  });

  it("airdrop over cap is rejected; a valid airdrop decrements the counter", async () => {
    const r1 = Keypair.generate().publicKey;
    const before = (await program.account.config.fetch(configPda)).actionsAvailable as number;

    await expectError(
      program.methods
        .airdrop([r1], [new anchor.BN(0.2 * SOL)]) // > 0.1 cap
        .accountsStrict({
          config: configPda,
          agent: agent.publicKey,
          treasury: treasuryPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: r1, isWritable: true, isSigner: false }])
        .signers([agent])
        .rpc(),
      "CapExceeded"
    );

    await program.methods
      .airdrop([r1], [new anchor.BN(0.02 * SOL)])
      .accountsStrict({
        config: configPda,
        agent: agent.publicKey,
        treasury: treasuryPda,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: r1, isWritable: true, isSigner: false }])
      .signers([agent])
      .rpc();

    const cfg = await program.account.config.fetch(configPda);
    assert.equal(banked(cfg), before - 1);
    assert.equal(await connection.getBalance(r1), 0.02 * SOL);
  });

  it("escape hatch cannot execute before unlock", async () => {
    const dest = Keypair.generate().publicKey;
    await program.methods
      .requestWithdraw(new anchor.BN(0.01 * SOL), dest)
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();

    await expectError(
      program.methods
        .executeWithdraw()
        .accountsStrict({
          config: configPda,
          admin: admin.publicKey,
          treasury: treasuryPda,
          recipient: dest,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "TimelockNotExpired"
    );

    await program.methods
      .cancelWithdraw()
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();
  });
});
