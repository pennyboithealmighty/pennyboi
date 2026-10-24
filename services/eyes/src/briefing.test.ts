import test from "node:test";
import assert from "node:assert/strict";
import { renderBriefing, type VaultConfig } from "@pennyboi/shared";
import { buildBriefing } from "./briefing-builder.js";
import { ActivityWindow } from "./activity.js";

function fakeConfig(over: Partial<VaultConfig> = {}): VaultConfig {
  return {
    admin: "ADMIN",
    agent: "AGENT",
    tokenMint: "MINT",
    thresholdLamports: 2_000_000_000,
    lastThresholdBalance: 2_000_000_000,
    thresholdStep: 3,
    actionsAvailable: 1,
    maxBankedActions: 50,
    burnCapLamports: 100_000_000,
    airdropCapLamports: 100_000_000,
    airdropMaxRecipients: 20,
    bountyCapLamports: 50_000_000,
    burnCooldownSecs: 100,
    airdropCooldownSecs: 100,
    bountyCooldownSecs: 0,
    lastBurnTs: 0,
    lastAirdropTs: 990, // 990 + 100 = 1090 > now(1000) -> still on cooldown
    lastBountyTs: 0,
    idleFloorSecs: 86400,
    lastActionTs: 0,
    escapeTimelockSecs: 3600,
    pendingWithdraw: false,
    pendingConfig: false,
    ...over,
  };
}

test("available_actions omits actions still on cooldown", () => {
  const activity = new ActivityWindow();
  const b = buildBriefing(fakeConfig(), 4.2, activity, 1000, { mood: "petty" });
  assert.ok(b.available_actions.burn, "burn should be off cooldown");
  assert.ok(b.available_actions.bounty, "bounty should be off cooldown");
  assert.equal(b.available_actions.airdrop, undefined, "airdrop should be on cooldown");
  assert.equal(b.available_actions.burn!.cap_lamports, 100_000_000);
  assert.equal(b.treasury.threshold_step, 3);
  assert.equal(b.treasury.balance_sol, 4.2);
  assert.equal(b.mood, "petty");
});

test("builder pulls top buyers/sellers and volume from activity", () => {
  const activity = new ActivityWindow();
  activity.recordMany([
    { wallet: "A", kind: "buy", sol: 1.0, token: 10 },
    { wallet: "B", kind: "buy", sol: 0.5, token: 5 },
    { wallet: "C", kind: "sell", sol: 0.3, token: 3 },
  ]);
  const b = buildBriefing(fakeConfig(), 4.2, activity, 1000, { mood: "greedy" });
  assert.equal(b.since_last_threshold.top_new_buyers[0]!.wallet, "A");
  assert.equal(b.since_last_threshold.biggest_sellers[0]!.wallet, "C");
  assert.equal(b.since_last_threshold.volume_sol, 1.8);
  assert.equal(b.since_last_threshold.holder_count_change, 1); // 2 buyers - 1 seller
});

test("airdrop pool enrichment: object is used, null omits airdrop", () => {
  const activity = new ActivityWindow();
  const cfg = fakeConfig({ lastAirdropTs: 0, airdropCooldownSecs: 0 }); // airdrop off cooldown
  const enriched = {
    cap_lamports: 100_000_000,
    max_recipients: 5,
    recipients: 5,
    favored_max: 2,
    pool_size: 3,
    favored_candidates: [{ wallet: "WPOOL", held_hours: 12, balance_tokens: 500_000 }],
  };
  const b = buildBriefing(cfg, 4.2, activity, 1000, { mood: "greedy", airdrop: enriched });
  assert.ok(b.available_actions.airdrop, "airdrop present when off cooldown");
  assert.equal(b.available_actions.airdrop!.pool_size, 3);

  const text = renderBriefing(b);
  assert.match(text, /airdrop: \{ cap_lamports: 100000000, recipients: 5, favored_max: 2, pool_size: 3 \}/);
  assert.match(text, /favored_candidates:/);
  assert.match(text, /"wallet":"WPOOL"/);

  const omitted = buildBriefing(cfg, 4.2, activity, 1000, { airdrop: null });
  assert.equal(omitted.available_actions.airdrop, undefined, "empty pool -> airdrop omitted");
});

test("renderBriefing produces the expected header and sections", () => {
  const activity = new ActivityWindow();
  const b = buildBriefing(fakeConfig(), 4.2, activity, 1000, { mood: "bored" });
  const text = renderBriefing(b);
  assert.match(text, /^THRESHOLD CROSSED\. Choose one action\./);
  assert.match(text, /mood: bored/);
  assert.match(text, /available_actions:/);
  assert.match(text, /burn:\s+\{ cap_lamports: 100000000 \}/);
  assert.match(text, /threshold_step: 3/);
});
