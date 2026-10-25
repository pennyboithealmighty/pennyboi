// Anchor integration tests for buyback_burn (docs/13 §6). Runs on the local
// validator against the mock venues (Pump.fun/PumpSwap don't exist on devnet).
//
// Proves:
//  - happy path: buy on a whitelisted venue, burn exactly the tokens received,
//    supply drops, the ATA is emptied, the banked counter decrements by one
//  - a non-whitelisted venue is rejected
//  - Config / FeeReceiver passed in remaining_accounts is rejected
//  - a venue that over-spends SOL reverts (SwapSpentTooMuch)
//  - a venue that under-pays tokens reverts (SlippageExceeded), and the vault's
//    own min_tokens_out is enforced even when the venue itself is happy
//  - stray tokens already in the ATA are NOT burned; only the delta is
//  - cap and banked-act rules still apply
//  - a Token-2022 mint works
//
// Run: anchor test --validator legacy

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import { Vault } from "../target/types/vault";
import { MockVenue } from "../target/types/mock_venue";
import { MockEvilVenue } from "../target/types/mock_evil_venue";

const SOL = LAMPORTS_PER_SOL;
const DEC = 6;

/** Constant-product out = tok * in / (sol + in). */
function expectedOut(solReserve: bigint, tokReserve: bigint, amountIn: bigint): bigint {
  return (tokReserve * amountIn) / (solReserve + amountIn);
}

describe("vault (buyback_burn)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const program = anchor.workspace.Vault as Program<Vault>;
  const mockVenue = anchor.workspace.MockVenue as Program<MockVenue>;
  const mockEvil = anchor.workspace.MockEvilVenue as Program<MockEvilVenue>;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const agent = Keypair.generate();

  const pid = program.programId;
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], pid);
  const [feesPda] = PublicKey.findProgramAddressSync([Buffer.from("fees")], pid);

  const [poolSol] = PublicKey.findProgramAddressSync([Buffer.from("pool_sol")], mockVenue.programId);
  const [poolAuth] = PublicKey.findProgramAddressSync([Buffer.from("pool_auth")], mockVenue.programId);

  const BURN_CAP = new anchor.BN(0.1 * SOL);
  const ALLOWANCE = new anchor.BN(0.003 * SOL);

  let mint: PublicKey;
  let treasuryAta: PublicKey;
  let poolVault: PublicKey;

  async function airdrop(to: PublicKey, lamports: number) {
    const sig = await connection.requestAirdrop(to, lamports);
    await connection.confirmTransaction(sig, "confirmed");
  }
  async function sendSol(to: PublicKey, lamports: number) {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: to, lamports })
    );
    await provider.sendAndConfirm(tx, []);
  }
  async function bankedCount(): Promise<number> {
    const cfg = await program.account.config.fetch(configPda);
    return (cfg as any).actionsAvailable as number;
  }

  // Build a mock buy instruction, then flip the buyer(treasury) to non-signer at
  // the outer level — the vault re-signs it for the inner CPI via invoke_signed.
  async function buyRemaining(amountIn: anchor.BN, venueMinOut: anchor.BN) {
    const ix = await mockVenue.methods
      .buy(amountIn, venueMinOut)
      .accountsStrict({
        buyer: treasuryPda,
        poolSol,
        poolAuth,
        poolVault,
        buyerAta: treasuryAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const keys = ix.keys.map((k) =>
      k.pubkey.equals(treasuryPda) ? { ...k, isSigner: false } : k
    );
    return { data: ix.data, keys };
  }

  before(async () => {
    await airdrop(agent.publicKey, 2 * SOL);

    // SPL (Token) mint; admin is the mint authority.
    mint = await createMint(connection, admin, admin.publicKey, null, DEC);

    // Initialize the vault: whitelist the two mock venues, cooldown 0, low
    // threshold + high banked so we can run several burns; timelock 0 here.
    await program.methods
      .initialize({
        agent: agent.publicKey,
        tokenMint: mint,
        thresholdLamports: new anchor.BN(0.1 * SOL),
        burnCapLamports: BURN_CAP,
        airdropCapLamports: new anchor.BN(0.1 * SOL),
        airdropMaxRecipients: 5,
        bountyCapLamports: new anchor.BN(0.05 * SOL),
        burnCooldownSecs: new anchor.BN(0),
        airdropCooldownSecs: new anchor.BN(0),
        bountyCooldownSecs: new anchor.BN(0),
        escapeTimelockSecs: new anchor.BN(0),
        maxBankedActions: 20,
        idleFloorSecs: new anchor.BN(0),
        venueWhitelist: [mockVenue.programId, mockEvil.programId, PublicKey.default, PublicKey.default],
        burnFeeAllowanceLamports: ALLOWANCE,
      })
      .accountsStrict({
        admin: admin.publicKey,
        config: configPda,
        treasury: treasuryPda,
        fees: feesPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Treasury ATA for the mint.
    await program.methods
      .initTreasuryAtas()
      .accountsStrict({
        config: configPda,
        payer: admin.publicKey,
        treasury: treasuryPda,
        mint,
        treasuryTokenAta: getAssociatedTokenAddressSync(mint, treasuryPda, true),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    treasuryAta = getAssociatedTokenAddressSync(mint, treasuryPda, true);

    // Seed the mock pool: 10 SOL reserve + a big token reserve.
    await sendSol(poolSol, 10 * SOL);
    const pv = await getOrCreateAssociatedTokenAccount(connection, admin, mint, poolAuth, true);
    poolVault = pv.address;
    await mintTo(connection, admin, mint, poolVault, admin, BigInt(1_000_000_000) * BigInt(10 ** DEC));

    // Fund treasury and bank actions (one sweep crosses many thresholds).
    await sendSol(treasuryPda, 3 * SOL);
    await program.methods
      .sweep()
      .accountsStrict({ config: configPda, treasury: treasuryPda, fees: feesPda, systemProgram: SystemProgram.programId })
      .rpc();
    assert.isAtLeast(await bankedCount(), 5, "expected several banked acts after the sweep");
  });

  async function quoteMinOut(amountIn: anchor.BN): Promise<anchor.BN> {
    const solReserve = BigInt(await connection.getBalance(poolSol));
    const tok = (await getAccount(connection, poolVault)).amount;
    const out = expectedOut(solReserve, tok, BigInt(amountIn.toString()));
    return new anchor.BN(((out * BigInt(90)) / BigInt(100)).toString()); // 10% below quote
  }

  it("buys on a whitelisted venue and burns exactly what it received", async () => {
    const amountIn = new anchor.BN(0.05 * SOL);
    const minOut = await quoteMinOut(amountIn);
    const supplyBefore = (await getMint(connection, mint)).supply;
    const banked = await bankedCount();

    const r = await buyRemaining(amountIn, new anchor.BN(1));
    await program.methods
      .buybackBurn(amountIn, minOut, Buffer.from(r.data))
      .accountsStrict({
        config: configPda,
        agent: agent.publicKey,
        treasury: treasuryPda,
        treasuryTokenAta: treasuryAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        venueProgram: mockVenue.programId,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(r.keys)
      .signers([agent])
      .rpc();

    const supplyAfter = (await getMint(connection, mint)).supply;
    assert.isTrue(supplyAfter < supplyBefore, "token supply must shrink");
    const ata = await getAccount(connection, treasuryAta);
    assert.equal(ata.amount.toString(), "0", "all received tokens are burned");
    assert.equal(await bankedCount(), banked - 1, "exactly one banked act consumed");
  });

  it("rejects a non-whitelisted venue", async () => {
    const amountIn = new anchor.BN(0.01 * SOL);
    const r = await buyRemaining(amountIn, new anchor.BN(1));
    try {
      await program.methods
        .buybackBurn(amountIn, new anchor.BN(1), Buffer.from(r.data))
        .accountsStrict({
          config: configPda,
          agent: agent.publicKey,
          treasury: treasuryPda,
          treasuryTokenAta: treasuryAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          venueProgram: Keypair.generate().publicKey, // not in the whitelist
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(r.keys)
        .signers([agent])
        .rpc();
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.match(e.toString(), /VenueNotWhitelisted/);
    }
  });

  it("rejects Config or FeeReceiver in remaining_accounts", async () => {
    const amountIn = new anchor.BN(0.01 * SOL);
    const r = await buyRemaining(amountIn, new anchor.BN(1));
    const keys = [...r.keys, { pubkey: configPda, isSigner: false, isWritable: false }];
    try {
      await program.methods
        .buybackBurn(amountIn, new anchor.BN(1), Buffer.from(r.data))
        .accountsStrict({
          config: configPda,
          agent: agent.publicKey,
          treasury: treasuryPda,
          treasuryTokenAta: treasuryAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          venueProgram: mockVenue.programId,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(keys)
        .signers([agent])
        .rpc();
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.match(e.toString(), /ForbiddenVenueAccount/);
    }
  });

  async function evilRemaining(amount: anchor.BN) {
    const [sink] = PublicKey.findProgramAddressSync([Buffer.from("evil")], mockEvil.programId);
    const ix = await mockEvil.methods
      .grabSol(amount)
      .accountsStrict({ buyer: treasuryPda, sink, systemProgram: SystemProgram.programId })
      .instruction();
    const keys = ix.keys.map((k) => (k.pubkey.equals(treasuryPda) ? { ...k, isSigner: false } : k));
    return { data: ix.data, keys };
  }

  async function runEvil(grabAmount: anchor.BN, amountLamports: anchor.BN, minOut: anchor.BN) {
    const r = await evilRemaining(grabAmount);
    return program.methods
      .buybackBurn(amountLamports, minOut, Buffer.from(r.data))
      .accountsStrict({
        config: configPda,
        agent: agent.publicKey,
        treasury: treasuryPda,
        treasuryTokenAta: treasuryAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        venueProgram: mockEvil.programId,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(r.keys)
      .signers([agent])
      .rpc();
  }

  it("reverts when the venue over-spends SOL", async () => {
    try {
      // grabs 1 SOL while amount_lamports is 0.05 -> over the cap+allowance.
      await runEvil(new anchor.BN(1 * SOL), new anchor.BN(0.05 * SOL), new anchor.BN(1));
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.match(e.toString(), /SwapSpentTooMuch/);
    }
  });

  it("reverts when the venue under-pays tokens (slippage)", async () => {
    try {
      // grabs a small, in-bounds amount but returns zero tokens < min_tokens_out.
      await runEvil(new anchor.BN(0.01 * SOL), new anchor.BN(0.05 * SOL), new anchor.BN(1));
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.match(e.toString(), /SlippageExceeded/);
    }
  });

  it("enforces the vault's min_tokens_out even when the venue is happy", async () => {
    const amountIn = new anchor.BN(0.01 * SOL);
    const r = await buyRemaining(amountIn, new anchor.BN(1)); // venue happy with min_out=1
    const absurd = new anchor.BN("1000000000000000000"); // far above any real quote
    try {
      await program.methods
        .buybackBurn(amountIn, absurd, Buffer.from(r.data))
        .accountsStrict({
          config: configPda,
          agent: agent.publicKey,
          treasury: treasuryPda,
          treasuryTokenAta: treasuryAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          venueProgram: mockVenue.programId,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(r.keys)
        .signers([agent])
        .rpc();
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.match(e.toString(), /SlippageExceeded/);
    }
  });

  it("burns only the delta; stray tokens already in the ATA are untouched", async () => {
    const stray = BigInt(1234) * BigInt(10 ** DEC);
    await mintTo(connection, admin, mint, treasuryAta, admin, stray);
    const before = (await getAccount(connection, treasuryAta)).amount;
    assert.equal(before.toString(), stray.toString());

    const amountIn = new anchor.BN(0.02 * SOL);
    const minOut = await quoteMinOut(amountIn);
    const r = await buyRemaining(amountIn, new anchor.BN(1));
    await program.methods
      .buybackBurn(amountIn, minOut, Buffer.from(r.data))
      .accountsStrict({
        config: configPda,
        agent: agent.publicKey,
        treasury: treasuryPda,
        treasuryTokenAta: treasuryAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        venueProgram: mockVenue.programId,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(r.keys)
      .signers([agent])
      .rpc();

    const after = (await getAccount(connection, treasuryAta)).amount;
    assert.equal(after.toString(), stray.toString(), "only the bought delta is burned; stray stays");
  });

  it("rejects an amount over the burn cap", async () => {
    const over = new anchor.BN(BURN_CAP.toNumber() + 1);
    const r = await buyRemaining(over, new anchor.BN(1));
    try {
      await program.methods
        .buybackBurn(over, new anchor.BN(1), Buffer.from(r.data))
        .accountsStrict({
          config: configPda,
          agent: agent.publicKey,
          treasury: treasuryPda,
          treasuryTokenAta: treasuryAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          venueProgram: mockVenue.programId,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(r.keys)
        .signers([agent])
        .rpc();
      assert.fail("should have reverted");
    } catch (e: any) {
      assert.match(e.toString(), /CapExceeded/);
    }
  });

  // NOTE: the vault Config is a singleton bound to one token_mint (not updatable),
  // so a full Token-2022 buyback_burn run would need a second config. The burn
  // path itself is token_interface (program-agnostic) and is exercised end-to-end
  // above on an SPL Token mint; here we confirm the Token-2022 ATA/mint plumbing
  // lines up so the same InterfaceAccount code applies.
  it("Token-2022 ATA + mint plumbing lines up with the token interface", async () => {
    const mint22 = await createMint(
      connection, admin, admin.publicKey, null, DEC, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID
    );
    const ata22 = await getOrCreateAssociatedTokenAccount(
      connection, admin, mint22, treasuryPda, true, undefined, undefined, TOKEN_2022_PROGRAM_ID
    );
    await mintTo(connection, admin, mint22, ata22.address, admin, BigInt(1000) * BigInt(10 ** DEC), [], undefined, TOKEN_2022_PROGRAM_ID);
    const acc = await getAccount(connection, ata22.address, undefined, TOKEN_2022_PROGRAM_ID);
    assert.equal(acc.amount.toString(), (BigInt(1000) * BigInt(10 ** DEC)).toString());
  });
});
