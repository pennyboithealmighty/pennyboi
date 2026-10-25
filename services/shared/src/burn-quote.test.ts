import test from "node:test";
import assert from "node:assert/strict";
import { minTokensOut, planBurn, priceImpactBps, quoteConstantProduct } from "./burn-quote.js";

const SOL = 1_000_000_000n;

test("quoteConstantProduct: out = tok * in / (sol + in)", () => {
  // 10 SOL reserve, 1e15 token reserve, buy 0.05 SOL.
  const out = quoteConstantProduct(10n * SOL, 1_000_000_000_000_000n, 50_000_000n);
  // 1e15 * 5e7 / (1.0005e10) ≈ 4.9975e12
  assert.ok(out > 4_900_000_000_000n && out < 5_000_000_000_000n, `got ${out}`);
  assert.equal(quoteConstantProduct(0n, 1n, 1n), 0n); // no liquidity
  assert.equal(quoteConstantProduct(1n, 1n, 0n), 0n); // zero in
});

test("priceImpactBps: fraction of the SOL side bought", () => {
  assert.equal(priceImpactBps(100n * SOL, 1n * SOL), Number((1n * 10000n) / 101n)); // ~99 bps
  assert.equal(priceImpactBps(1n * SOL, 1n * SOL), 5000); // buying as much as the reserve -> 50%
});

test("minTokensOut floors by slippage bps", () => {
  assert.equal(minTokensOut(1_000_000n, 300), 970_000n); // 3%
  assert.equal(minTokensOut(1_000_000n, 0), 1_000_000n);
  assert.equal(minTokensOut(1_000_000n, 10000), 0n);
});

test("planBurn: normal case sets a slippage-protected floor", () => {
  const r = planBurn({
    amountLamports: 50_000_000n,
    solReserve: 10n * SOL,
    tokReserve: 1_000_000_000_000_000n,
    slippageBps: 300,
    maxImpactBps: 1000,
  });
  assert.ok(!("skip" in r));
  if (!("skip" in r)) {
    assert.equal(r.shrunk, false);
    assert.ok(r.minTokensOut < r.expectedOut);
    assert.ok(r.minTokensOut > 0n);
    assert.ok(r.impactBps < 1000);
  }
});

test("planBurn: halves the amount once when impact is too high", () => {
  // Buying 0.5 SOL against a 1 SOL reserve = ~33% impact; halving to 0.25 -> ~20%.
  const r = planBurn({
    amountLamports: 500_000_000n,
    solReserve: 1n * SOL,
    tokReserve: 1_000_000_000_000_000n,
    slippageBps: 300,
    maxImpactBps: 2500, // 25%
  });
  assert.ok(!("skip" in r));
  if (!("skip" in r)) {
    assert.equal(r.shrunk, true);
    assert.equal(r.amountLamports, 250_000_000n);
    assert.ok(r.impactBps <= 2500);
  }
});

test("planBurn: skips when impact stays too high even after halving", () => {
  const r = planBurn({
    amountLamports: 500_000_000n,
    solReserve: 1n * SOL,
    tokReserve: 1_000_000_000_000_000n,
    slippageBps: 300,
    maxImpactBps: 1000, // 10% — 0.25/1.25 = 20% still over
  });
  assert.ok("skip" in r);
  if ("skip" in r) assert.match(r.reason, /price impact/);
});

test("planBurn: skips on zero liquidity and zero amount", () => {
  assert.ok("skip" in planBurn({ amountLamports: 0n, solReserve: SOL, tokReserve: SOL, slippageBps: 300, maxImpactBps: 1000 }));
  assert.ok("skip" in planBurn({ amountLamports: SOL, solReserve: SOL, tokReserve: 0n, slippageBps: 300, maxImpactBps: 1000 }));
});
