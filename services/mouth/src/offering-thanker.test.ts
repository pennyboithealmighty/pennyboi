import test from "node:test";
import assert from "node:assert/strict";
import type { MouthCtx } from "./deps.js";
import { composeOfferingThanks, offeringsThreadId } from "./offering-thanker.js";

function ctx(offerings: number | undefined, kv: Record<string, string> = {}): MouthCtx {
  return {
    cfg: { topics: { offerings } },
    db: { kvGet: (k: string) => kv[k] ?? null },
  } as unknown as MouthCtx;
}

test("offeringsThreadId: config wins, else the learned thread, else undefined", () => {
  assert.equal(offeringsThreadId(ctx(42)), 42); // configured
  assert.equal(offeringsThreadId(ctx(undefined, { offerings_thread_id: "7" })), 7); // learned
  assert.equal(offeringsThreadId(ctx(undefined, { offerings_thread_id: "1" })), undefined); // root/General
  assert.equal(offeringsThreadId(ctx(undefined, {})), undefined); // unknown
});

test("composeOfferingThanks: one named line + Solscan link per donor", () => {
  const msg = composeOfferingThanks("The Allowance swells.", [
    { display: "THE FAITHFUL", sol: 0.05, solscanUrl: "https://solscan.io/tx/aaa?cluster=devnet" },
    { display: "7xKq…9fPa", sol: 0.1, solscanUrl: "https://solscan.io/tx/bbb?cluster=devnet" },
  ]);
  assert.match(msg, /The Allowance swells\./);
  assert.match(msg, /THE FAITHFUL — 0\.050 SOL · https:\/\/solscan\.io\/tx\/aaa/);
  assert.match(msg, /7xKq…9fPa — 0\.100 SOL · https:\/\/solscan\.io\/tx\/bbb/);
  assert.equal(msg.split("\n").filter((l) => l.includes("SOL ·")).length, 2);
});

test("composeOfferingThanks: no named donors -> just the thanks text", () => {
  assert.equal(composeOfferingThanks("Tribute received.", []), "Tribute received.");
});
