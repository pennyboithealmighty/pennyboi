// Shared helpers for the devnet scripts: the devnet safety guard, keypair
// generation into a gitignored keys/ folder (secret keys never printed), and
// best-effort funding.

import { envStr, resolveFromRoot, solToLamports } from "@pennyboi/shared";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  type PublicKey,
} from "@solana/web3.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * HARD SAFETY: refuse to touch the chain unless the RPC URL clearly points at
 * devnet. Devnet only until the operator explicitly goes mainnet.
 */
export function assertDevnet(): string {
  const rpc = envStr("SOLANA_RPC_URL", "");
  const cluster = envStr("SOLANA_CLUSTER", "");
  if (!/devnet/i.test(rpc)) {
    throw new Error(
      `REFUSING to act on-chain: SOLANA_RPC_URL ("${rpc || "unset"}") does not contain "devnet". ` +
        `This project is devnet-only. Set a devnet RPC before running.`
    );
  }
  if (/mainnet/i.test(rpc) || cluster.toLowerCase() === "mainnet-beta") {
    throw new Error(`REFUSING: a mainnet endpoint was detected (rpc="${rpc}", cluster="${cluster}").`);
  }
  return rpc;
}

export function keysDir(): string {
  const dir = resolveFromRoot("keys");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface LoadedKey {
  keypair: Keypair;
  path: string;
  created: boolean;
}

/**
 * Load keys/<name>.json or generate it. The secret key is written to disk (0600,
 * gitignored) and NEVER printed or returned as text — callers only ever see the
 * public key.
 */
export function loadOrCreateKeypair(name: string): LoadedKey {
  const path = join(keysDir(), `${name}.json`);
  if (existsSync(path)) {
    const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
    return { keypair: Keypair.fromSecretKey(Uint8Array.from(secret)), path, created: false };
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on non-POSIX */
  }
  return { keypair: kp, path, created: true };
}

/** Top up to `topUpSol` via the devnet faucet if balance is below `minSol`. */
export async function ensureFunded(
  conn: Connection,
  pubkey: PublicKey,
  minSol: number,
  topUpSol: number
): Promise<number> {
  let bal = await conn.getBalance(pubkey);
  if (bal >= solToLamports(minSol)) return bal;
  try {
    const sig = await conn.requestAirdrop(pubkey, solToLamports(topUpSol));
    await conn.confirmTransaction(sig, "confirmed");
  } catch {
    // Devnet faucet is rate-limited; caller warns and continues.
  }
  bal = await conn.getBalance(pubkey);
  return bal;
}

export function sol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(4);
}

export function log(msg: string): void {
  console.log(`[scripts] ${new Date().toISOString()} ${msg}`);
}
