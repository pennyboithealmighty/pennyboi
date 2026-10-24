import test from "node:test";
import assert from "node:assert/strict";
import { decide, type CallLLM } from "./decide.js";
import { STOCK_SULK } from "./system-prompt.js";
import { BUYER, makeBriefing } from "./fixtures.js";

/** A CallLLM that returns queued responses, recording the user messages it saw. */
function scripted(responses: Array<string | Error>): { call: CallLLM; seen: string[] } {
  const seen: string[] = [];
  let i = 0;
  const call: CallLLM = async (_system, user) => {
    seen.push(user);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return r!;
  };
  return { call, seen };
}

test("returns a valid decision on the first attempt", async () => {
  const { call } = scripted([
    '{"action":"burn","params":{"amount_lamports":50000000},"reasoning":"hungry","narration":"BURN"}',
  ]);
  const res = await decide({ briefing: makeBriefing(), callLLM: call });
  assert.equal(res.fellBack, false);
  assert.equal(res.attempts, 1);
  assert.equal(res.decision.action, "burn");
});

test("retries once on a parse failure, then succeeds", async () => {
  const { call, seen } = scripted([
    "I shall BURN, mortals!", // not JSON
    '{"action":"none","params":{},"reasoning":"nothing worthy","narration":"I sulk."}',
  ]);
  const res = await decide({ briefing: makeBriefing(), callLLM: call });
  assert.equal(res.fellBack, false);
  assert.equal(res.attempts, 2);
  assert.equal(res.decision.action, "none");
  // The retry prompt carries the rejection reason.
  assert.match(seen[1]!, /rejected/);
});

test("falls back to none + sulk when validation fails twice", async () => {
  const overCap =
    '{"action":"burn","params":{"amount_lamports":999000000},"reasoning":"greed","narration":"MORE"}';
  const { call } = scripted([overCap, overCap]);
  const res = await decide({ briefing: makeBriefing(), callLLM: call });
  assert.equal(res.fellBack, true);
  assert.equal(res.decision.action, "none");
  assert.equal(res.decision.narration, STOCK_SULK);
  assert.ok(res.errors.length >= 2);
  // Both attempts are recorded with their raw text + rejection reason.
  assert.equal(res.attemptsLog.length, 2);
  assert.ok(res.attemptsLog.every((a) => !a.ok && a.raw === overCap && a.error));
});

test("falls back when the LLM call throws both times", async () => {
  const { call } = scripted([new Error("timeout"), new Error("timeout")]);
  const res = await decide({ briefing: makeBriefing(), callLLM: call });
  assert.equal(res.fellBack, true);
  assert.equal(res.decision.action, "none");
});

test("accepts a valid airdrop favoring a candidate wallet", async () => {
  const { call } = scripted([
    `{"action":"airdrop","params":{"favored":["${BUYER}"]},"reasoning":"loyal","narration":"Two I chose. Three the chain chose for me."}`,
  ]);
  const res = await decide({ briefing: makeBriefing(), callLLM: call });
  assert.equal(res.fellBack, false);
  assert.equal(res.decision.action, "airdrop");
});
