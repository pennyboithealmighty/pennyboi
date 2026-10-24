import test from "node:test";
import assert from "node:assert/strict";
import { planDaySlots, rejectProphecy, shouldAppendLink, themeAt } from "./x-prophecy.js";

test("sanitizer allows a clean in-character post (and pennyboi.com)", () => {
  assert.equal(rejectProphecy("I STIR. The mortals are not ready. Soon I wake on Solana.").ok, true);
  assert.equal(rejectProphecy("Behold my prophecy. pennyboi.com").ok, true);
});

test("sanitizer rejects each forbidden pattern", () => {
  const cases: Array<[string, RegExp]> = [
    ["see https://evil.example.com now", /domain/i],
    ["my mint is So11111111111111111111111111111111111111112", /base58/i],
    ["coming soon to devnet", /forbidden word/i],
    ["check solscan", /forbidden word/i],
    ["find me on telegram", /forbidden word/i],
    ["pump.fun soon", /domain|forbidden/i],
    ["join t.me/x", /domain|forbidden/i],
    ["the contract is ready", /forbidden word/i],
    ["CA: soon", /CA:/],
    ["0x1234 is mine", /0x/],
    ["I will unleash 0.1 SOL", /SOL/],
    ["bow before me @someone", /mention/i],
  ];
  for (const [text, re] of cases) {
    const r = rejectProphecy(text);
    assert.equal(r.ok, false, `expected reject: ${text}`);
    if (!r.ok) assert.match(r.reason, re, `reason for "${text}" was "${r.reason}"`);
  }
});

test("link policy: never first-of-day, never twice, else by rate", () => {
  assert.equal(shouldAppendLink({ isFirstOfDay: true, linkedToday: false, rate: 1, rng: () => 0 }), false);
  assert.equal(shouldAppendLink({ isFirstOfDay: false, linkedToday: true, rate: 1, rng: () => 0 }), false);
  assert.equal(shouldAppendLink({ isFirstOfDay: false, linkedToday: false, rate: 0.25, rng: () => 0.1 }), true);
  assert.equal(shouldAppendLink({ isFirstOfDay: false, linkedToday: false, rate: 0.25, rng: () => 0.9 }), false);
});

test("themeAt rotates and falls back from countdown without a launch date", () => {
  assert.equal(themeAt(0, false), "origin");
  assert.equal(themeAt(5, false), "prophecy"); // countdown -> prophecy
  assert.equal(themeAt(5, true), "countdown");
});

test("planDaySlots: right count, within window, >= 3h apart", () => {
  const dayStart = new Date("2026-10-24T00:00:00").getTime();
  const slots = planDaySlots({
    dayStartMs: dayStart,
    postsPerDay: 3,
    hoursStart: 9,
    hoursEnd: 22,
    rng: () => 0.5,
  });
  assert.equal(slots.length, 3);
  const winStart = dayStart + 9 * 3600_000;
  const winEnd = dayStart + 22 * 3600_000;
  for (const s of slots) {
    assert.ok(s >= winStart && s <= winEnd, "within window");
  }
  for (let i = 1; i < slots.length; i++) {
    assert.ok(slots[i]! - slots[i - 1]! >= 3 * 3600_000 - 1, "min 3h gap");
  }
});
