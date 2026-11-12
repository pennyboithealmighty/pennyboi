import test from "node:test";
import assert from "node:assert/strict";
import { fallbackThanks, foldByCooldown, shouldThankOnX, type ThankInput } from "./donations.js";

const LINKISH = /https?:\/\/|@\w+|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

function base(over: Partial<ThankInput> = {}): ThankInput {
  return {
    donor_display: "7xKq…9fPa",
    sol: 0.05,
    tier: "offering",
    is_creator: false,
    donor_offering_count: 1,
    treasury_sol: 1.2,
    ...over,
  };
}

test("fallbackThanks: single gift names donor + amount; X carries no links", () => {
  const t = fallbackThanks(base());
  assert.match(t.telegram, /7xKq…9fPa/);
  assert.match(t.telegram, /0\.05/);
  assert.ok(!LINKISH.test(t.x), "X line must not contain a link/handle/address");
  assert.ok(t.x.length <= 240);
});

test("fallbackThanks: memo quoted in Telegram, never in X", () => {
  const t = fallbackThanks(base({ memo_clean: "for the king" }));
  assert.match(t.telegram, /"for the king"/);
  assert.ok(!t.x.includes("for the king"));
});

test("fallbackThanks: creator, grand, and batch variants", () => {
  assert.match(fallbackThanks(base({ is_creator: true })).telegram, /Creator/i);
  assert.match(fallbackThanks(base({ tier: "grand", sol: 2 })).telegram, /GRAND|legend|thunder|echo/i);
  const b = fallbackThanks(base({ batch_count: 3, batch_total_sol: 0.3 }));
  assert.match(b.telegram, /3/);
  assert.match(b.telegram, /0\.30/);
  assert.ok(!LINKISH.test(b.x));
});

test("shouldThankOnX: grand-only, hard daily cap, mode + prelaunch gates", () => {
  const g = (o: Partial<Parameters<typeof shouldThankOnX>[0]>) =>
    shouldThankOnX({ mode: "live", xInPrelaunch: false, tier: "grand", postsToday: 0, maxPerDay: 1, ...o });

  assert.equal(g({ mode: "off" }), false);
  assert.equal(g({ mode: "prelaunch", xInPrelaunch: false }), false); // prelaunch gate wins even for grand
  assert.equal(g({ mode: "prelaunch", xInPrelaunch: true }), true);
  assert.equal(g({ tier: "offering" }), false); // only grand earns an X post
  assert.equal(g({ tier: "dust" }), false);
  assert.equal(g({ postsToday: 0, maxPerDay: 1 }), true);
  assert.equal(g({ postsToday: 1, maxPerDay: 1 }), false); // hard cap, no grand bypass
});

test("fallbackThanks respects the channel limits (TG ≤200, X ≤180)", () => {
  const long = "x".repeat(70);
  const t = fallbackThanks(base({ memo_clean: long, donor_display: "7xKq…9fPa" }));
  assert.ok(t.telegram.length <= 200, `tg ${t.telegram.length}`);
  assert.ok(t.x.length <= 180, `x ${t.x.length}`);
});

test("foldByCooldown: one named row per eligible donor; rest folded", () => {
  const rows = [
    { donor: "A", tx: 1 },
    { donor: "B", tx: 2 },
    { donor: "A", tx: 3 }, // duplicate donor in the same batch
    { donor: "C", tx: 4 }, // C is in cooldown
  ];
  const { named, folded } = foldByCooldown(rows, (d) => d === "C");
  assert.deepEqual(named.map((r) => r.donor), ["A", "B"]);
  assert.deepEqual(
    folded.map((r) => r.tx).sort(),
    [3, 4]
  );
});
