// Build a public Solscan link for a tx (devnet-aware).
import { envStr } from "@pennyboi/shared";

export function solscanTx(sig: string): string {
  const base = envStr("SOLSCAN_BASE", "https://solscan.io").replace(/\/+$/, "");
  const cluster = envStr("SOLANA_CLUSTER", "devnet");
  const q = cluster && cluster !== "mainnet-beta" ? `?cluster=${cluster}` : "";
  return `${base}/tx/${sig}${q}`;
}
