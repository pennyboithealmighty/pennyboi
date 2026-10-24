import test from "node:test";
import assert from "node:assert/strict";
import { executeDecision, type ExecDeps } from "./execute.js";
import { RECIP, fakeConfig } from "./fixtures.js";
import type { Decision } from "./types.js";

function deps(over: Partial<ExecDeps> = {}): ExecDeps & { submitted: Decision[] } {
  const submitted: Decision[] = [];
  const base: ExecDeps = {
    getConfig: async () => fakeConfig(),
    submit: async (d) => {
      submitted.push(d);
      return "SIGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    },
    isPaused: () => false,
    solscan: (sig) => `https://solscan.io/tx/${sig}?cluster=devnet`,
    nowSecs: () => 1000,
    ...over,
  };
  return Object.assign(base, { submitted });
}

test("none is skipped without touching the chain", async () => {
  const d = deps({
    getConfig: async () => {
      throw new Error("should not read config");
    },
  });
  const r = await executeDecision({ action: "none", params: {} }, d);
  assert.equal(r.status, "skipped");
  assert.equal(d.submitted.length, 0);
});

test("paused short-circuits before any chain read or submit", async () => {
  const d = deps({
    isPaused: () => true,
    getConfig: async () => {
      throw new Error("should not read config while paused");
    },
  });
  const r = await executeDecision({ action: "burn", params: { amount_lamports: 1 } }, d);
  assert.equal(r.status, "paused");
  assert.equal(d.submitted.length, 0);
});

test("invalid decision is not submitted", async () => {
  const d = deps();
  const r = await executeDecision(
    { action: "burn", params: { amount_lamports: 999_000_000 } },
    d
  );
  assert.equal(r.status, "invalid");
  assert.ok(r.error?.includes("exceeds cap"));
  assert.equal(d.submitted.length, 0);
});

test("valid decision is submitted and returns a Solscan link", async () => {
  const d = deps();
  const r = await executeDecision(
    { action: "bounty", params: { to: RECIP, amount_lamports: 1_000_000, memo: "gm" } },
    d
  );
  assert.equal(r.status, "submitted");
  assert.ok(r.signature);
  assert.match(r.solscanUrl!, /solscan\.io\/tx\/.*cluster=devnet/);
  assert.equal(d.submitted.length, 1);
});

test("a submit that throws is reported as failed", async () => {
  const d = deps({
    submit: async () => {
      throw new Error("blockhash expired");
    },
  });
  const r = await executeDecision(
    { action: "burn", params: { amount_lamports: 50_000_000 } },
    d
  );
  assert.equal(r.status, "failed");
  assert.ok(r.error?.includes("blockhash"));
});
