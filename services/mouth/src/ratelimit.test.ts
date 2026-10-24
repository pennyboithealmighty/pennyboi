import test from "node:test";
import assert from "node:assert/strict";
import { ReplyRateLimiter } from "./ratelimit.js";

test("allows at most one reply per topic per interval", () => {
  const rl = new ReplyRateLimiter(90); // 90s
  assert.equal(rl.allow(1, 0), true);
  assert.equal(rl.allow(1, 89_000), false); // inside window
  assert.equal(rl.allow(1, 90_000), true); // window elapsed
});

test("tracks topics independently", () => {
  const rl = new ReplyRateLimiter(90);
  assert.equal(rl.allow(1, 0), true);
  assert.equal(rl.allow(2, 0), true); // different topic, allowed
});

test("quiet mode multiplies the interval", () => {
  const rl = new ReplyRateLimiter(10, 4); // 10s base, x4 quiet
  rl.setQuietUntil(1_000_000);
  assert.equal(rl.allow(1, 0), true);
  assert.equal(rl.allow(1, 30_000), false); // 30s < 40s quiet interval
  assert.equal(rl.allow(1, 41_000), true);
});
