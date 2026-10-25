import test from "node:test";
import assert from "node:assert/strict";
import { shortDonor, type DonationRow } from "@pennyboi/shared";
import {
  buildDecrees,
  corsOrigin,
  publicOffering,
  RateLimiter,
  sanitizeMentions,
  sanitizeOfferings,
  truncAddr,
  TtlCache,
} from "./public-api.js";

test("corsOrigin: allowlist + localhost, rejects others", () => {
  assert.equal(corsOrigin("https://pennyboi.com"), "https://pennyboi.com");
  assert.equal(corsOrigin("https://www.pennyboi.com"), "https://www.pennyboi.com");
  assert.equal(corsOrigin("http://localhost:4599"), "http://localhost:4599");
  assert.equal(corsOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(corsOrigin("https://evil.example.com"), null);
  assert.equal(corsOrigin(undefined), null);
  assert.equal(corsOrigin("https://pennyboi.com.evil.com"), null);
  // extra origin via config
  assert.equal(corsOrigin("https://staging.pennyboi.com", ["https://staging.pennyboi.com"]), "https://staging.pennyboi.com");
});

test("RateLimiter: 60/min then blocks, resets after window", () => {
  const rl = new RateLimiter(60, 60_000);
  for (let i = 0; i < 60; i++) assert.equal(rl.allow("1.2.3.4", 1000), true);
  assert.equal(rl.allow("1.2.3.4", 1000), false); // 61st
  assert.equal(rl.allow("9.9.9.9", 1000), true); // other IP unaffected
  assert.equal(rl.allow("1.2.3.4", 1000 + 60_001), true); // window elapsed
});

test("TtlCache: serves cached within TTL, refreshes after", async () => {
  const c = new TtlCache<number>(30_000);
  let calls = 0;
  const produce = async () => { calls++; return calls; };
  assert.equal(await c.wrap("k", produce, 0), 1);
  assert.equal(await c.wrap("k", produce, 10_000), 1); // cached
  assert.equal(calls, 1);
  assert.equal(await c.wrap("k", produce, 40_000), 2); // expired -> refetch
});

test("truncAddr shortens long addresses", () => {
  assert.equal(truncAddr("So11111111111111111111111111111111111111112"), "So1111…1112");
  assert.equal(truncAddr("short"), "short");
});

test("buildDecrees merges + sorts + links tx + drops empties", () => {
  const actions = [
    { ts: 100, narration: "BURN", tx_sig: "sigA" },
    { ts: 300, narration: "", tx_sig: "sigB" }, // empty -> dropped
    { ts: 200, narration: "NONE", tx_sig: null },
  ];
  const xposts = [
    { ts: 250, text: "I STIR", status: "posted", x_post_id: "1234567890" },
    { ts: 260, text: "rejected one", status: "rejected", x_post_id: null }, // dropped
    { ts: 270, text: "posted, no id yet", status: "posted", x_post_id: null },
  ];
  const out = buildDecrees(actions, xposts, 10, (s) => "https://solscan.io/tx/" + s);
  assert.deepEqual(out.map((d) => d.ts), [270, 250, 200, 100]); // desc, empties/rejected dropped
  assert.equal(out.find((d) => d.ts === 100)!.solscanUrl, "https://solscan.io/tx/sigA");
  assert.equal(out.find((d) => d.ts === 200)!.solscanUrl, undefined); // no-op stays unlinked
  assert.equal(out.find((d) => d.ts === 250)!.kind, "prophecy");
  assert.equal(out.find((d) => d.ts === 250)!.xPostId, "1234567890"); // X id flows through
  assert.equal(out.find((d) => d.ts === 270)!.xPostId, undefined); // posted but no id -> unlinked
});

test("buildDecrees honors the limit (latest N)", () => {
  const actions = Array.from({ length: 8 }, (_, i) => ({
    ts: 100 + i,
    narration: "d" + i,
    tx_sig: "sig" + i,
  }));
  const out = buildDecrees(actions, [], 4, (s) => "https://solscan.io/tx/" + s);
  assert.deepEqual(out.map((d) => d.ts), [107, 106, 105, 104]); // newest 4 only
});

test("sanitizeOfferings never leaks usernames/ids", () => {
  const out = sanitizeOfferings([{ text: "burn it", upvotes: 3 }]);
  assert.deepEqual(out, [{ by: "a mortal", text: "burn it", upvotes: 3 }]);
  assert.ok(!("wallet" in out[0]!));
  assert.ok(!("tg_user_id" in (out[0]! as Record<string, unknown>)));
});

test("sanitizeMentions truncates the wallet", () => {
  const out = sanitizeMentions([
    { wallet: "Vote111111111111111111111111111111111111111", nickname: "THE FAITHFUL", reason: "blessed" },
  ]);
  assert.equal(out[0]!.wallet, "Vote11…1111");
  assert.equal(out[0]!.nickname, "THE FAITHFUL");
});

test("publicOffering: 4+4 short, nickname display, never leaks the full address", () => {
  const donor = "So11111111111111111111111111111111111111112";
  const row: DonationRow = {
    tx_sig: "sigX",
    ts: 100,
    slot: 1,
    donor,
    lamports: 50_000_000,
    is_creator: 1,
    reference: null,
    memo_raw: "gm ser",
    memo_clean: "gm ser",
    tier: "offering",
    announced_tg: 0,
    announced_x: 0,
    narration: null,
  };
  const url = "https://solscan.io/tx/sigX?cluster=devnet";
  const o = publicOffering(row, { nickname: "THE FAITHFUL", solscanUrl: url });
  assert.equal(o.donor_display, "THE FAITHFUL");
  assert.equal(o.donor_short, shortDonor(donor));
  assert.equal(o.is_creator, true);
  assert.equal(o.sol, 0.05);
  assert.equal(o.memo_clean, "gm ser");
  assert.equal(o.solscan_url, url);
  assert.ok(!("donor" in o), "full donor address must not be exposed");
  // Without a nickname, display falls back to the 4+4 short form.
  assert.equal(publicOffering(row, { nickname: null, solscanUrl: url }).donor_display, shortDonor(donor));
});
