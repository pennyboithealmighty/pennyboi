// Solscan link builder (devnet-aware), shared by commands + digests.
import type { MouthConfig } from "./config.js";

export function solscanTx(cfg: MouthConfig, sig: string): string {
  const base = cfg.solscanBase.replace(/\/+$/, "");
  const q = cfg.cluster && cfg.cluster !== "mainnet-beta" ? `?cluster=${cfg.cluster}` : "";
  return `${base}/tx/${sig}${q}`;
}
