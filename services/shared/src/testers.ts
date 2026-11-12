// Devnet tester airdrops (TESTER_AIRDROPS_ENABLED). A short list of real devnet
// wallets, kept in a gitignored file, that are added to the airdrop pool so
// testers can receive Pennyboi's SOL airdrops before a token exists.
//
// This list can never apply on mainnet. loadDevnetTesters refuses unless ALL of
// these hold, and the last one is read from the chain itself:
//   - TESTER_AIRDROPS_ENABLED is true
//   - SOLANA_CLUSTER is exactly "devnet"
//   - the RPC URL does not name mainnet
//   - the RPC's genesis hash is devnet's
// A refusal loads nothing; it never throws into pool building.

import { PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import type { AirdropConfig, Holder } from "./airdrop.js";
import { envBool, envStr, resolveFromRoot } from "./env.js";

/** Genesis hash of Solana devnet. Mainnet-beta's is different, so this cannot match there. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEFAULT_TESTER_FILE = "data/testers.devnet.txt";

export function testerAirdropsEnabled(): boolean {
  return envBool("TESTER_AIRDROPS_ENABLED", false);
}

/** When true, the pool is the testers alone, so every slot goes to a tester. */
export function testerPoolExclusive(): boolean {
  return envBool("TESTER_AIRDROPS_EXCLUSIVE", false);
}

export function testerFilePath(): string {
  return resolveFromRoot(envStr("TESTER_WALLETS_FILE", DEFAULT_TESTER_FILE));
}

function isPubkey(s: string): boolean {
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

/** One address per line; blank lines and "#" comments are ignored. */
export function parseTesterFile(text: string): { wallets: string[]; invalid: string[] } {
  const wallets: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const addr = line.split(/[\s,]+/)[0]!;
    if (!isPubkey(addr)) {
      invalid.push(addr.slice(0, 60));
      continue;
    }
    if (seen.has(addr)) continue;
    seen.add(addr);
    wallets.push(addr);
  }
  return { wallets, invalid };
}

export type TesterLoad =
  | { ok: true; wallets: string[]; invalid: string[]; path: string }
  | { ok: false; reason: string };

export interface TesterLoadOpts {
  /** Reads the genesis hash from the same RPC the airdrop would be sent through. */
  getGenesisHash: () => Promise<string>;
  enabled?: boolean;
  cluster?: string;
  rpcUrl?: string;
  path?: string;
  readFile?: (path: string) => string | null;
}

export async function loadDevnetTesters(opts: TesterLoadOpts): Promise<TesterLoad> {
  const enabled = opts.enabled ?? testerAirdropsEnabled();
  if (!enabled) return { ok: false, reason: "disabled" };

  const cluster = (opts.cluster ?? envStr("SOLANA_CLUSTER")).trim();
  if (cluster !== "devnet") {
    return { ok: false, reason: `SOLANA_CLUSTER is "${cluster || "(unset)"}", not "devnet"` };
  }
  const rpcUrl = opts.rpcUrl ?? envStr("SOLANA_RPC_URL");
  if (/mainnet/i.test(rpcUrl)) return { ok: false, reason: "the RPC URL names mainnet" };

  let genesis: string;
  try {
    genesis = await opts.getGenesisHash();
  } catch (e) {
    return { ok: false, reason: `could not read the genesis hash: ${(e as Error).message}` };
  }
  if (genesis !== DEVNET_GENESIS_HASH) {
    return { ok: false, reason: "the RPC is not Solana devnet (genesis hash mismatch)" };
  }

  const path = opts.path ?? testerFilePath();
  const read =
    opts.readFile ?? ((p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null));
  const text = read(path);
  if (text === null) return { ok: true, wallets: [], invalid: [], path };
  return { ok: true, ...parseTesterFile(text), path };
}

/**
 * Testers as pool-eligible holders. They hold no token, so they are given
 * exactly the minimum balance and hold time, and no sell or win history: a
 * tester is always eligible. The exclusion list still applies to them.
 */
export function testersAsHolders(wallets: string[], now: number, cfg: AirdropConfig): Holder[] {
  return wallets.map((address) => ({
    address,
    balance: cfg.minHoldTokens,
    qualifiedSince: now - cfg.minHoldSecs - 1,
    lastSellTs: null,
    lastAirdropTs: null,
  }));
}

/** Add testers to the holder list (or replace it, when exclusive). A tester row wins on a clash. */
export function withTesters(holders: Holder[], testers: Holder[], exclusive: boolean): Holder[] {
  if (testers.length === 0) return holders;
  if (exclusive) return testers;
  const testerSet = new Set(testers.map((t) => t.address));
  return [...holders.filter((h) => !testerSet.has(h.address)), ...testers];
}
