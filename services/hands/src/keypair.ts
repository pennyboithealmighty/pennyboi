// Load the restricted agent signing key from a JSON keypair file (devnet only).
// The path comes from AGENT_KEYPAIR_PATH and must live OUTSIDE the repo.

import { Keypair } from "@solana/web3.js";
import { readJson, requireEnv } from "@pennyboi/shared";

export function loadAgentKeypair(): Keypair {
  const path = requireEnv("AGENT_KEYPAIR_PATH");
  const secret = readJson<number[]>(path);
  if (!Array.isArray(secret)) {
    throw new Error(`AGENT_KEYPAIR_PATH (${path}) is not a JSON array keypair`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
