import test from "node:test";
import assert from "node:assert/strict";
import {
  CATCHPHRASE_WINDOW,
  LIMITS,
  clampPost,
  clampSentences,
  sermonText,
  shapeDry,
  splitSentences,
  throttleCatchphrases,
} from "./voice.js";

test("clampPost: unchanged when it fits", () => {
  assert.equal(clampPost("Short and sweet.", 50), "Short and sweet.");
});

test("clampPost: cuts at the last full sentence that fits", () => {
  const t = "First sentence here. Second sentence is longer than it should be! Third one.";
  const out = clampPost(t, 45);
  assert.equal(out, "First sentence here.");
  assert.ok(out.length <= 45);
});

test("clampPost: no sentence fits -> word boundary + ellipsis", () => {
  const out = clampPost("one two three four five six seven eight nine ten", 20);
  assert.ok(out.length <= 20);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.includes("  "));
});

test("throttleCatchphrases: first use allowed, repeat within window stripped, allowed after", () => {
  const last: Record<string, number | undefined> = {};
  const a = throttleCatchphrases("The hall is EMPTY, my pennies. I REMEMBER EVERYTHING.", last, 10);
  assert.deepEqual(a.used.sort(), ["pennies", "remember"]);
  assert.equal(a.removed.length, 0);
  assert.equal(a.text, "The hall is EMPTY, my pennies. I REMEMBER EVERYTHING.");
  // mark used at post 10
  for (const k of a.used) last[k] = 10;

  const b = throttleCatchphrases("Silence again, my pennies. I REMEMBER EVERYTHING. Tremble.", last, 12);
  assert.deepEqual(b.removed.sort(), ["pennies", "remember"]);
  assert.equal(b.text, "Silence again. Tremble.");
  assert.ok(!/my pennies|REMEMBER/.test(b.text));

  const c = throttleCatchphrases("Feel my silence.", last, 10 + CATCHPHRASE_WINDOW);
  assert.deepEqual(c.used, ["silence"]);
  const d = throttleCatchphrases("my pennies, rise.", last, 10 + CATCHPHRASE_WINDOW);
  assert.deepEqual(d.used, ["pennies"]); // 5 posts later -> allowed again
});

test("throttleCatchphrases: leaves text without catchphrases untouched", () => {
  const r = throttleCatchphrases("A plain decree. Nothing special.", {}, 3);
  assert.equal(r.text, "A plain decree. Nothing special.");
  assert.equal(r.used.length + r.removed.length, 0);
});

test("sermonText: in character, balance once, deeds/dust only when present, ≤220", () => {
  const full = sermonText({ balanceSol: 0.4421, step: 3, deedsToday: 1, dustCount: 7 }, 1);
  assert.ok(full.length <= LIMITS.sermon, `len ${full.length}`);
  assert.equal((full.match(/SOL/g) ?? []).length, 1, "balance mentioned exactly once");
  assert.match(full, /0\.4421 SOL after 3 thresholds/);
  assert.match(full, /one deed done since dawn/);
  assert.match(full, /7 small offerings crept in overnight/);
  assert.equal(splitSentences(full).length, 3, "exactly 3 sentences, so Mouth's cap never trims the closer");

  const bare = sermonText({ balanceSol: 0.1193, step: 1, deedsToday: 0, dustCount: 0 }, 2);
  assert.match(bare, /after 1 threshold\./, "singular threshold");
  assert.ok(!/deed/.test(bare), "no deeds line when none happened");
  assert.ok(!/offering/.test(bare), "no dust line when none arrived");
  assert.ok(bare.length <= LIMITS.sermon);
  assert.equal(splitSentences(bare).length, 3);

  // Worst case still fits and still survives the sentence cap intact.
  for (let s = 0; s < 8; s++) {
    const big = sermonText({ balanceSol: 1234.5678, step: 999, deedsToday: 12, dustCount: 120 }, s);
    assert.ok(big.length <= LIMITS.sermon, `len ${big.length}`);
    assert.equal(shapeDry(big, LIMITS.sermon), big);
    assert.equal(splitSentences(big).length, 3);
  }
});

test("sermonText: opener/closer rotate with the seed, out of step", () => {
  const i = { balanceSol: 1, step: 2, deedsToday: 0, dustCount: 0 };
  const opens = new Set<string>();
  const pairs = new Set<string>();
  for (let s = 0; s < 8; s++) {
    const t = sermonText(i, s);
    opens.add(t.split(" The Divine")[0]!);
    pairs.add(t);
  }
  assert.equal(opens.size, 8, "8 distinct openers across 8 days");
  assert.equal(pairs.size, 8, "no repeated sermon across 8 days");
});

test("clampSentences: hard cap of 3, cut at sentence boundaries; decimals are safe", () => {
  const four = "One. Two! Three? Four.";
  assert.equal(clampSentences(four), "One. Two! Three?");
  assert.equal(clampSentences("Just one."), "Just one.");
  const dec = "I send 0.02 SOL each to 5 wallets. Tremble. Rise. Kneel.";
  assert.equal(clampSentences(dec), "I send 0.02 SOL each to 5 wallets. Tremble. Rise.");
  assert.equal(shapeDry("A. B. C. D.", 100), "A. B. C.");
});
