// Parse Helius "enhanced transaction" webhook payloads into simple buy/sell
// trade events for the configured token mint.
//
// Heuristic (v0.1): for each token transfer of our mint, the RECEIVER is
// treated as a buyer and their net native (SOL) outflow in the same tx as
// `sol_in`; the SENDER is treated as a seller and their net native inflow as
// `sol_out`. This matches a Pump.fun-style swap where the counterparty is the
// bonding curve / pool, not a wallet. Refine once real Pump.fun fee/trade data
// is available (docs/03 open items).

import { lamportsToSol } from "@pennyboi/shared";

export interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount?: number;
  mint?: string;
}
export interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number; // lamports
}
export interface HeliusEnhancedTx {
  signature?: string;
  timestamp?: number;
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
}

export interface TradeEvent {
  wallet: string;
  kind: "buy" | "sell";
  sol: number; // sol_in for buys, sol_out for sells
  token: number; // token amount moved
  signature?: string;
}

/** Normalize a webhook body into an array of enhanced txs. */
export function asTxArray(body: unknown): HeliusEnhancedTx[] {
  if (Array.isArray(body)) return body as HeliusEnhancedTx[];
  if (body && typeof body === "object") {
    const maybe = (body as { transactions?: unknown }).transactions;
    if (Array.isArray(maybe)) return maybe as HeliusEnhancedTx[];
  }
  return [];
}

function nativeOut(tx: HeliusEnhancedTx, wallet: string): number {
  let lamports = 0;
  for (const n of tx.nativeTransfers ?? []) {
    if (n.fromUserAccount === wallet) lamports += n.amount ?? 0;
  }
  return lamportsToSol(lamports);
}
function nativeIn(tx: HeliusEnhancedTx, wallet: string): number {
  let lamports = 0;
  for (const n of tx.nativeTransfers ?? []) {
    if (n.toUserAccount === wallet) lamports += n.amount ?? 0;
  }
  return lamportsToSol(lamports);
}

/** Extract trade events for `mint` from one or many enhanced txs. */
export function parseTrades(body: unknown, mint: string): TradeEvent[] {
  if (!mint) return [];
  const out: TradeEvent[] = [];
  for (const tx of asTxArray(body)) {
    for (const t of tx.tokenTransfers ?? []) {
      if (t.mint !== mint) continue;
      const amount = t.tokenAmount ?? 0;
      if (t.toUserAccount) {
        out.push({
          wallet: t.toUserAccount,
          kind: "buy",
          sol: nativeOut(tx, t.toUserAccount),
          token: amount,
          signature: tx.signature,
        });
      }
      if (t.fromUserAccount) {
        out.push({
          wallet: t.fromUserAccount,
          kind: "sell",
          sol: nativeIn(tx, t.fromUserAccount),
          token: amount,
          signature: tx.signature,
        });
      }
    }
  }
  return out;
}
