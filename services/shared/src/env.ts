// Environment loading. Finds the repo-root `.env` (next to pnpm-workspace.yaml)
// no matter which service's directory the process was started from, loads it,
// and exposes small typed getters.

import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

let loaded = false;

/** Walk up from `start` until the directory holding pnpm-workspace.yaml. */
function findRepoRoot(start: string): string {
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start; // hit filesystem root; give up gracefully
    dir = parent;
  }
}

/** Load the repo-root .env exactly once. Safe to call repeatedly. */
export function loadEnv(): void {
  if (loaded) return;
  const root = findRepoRoot(process.cwd());
  const envPath = join(root, ".env");
  if (existsSync(envPath)) loadDotenv({ path: envPath });
  loaded = true;
}

export function repoRoot(): string {
  return findRepoRoot(process.cwd());
}

/**
 * Resolve a possibly-relative path against the repo root, so services started
 * from their own package directory (e.g. `pnpm --filter … start`) all agree on
 * the same file — notably the shared SQLite DATABASE_PATH.
 */
export function resolveFromRoot(p: string): string {
  return isAbsolute(p) ? p : join(repoRoot(), p);
}

/** Required string env var; throws if missing/empty. */
export function requireEnv(name: string): string {
  loadEnv();
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

/** Optional string env var with a fallback. */
export function envStr(name: string, fallback = ""): string {
  loadEnv();
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

export function envNum(name: string, fallback: number): number {
  loadEnv();
  const v = process.env[name];
  if (!v || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(name: string, fallback = false): boolean {
  loadEnv();
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Read a JSON file (used for IDL / keypair loading). */
export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
