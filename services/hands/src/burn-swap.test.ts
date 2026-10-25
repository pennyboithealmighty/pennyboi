import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { burnMode, swapContextFromEnv } from "./burn-swap.js";

test("burnMode defaults to stub, 'swap' selects swap", () => {
  delete process.env.BURN_MODE;
  assert.equal(burnMode(), "stub");
  process.env.BURN_MODE = "SWAP";
  assert.equal(burnMode(), "swap");
  process.env.BURN_MODE = "stub";
  assert.equal(burnMode(), "stub");
});

test("swapContextFromEnv is null without a venue program (dormant until redeploy)", () => {
  process.env.TOKEN_MINT = PublicKey.default.toBase58();
  assert.equal(swapContextFromEnv({} as any, null), null);
});

test("swapContextFromEnv builds config when a venue + mint are present", () => {
  process.env.TOKEN_MINT = PublicKey.default.toBase58();
  process.env.BURN_SLIPPAGE_BPS = "250";
  process.env.BURN_MAX_IMPACT_BPS = "900";
  const fakeVenue = { programId: PublicKey.default } as any;
  const ctx = swapContextFromEnv({} as any, fakeVenue);
  assert.ok(ctx);
  assert.equal(ctx!.slippageBps, 250);
  assert.equal(ctx!.maxImpactBps, 900);
  assert.ok(ctx!.mint.equals(PublicKey.default));
  delete process.env.BURN_SLIPPAGE_BPS;
  delete process.env.BURN_MAX_IMPACT_BPS;
});
