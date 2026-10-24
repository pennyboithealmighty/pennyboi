import test from "node:test";
import assert from "node:assert/strict";
import { hasDisallowedUrl, stripDisallowedUrls } from "./sanitize.js";

const ALLOWED = ["solscan.io", "t.me", "pump.fun", "github.com"];

test("allows whitelisted hosts", () => {
  assert.equal(
    hasDisallowedUrl("see https://solscan.io/tx/abc?cluster=devnet", ALLOWED),
    false
  );
  assert.equal(hasDisallowedUrl("repo https://github.com/x/y", ALLOWED), false);
});

test("flags and strips non-whitelisted links", () => {
  const text = "free sol at https://evil.example.com/claim now";
  assert.equal(hasDisallowedUrl(text, ALLOWED), true);
  assert.equal(stripDisallowedUrls(text, ALLOWED), "free sol at [link removed] now");
});

test("keeps allowed links intact while stripping others", () => {
  const text = "proof https://solscan.io/tx/s1 and scam http://bad.xyz/x";
  const out = stripDisallowedUrls(text, ALLOWED);
  assert.match(out, /solscan\.io\/tx\/s1/);
  assert.match(out, /\[link removed\]/);
  assert.doesNotMatch(out, /bad\.xyz/);
});
