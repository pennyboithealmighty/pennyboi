import test from "node:test";
import assert from "node:assert/strict";
import { parseDecision, validateDecision } from "./schema.js";
import { BUYER, SELLER, makeBriefing } from "./fixtures.js";

test("parseDecision accepts a clean JSON object", () => {
  const r = parseDecision(
    '{"action":"none","params":{},"reasoning":"x","narration":"I am smol."}'
  );
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.decision.action, "none");
});

test("parseDecision tolerates markdown fences", () => {
  const r = parseDecision(
    '```json\n{"action":"none","params":{},"reasoning":"x","narration":"hi"}\n```'
  );
  assert.ok(r.ok);
});

test("parseDecision rejects prose, arrays, bad action, missing narration", () => {
  assert.equal(parseDecision("I shall burn!").ok, false);
  assert.equal(parseDecision("[1,2,3]").ok, false);
  assert.equal(
    parseDecision('{"action":"explode","params":{},"narration":"x"}').ok,
    false
  );
  assert.equal(parseDecision('{"action":"none","params":{}}').ok, false);
});

test("validateDecision: burn within/over cap", () => {
  const b = makeBriefing();
  assert.deepEqual(
    validateDecision(
      { action: "burn", params: { amount_lamports: 100_000_000 }, reasoning: "", narration: "n" },
      b
    ),
    []
  );
  const over = validateDecision(
    { action: "burn", params: { amount_lamports: 200_000_000 }, reasoning: "", narration: "n" },
    b
  );
  assert.ok(over.some((e) => e.includes("exceeds cap")));
});

test("validateDecision: action not in available_actions", () => {
  const b = makeBriefing({ available_actions: { bounty: { cap_lamports: 50_000_000 } } });
  const errs = validateDecision(
    { action: "burn", params: { amount_lamports: 1 }, reasoning: "", narration: "n" },
    b
  );
  assert.ok(errs.some((e) => e.includes("not in available_actions")));
});

test("validateDecision: airdrop favored must be a candidate (zero favored is fine)", () => {
  const b = makeBriefing();
  // BUYER is the lone favored_candidate in the fixture.
  assert.deepEqual(
    validateDecision(
      { action: "airdrop", params: { favored: [BUYER] }, reasoning: "", narration: "bless" },
      b
    ),
    []
  );
  // Zero favored (let fortune decide all five) is valid.
  assert.deepEqual(
    validateDecision(
      { action: "airdrop", params: { favored: [] }, reasoning: "", narration: "bless" },
      b
    ),
    []
  );
  // SELLER is in the pool-less briefing but NOT a favored_candidate.
  const bad = validateDecision(
    { action: "airdrop", params: { favored: [SELLER] }, reasoning: "", narration: "bless" },
    b
  );
  assert.ok(bad.some((e) => e.includes("not in favored_candidates")));
});

test("validateDecision: airdrop rejects too many favored and duplicates", () => {
  const b = makeBriefing();
  const tooMany = validateDecision(
    { action: "airdrop", params: { favored: [BUYER, BUYER, BUYER] }, reasoning: "", narration: "bless" },
    b
  );
  assert.ok(tooMany.some((e) => e.includes("max 2")));
  assert.ok(tooMany.some((e) => e.includes("duplicated")));
});

test("validateDecision: bounty valid + memo too long", () => {
  const b = makeBriefing();
  assert.deepEqual(
    validateDecision(
      {
        action: "bounty",
        params: { to: SELLER, amount_lamports: 10_000_000, memo: "an offering" },
        reasoning: "",
        narration: "fine",
      },
      b
    ),
    []
  );
  const longMemo = "x".repeat(141);
  const errs = validateDecision(
    {
      action: "bounty",
      params: { to: SELLER, amount_lamports: 10_000_000, memo: longMemo },
      reasoning: "",
      narration: "fine",
    },
    b
  );
  assert.ok(errs.some((e) => e.includes("memo")));
});

test("validateDecision: narration over 280 chars", () => {
  const b = makeBriefing();
  const errs = validateDecision(
    { action: "none", params: {}, reasoning: "", narration: "x".repeat(281) },
    b
  );
  assert.ok(errs.some((e) => e.includes("narration")));
});
