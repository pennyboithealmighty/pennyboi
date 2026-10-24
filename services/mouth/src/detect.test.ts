import test from "node:test";
import assert from "node:assert/strict";
import { foreignAddress, isScam } from "./detect.js";

const MINT = "So11111111111111111111111111111111111111112";
const VAULT = "Vote111111111111111111111111111111111111111";

test("detects scam phrasings", () => {
  assert.equal(isScam("DM me for your airdrop"), true);
  assert.equal(isScam("connect your wallet to verify"), true);
  assert.equal(isScam("send me your seed phrase"), true);
  assert.equal(isScam("gm congregation, wen burn"), false);
});

test("flags a foreign address but not the mint/vault", () => {
  const foreign = "9yLmQ4oRf2nXwS3uZvBcDeFgHiJkMnPpQrStUvWxYzAb";
  assert.equal(foreignAddress(`buy ${foreign} now`, [MINT, VAULT]), foreign);
  assert.equal(foreignAddress(`our mint is ${MINT}`, [MINT, VAULT]), null);
  assert.equal(foreignAddress("no addresses here", [MINT, VAULT]), null);
});
