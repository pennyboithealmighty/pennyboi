import test from "node:test";
import assert from "node:assert/strict";
import { isExecutedDecree } from "./announce.js";

test("only an executed on-chain decree is announced publicly", () => {
  assert.equal(isExecutedDecree("burn", "submitted"), true);
  assert.equal(isExecutedDecree("airdrop", "submitted"), true);
  assert.equal(isExecutedDecree("bounty", "submitted"), true);
});

test("'none' decisions and non-executed attempts stay silent", () => {
  assert.equal(isExecutedDecree("none", "skipped"), false); // "The hall is EMPTY…" never posts
  assert.equal(isExecutedDecree("none", "submitted"), false);
  assert.equal(isExecutedDecree("burn", "failed"), false);
  assert.equal(isExecutedDecree("burn", "invalid"), false);
  assert.equal(isExecutedDecree("burn", "paused"), false);
  assert.equal(isExecutedDecree("airdrop", "narrated"), false);
});
