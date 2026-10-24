import test from "node:test";
import assert from "node:assert/strict";
import { validateOnchain } from "./validate.js";
import { RECIP, fakeConfig } from "./fixtures.js";

const NOW = 1000;

test("none is always valid", () => {
  assert.deepEqual(validateOnchain({ action: "none", params: {} }, fakeConfig(), NOW), []);
});

test("rejects when the on-chain flag is not set", () => {
  const errs = validateOnchain(
    { action: "burn", params: { amount_lamports: 1 } },
    fakeConfig({ actionAvailable: false }),
    NOW
  );
  assert.ok(errs.some((e) => e.includes("flag is not set")));
});

test("burn: within cap passes, over cap fails", () => {
  assert.deepEqual(
    validateOnchain({ action: "burn", params: { amount_lamports: 100_000_000 } }, fakeConfig(), NOW),
    []
  );
  const errs = validateOnchain(
    { action: "burn", params: { amount_lamports: 100_000_001 } },
    fakeConfig(),
    NOW
  );
  assert.ok(errs.some((e) => e.includes("exceeds cap")));
});

test("burn on cooldown is rejected", () => {
  const errs = validateOnchain(
    { action: "burn", params: { amount_lamports: 1 } },
    fakeConfig({ lastBurnTs: 999, burnCooldownSecs: 100 }), // 999+100 > 1000
    NOW
  );
  assert.ok(errs.some((e) => e.includes("cooldown")));
});

test("airdrop: too many recipients and over cap", () => {
  const recips = Array.from({ length: 21 }, () => RECIP);
  const errs = validateOnchain(
    { action: "airdrop", params: { recipients: recips, amounts: recips.map(() => 1) } },
    fakeConfig(),
    NOW
  );
  assert.ok(errs.some((e) => e.includes("max 20")));

  const over = validateOnchain(
    { action: "airdrop", params: { recipients: [RECIP], amounts: [200_000_000] } },
    fakeConfig(),
    NOW
  );
  assert.ok(over.some((e) => e.includes("exceeds cap")));
});

test("bounty: valid passes; bad pubkey + long memo fail", () => {
  assert.deepEqual(
    validateOnchain(
      { action: "bounty", params: { to: RECIP, amount_lamports: 1_000_000, memo: "gm" } },
      fakeConfig(),
      NOW
    ),
    []
  );
  const errs = validateOnchain(
    { action: "bounty", params: { to: "not-a-key", amount_lamports: 1, memo: "x".repeat(141) } },
    fakeConfig(),
    NOW
  );
  assert.ok(errs.some((e) => e.includes("valid pubkey")));
  assert.ok(errs.some((e) => e.includes("memo")));
});
