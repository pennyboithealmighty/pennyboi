import test from "node:test";
import assert from "node:assert/strict";
import type { ThankInput } from "@pennyboi/shared";
import type { CallLLM } from "./decide.js";
import { generateThank, parseThank } from "./thank.js";

function scripted(responses: Array<string | Error>): CallLLM {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r as string;
  };
}

const INPUT: ThankInput = {
  donor_display: "7xKq…9fPa",
  sol: 0.05,
  tier: "offering",
  is_creator: false,
  donor_offering_count: 1,
  treasury_sol: 1,
};

test("parseThank: accepts a clean pair", () => {
  const r = parseThank('{"telegram":"I see you, mortal.","x":"The Allowance swells."}');
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.thanks.x, "The Allowance swells.");
});

test("parseThank: rejects missing fields, non-JSON, and over-length", () => {
  assert.equal(parseThank('{"telegram":"hi"}').ok, false);
  assert.equal(parseThank("not json").ok, false);
  assert.equal(parseThank(`{"telegram":"${"a".repeat(241)}","x":"ok"}`).ok, false);
});

test("parseThank: rejects an X line carrying a link / handle / address", () => {
  assert.equal(parseThank('{"telegram":"hi","x":"visit https://evil.xyz"}').ok, false);
  assert.equal(parseThank('{"telegram":"hi","x":"dm @pennyboi"}').ok, false);
  assert.equal(parseThank('{"telegram":"hi","x":"So11111111111111111111111111111111111111112"}').ok, false);
});

test("generateThank: valid LLM output used as-is", async () => {
  const r = await generateThank(INPUT, scripted(['{"telegram":"ty mortal","x":"ty"}']));
  assert.equal(r.fellBack, false);
  assert.equal(r.thanks.telegram, "ty mortal");
});

test("generateThank: retries once, then succeeds", async () => {
  const r = await generateThank(INPUT, scripted(["garbage", '{"telegram":"ok","x":"ok"}']));
  assert.equal(r.fellBack, false);
  assert.equal(r.attempts, 2);
});

test("generateThank: falls back to templates when the LLM keeps failing", async () => {
  const r = await generateThank(INPUT, scripted([new Error("boom"), new Error("boom")]));
  assert.equal(r.fellBack, true);
  assert.match(r.thanks.telegram, /7xKq…9fPa/); // template names the donor
  assert.ok(!/https?:\/\//.test(r.thanks.x));
});
