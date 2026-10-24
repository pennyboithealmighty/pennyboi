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

test("validateDecision: airdrop recipient must come from the briefing", () => {
  const b = makeBriefing();
  const good = validateDecision(
    {
      action: "airdrop",
      params: { recipients: [BUYER], amounts: [10_000_000] },
      reasoning: "",
      narration: "bless",
    },
    b
  );
  assert.deepEqual(good, []);

  const bad = validateDecision(
    {
      action: "airdrop",
      params: { recipients: ["1111111111111111111111111111111111"], amounts: [10_000_000] },
      reasoning: "",
      narration: "bless",
    },
    b
  );
  assert.ok(bad.some((e) => e.includes("not from the briefing")));
});

test("validateDecision: airdrop total over cap", () => {
  const b = makeBriefing();
  const errs = validateDecision(
    {
      action: "airdrop",
      params: { recipients: [BUYER, SELLER], amounts: [60_000_000, 60_000_000] },
      reasoning: "",
      narration: "bless",
    },
    b
  );
  assert.ok(errs.some((e) => e.includes("exceeds cap")));
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
