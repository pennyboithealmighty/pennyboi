// Buyback planning (docs/13 §3): quote a constant-product venue, derive the
// slippage-protected min_tokens_out, and bound price impact. Pure + testable; no
// chain access. The on-chain program is the real guard (min_tokens_out is
// enforced there) — this just picks a sane amount + floor off a fresh quote.

/** Constant-product output: out = tok * in / (sol + in). */
export function quoteConstantProduct(solReserve: bigint, tokReserve: bigint, amountIn: bigint): bigint {
  if (amountIn <= 0n || solReserve <= 0n || tokReserve <= 0n) return 0n;
  return (tokReserve * amountIn) / (solReserve + amountIn);
}

/** Price impact in bps = fraction of the SOL side you're buying: in / (sol + in). */
export function priceImpactBps(solReserve: bigint, amountIn: bigint): number {
  const denom = solReserve + amountIn;
  if (denom <= 0n) return 10000;
  return Number((amountIn * 10000n) / denom);
}

/** floor(expectedOut * (1 - slippageBps/10000)). */
export function minTokensOut(expectedOut: bigint, slippageBps: number): bigint {
  const keep = BigInt(Math.max(0, 10000 - slippageBps));
  return (expectedOut * keep) / 10000n;
}

export interface BurnPlan {
  amountLamports: bigint; // possibly halved from the request if impact was high
  minTokensOut: bigint;
  expectedOut: bigint;
  impactBps: number;
  shrunk: boolean;
}

export type BurnPlanResult = BurnPlan | { skip: true; reason: string };

/**
 * Decide the burn's amount + min_tokens_out from fresh reserves (docs/13 §3.3):
 * if price impact exceeds `maxImpactBps`, shrink the amount by half once; if it's
 * still too high, skip (the caller falls back to `none`).
 */
export function planBurn(args: {
  amountLamports: bigint;
  solReserve: bigint;
  tokReserve: bigint;
  slippageBps: number;
  maxImpactBps: number;
}): BurnPlanResult {
  let amount = args.amountLamports;
  if (amount <= 0n) return { skip: true, reason: "amount is zero" };

  let impact = priceImpactBps(args.solReserve, amount);
  let shrunk = false;
  if (impact > args.maxImpactBps) {
    amount = amount / 2n;
    shrunk = true;
    impact = priceImpactBps(args.solReserve, amount);
    if (impact > args.maxImpactBps) {
      return { skip: true, reason: `price impact ${impact}bps > ${args.maxImpactBps}bps even after halving` };
    }
  }

  const expectedOut = quoteConstantProduct(args.solReserve, args.tokReserve, amount);
  if (expectedOut <= 0n) return { skip: true, reason: "no liquidity / zero quote" };
  const min = minTokensOut(expectedOut, args.slippageBps);
  if (min <= 0n) return { skip: true, reason: "min_tokens_out rounds to zero" };

  return { amountLamports: amount, minTokensOut: min, expectedOut, impactBps: impact, shrunk };
}
