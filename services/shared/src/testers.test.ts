import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { buildEligiblePool, type AirdropConfig, type Holder } from "./airdrop.js";
import {
  DEVNET_GENESIS_HASH,
  loadDevnetTesters,
  parseTesterFile,
  testersAsHolders,
  withTesters,
} from "./testers.js";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const A = Keypair.generate().publicKey.toBase58();
const B = Keypair.generate().publicKey.toBase58();
const FILE = `# testers\n${A}\n\n${B}  # second\n${A}\nnot-a-key\n`;

const CFG: AirdropConfig = {
  recipients: 5,
  favoredMax: 2,
  minHoldTokens: 100_000,
  minHoldSecs: 86_400,
  repeatCooldownSecs: 259_200,
  poolMax: 500,
  holderSource: "mock",
};

const good = {
  enabled: true,
  cluster: "devnet",
  rpcUrl: "https://devnet.helius-rpc.com/?api-key=x",
  getGenesisHash: async () => DEVNET_GENESIS_HASH,
  path: "/x/testers.txt",
  readFile: () => FILE,
};

test("parseTesterFile: comments, blanks, duplicates and bad lines", () => {
  assert.deepEqual(parseTesterFile(FILE), { wallets: [A, B], invalid: ["not-a-key"] });
  assert.deepEqual(parseTesterFile(""), { wallets: [], invalid: [] });
});

test("loadDevnetTesters: loads on devnet when every check passes", async () => {
  const r = await loadDevnetTesters(good);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual({ w: r.wallets, i: r.invalid }, { w: [A, B], i: ["not-a-key"] });
});

test("loadDevnetTesters: IMPOSSIBLE on mainnet — each check refuses on its own", async () => {
  let read = 0;
  const readFile = () => {
    read++;
    return FILE;
  };
  // Mainnet genesis hash, even with the env claiming devnet.
  const chain = await loadDevnetTesters({ ...good, readFile, getGenesisHash: async () => MAINNET_GENESIS });
  assert.deepEqual(chain, { ok: false, reason: "the RPC is not Solana devnet (genesis hash mismatch)" });
  // Cluster env says mainnet (or anything else, or nothing).
  for (const cluster of ["mainnet-beta", "mainnet", "testnet", "", "Devnet "]) {
    const r = await loadDevnetTesters({ ...good, readFile, cluster: cluster === "Devnet " ? "Devnet" : cluster });
    assert.equal(r.ok, false, `cluster "${cluster}"`);
  }
  // A mainnet RPC URL.
  const url = await loadDevnetTesters({ ...good, readFile, rpcUrl: "https://mainnet.helius-rpc.com/?api-key=x" });
  assert.deepEqual(url, { ok: false, reason: "the RPC URL names mainnet" });
  // The genesis hash cannot be read.
  const down = await loadDevnetTesters({
    ...good,
    readFile,
    getGenesisHash: async () => {
      throw new Error("timeout");
    },
  });
  assert.equal(down.ok, false);
  assert.equal(read, 0, "the tester file is never even opened when a check fails");
});

test("loadDevnetTesters: off by default; a missing file is an empty list", async () => {
  let asked = 0;
  const off = await loadDevnetTesters({
    ...good,
    enabled: false,
    getGenesisHash: async () => {
      asked++;
      return DEVNET_GENESIS_HASH;
    },
  });
  assert.deepEqual(off, { ok: false, reason: "disabled" });
  assert.equal(asked, 0, "no RPC call when the flag is off");
  const missing = await loadDevnetTesters({ ...good, readFile: () => null });
  assert.ok(missing.ok && missing.wallets.length === 0);
});

test("testers pass every eligibility rule, and the exclusion list still applies", () => {
  const now = 1_800_000_000;
  const testers = testersAsHolders([A, B], now, CFG);
  const opts = { now, lastThresholdTs: now - 3600, exclusions: new Set<string>(), cfg: CFG };
  assert.deepEqual(buildEligiblePool(testers, opts).wallets.sort(), [A, B].sort());
  const excluded = buildEligiblePool(testers, { ...opts, exclusions: new Set([A]) });
  assert.deepEqual(excluded.wallets, [B]);
});

test("withTesters: joins the pool by default, replaces it when exclusive", () => {
  const mock: Holder[] = [
    { address: "mock1", balance: 1, qualifiedSince: 0, lastSellTs: null, lastAirdropTs: null },
    { address: A, balance: 1, qualifiedSince: null, lastSellTs: null, lastAirdropTs: null },
  ];
  const testers = testersAsHolders([A, B], 1_800_000_000, CFG);
  const joined = withTesters(mock, testers, false);
  assert.deepEqual(joined.map((h) => h.address), ["mock1", A, B]);
  assert.equal(joined.find((h) => h.address === A)!.balance, CFG.minHoldTokens, "the tester row wins");
  assert.deepEqual(withTesters(mock, testers, true).map((h) => h.address), [A, B]);
  assert.equal(withTesters(mock, [], true), mock, "no testers -> the pool is untouched");
});
