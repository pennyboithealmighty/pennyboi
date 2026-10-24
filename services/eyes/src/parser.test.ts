import test from "node:test";
import assert from "node:assert/strict";
import { asTxArray, parseTrades } from "./parser.js";

const MINT = "MINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

test("asTxArray accepts an array and a { transactions } wrapper", () => {
  assert.equal(asTxArray([{ signature: "a" }]).length, 1);
  assert.equal(asTxArray({ transactions: [{ signature: "a" }] }).length, 1);
  assert.equal(asTxArray({}).length, 0);
  assert.equal(asTxArray(null).length, 0);
});

test("parseTrades maps a buy: receiver of mint, with their SOL outflow", () => {
  const payload = [
    {
      signature: "sig-buy",
      tokenTransfers: [
        { fromUserAccount: "POOL", toUserAccount: "BUYER", tokenAmount: 1000, mint: MINT },
      ],
      nativeTransfers: [
        { fromUserAccount: "BUYER", toUserAccount: "POOL", amount: 500_000_000 }, // 0.5 SOL
      ],
    },
  ];
  const trades = parseTrades(payload, MINT);
  const buy = trades.find((t) => t.wallet === "BUYER");
  assert.ok(buy, "expected a BUYER trade");
  assert.equal(buy!.kind, "buy");
  assert.equal(buy!.sol, 0.5);
  assert.equal(buy!.token, 1000);
});

test("parseTrades maps a sell: sender of mint, with their SOL inflow", () => {
  const payload = [
    {
      signature: "sig-sell",
      tokenTransfers: [
        { fromUserAccount: "SELLER", toUserAccount: "POOL", tokenAmount: 2000, mint: MINT },
      ],
      nativeTransfers: [
        { fromUserAccount: "POOL", toUserAccount: "SELLER", amount: 300_000_000 }, // 0.3 SOL
      ],
    },
  ];
  const trades = parseTrades(payload, MINT);
  const sell = trades.find((t) => t.wallet === "SELLER");
  assert.ok(sell, "expected a SELLER trade");
  assert.equal(sell!.kind, "sell");
  assert.equal(sell!.sol, 0.3);
});

test("parseTrades ignores transfers of other mints and empty mint", () => {
  const payload = [
    {
      tokenTransfers: [{ fromUserAccount: "X", toUserAccount: "Y", tokenAmount: 1, mint: "OTHER" }],
    },
  ];
  assert.equal(parseTrades(payload, MINT).length, 0);
  assert.equal(parseTrades(payload, "").length, 0);
});
