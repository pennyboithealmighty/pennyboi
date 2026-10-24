// Anchor TS integration tests for the Divine Allowance vault program.
//
// Proves:
//  - caps cannot be exceeded (burn + airdrop)
//  - cooldowns are enforced
//  - the action flag is consumed by exactly one action
//  - non-agent signers are rejected
//  - sweep() is callable by anyone (permissionless)
//  - the escape hatch cannot execute before unlock
//
// Runs against an ephemeral local validator via `anchor test`.

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

describe("vault (Divine Allowance)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vault as Program<Vault>;
  const connection = provider.connection;

  // Actors.
  const admin = (provider.wallet as anchor.Wallet).payer; // deploy wallet
  const agent = Keypair.generate(); // Pennyboi's restricted signer
  const stranger = Keypair.generate(); // anyone (sweep caller)
  const tokenMint = Keypair.generate().publicKey; // placeholder mint

  // PDAs.
  const pid = program.programId;
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], pid);
  const [feesPda] = PublicKey.findProgramAddressSync([Buffer.from("fees")], pid);
  const [burnPda] = PublicKey.findProgramAddressSync([Buffer.from("burn")], pid);

  // Params: threshold 2 SOL; caps 0.1/0.1/0.05; cooldowns + timelock 1h (long
  // enough that a second same-block action is blocked).
  const THRESHOLD = new anchor.BN(2 * SOL);
  const BURN_CAP = new anchor.BN(0.1 * SOL);
  const AIRDROP_CAP = new anchor.BN(0.1 * SOL);
  const BOUNTY_CAP = new anchor.BN(0.05 * SOL);
  const COOLDOWN = new anchor.BN(3600);
  const TIMELOCK = new anchor.BN(3600);
  const MAX_RECIPIENTS = 20;

  async function fund(pubkey: PublicKey, lamports: number) {
    const sig = await connection.requestAirdrop(pubkey, lamports);
    await connection.confirmTransaction(sig, "confirmed");
  }

  // Transfer SOL from admin -> any address (used to feed the FeeReceiver PDA).
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

  // Feed the fees PDA and sweep (fee paid by the default wallet), return config.
  async function feedAndSweep(lamports: number) {
    await sendSol(feesPda, lamports);
    await sweepIx().rpc();
    return program.account.config.fetch(configPda);
  }

  // Sweep paid for and signed ONLY by `payer` — proves sweep is permissionless
  // (no agent/admin authority involved).
  async function sweepAs(payer: Keypair) {
    const tx = await sweepIx().transaction();
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(payer);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
  }

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

  it("initializes the config", async () => {
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
    assert.ok(cfg.agent.equals(agent.publicKey));
    assert.ok(cfg.admin.equals(admin.publicKey));
    assert.equal(cfg.actionAvailable, false);
    assert.equal(cfg.thresholdStep.toNumber(), 0);
    assert.equal(cfg.burnCapLamports.toNumber(), BURN_CAP.toNumber());
  });

  it("rejects a non-agent signer on a menu instruction", async () => {
    // has_one = agent fails before the handler runs, regardless of the flag.
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

  it("sweep is permissionless and crosses the threshold", async () => {
    // Paid for and signed only by `stranger`, not admin or agent.
    await sendSol(feesPda, 3 * SOL);
    await sweepAs(stranger);
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.actionAvailable, true);
    assert.equal(cfg.thresholdStep.toNumber(), 1);

    const treasury = await connection.getBalance(treasuryPda);
    assert.isAtLeast(treasury, 2 * SOL);
  });

  it("rejects a burn above the cap", async () => {
    await expectError(
      program.methods
        .burn(new anchor.BN(0.2 * SOL)) // > 0.1 cap
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

  it("burns within the cap and consumes the action flag", async () => {
    const before = await connection.getBalance(burnPda);
    await program.methods
      .burn(new anchor.BN(0.1 * SOL))
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
    assert.equal(cfg.actionAvailable, false); // flag consumed

    const after = await connection.getBalance(burnPda);
    assert.equal(after - before, 0.1 * SOL);
  });

  it("rejects a second action once the flag is consumed", async () => {
    await expectError(
      program.methods
        .airdrop([stranger.publicKey], [new anchor.BN(0.01 * SOL)])
        .accountsStrict({
          config: configPda,
          agent: agent.publicKey,
          treasury: treasuryPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: stranger.publicKey, isWritable: true, isSigner: false },
        ])
        .signers([agent])
        .rpc(),
      "ActionNotAvailable"
    );
  });

  it("enforces the cooldown", async () => {
    // Cross again so the flag is set, then try to burn inside the 1h cooldown.
    const cfg = await feedAndSweep(3 * SOL);
    assert.equal(cfg.actionAvailable, true);

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
    // The failed burn did not consume the flag; it is still available below.
  });

  it("rejects an airdrop over the cap", async () => {
    const r1 = Keypair.generate().publicKey;
    const r2 = Keypair.generate().publicKey;
    await expectError(
      program.methods
        .airdrop(
          [r1, r2],
          [new anchor.BN(0.08 * SOL), new anchor.BN(0.08 * SOL)] // sum 0.16 > 0.1
        )
        .accountsStrict({
          config: configPda,
          agent: agent.publicKey,
          treasury: treasuryPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: r1, isWritable: true, isSigner: false },
          { pubkey: r2, isWritable: true, isSigner: false },
        ])
        .signers([agent])
        .rpc(),
      "CapExceeded"
    );
  });

  it("rejects an airdrop with too many recipients", async () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, () =>
      Keypair.generate().publicKey
    );
    await expectError(
      program.methods
        .airdrop(
          many,
          many.map(() => new anchor.BN(1))
        )
        .accountsStrict({
          config: configPda,
          agent: agent.publicKey,
          treasury: treasuryPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(
          many.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false }))
        )
        .signers([agent])
        .rpc(),
      "TooManyRecipients"
    );
  });

  it("airdrops within the cap and consumes the flag", async () => {
    const r1 = Keypair.generate().publicKey;
    const r2 = Keypair.generate().publicKey;
    const each = 0.02 * SOL;

    await program.methods
      .airdrop([r1, r2], [new anchor.BN(each), new anchor.BN(each)])
      .accountsStrict({
        config: configPda,
        agent: agent.publicKey,
        treasury: treasuryPda,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: r1, isWritable: true, isSigner: false },
        { pubkey: r2, isWritable: true, isSigner: false },
      ])
      .signers([agent])
      .rpc();

    assert.equal(await connection.getBalance(r1), each);
    assert.equal(await connection.getBalance(r2), each);

    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.actionAvailable, false);
  });

  it("escape hatch cannot execute before unlock", async () => {
    const dest = Keypair.generate().publicKey;

    // Admin requests a withdraw with a 1h timelock.
    await program.methods
      .requestWithdraw(new anchor.BN(0.01 * SOL), dest)
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();

    const cfg = await program.account.config.fetch(configPda);
    assert.isNotNull(cfg.pendingWithdraw);

    // Executing immediately must fail — timelock not expired.
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

    // Clean up so the pending withdraw doesn't linger.
    await program.methods
      .cancelWithdraw()
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();
  });

  it("rejects a non-admin escape-hatch request", async () => {
    await expectError(
      program.methods
        .requestWithdraw(new anchor.BN(0.01 * SOL), stranger.publicKey)
        .accountsStrict({ config: configPda, admin: stranger.publicKey })
        .signers([stranger])
        .rpc(),
      "ConstraintHasOne"
    );
  });
});
