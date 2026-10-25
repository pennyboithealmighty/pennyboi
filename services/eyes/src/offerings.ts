// Offering detection (docs/12 §1). Eyes polls the FeeReceiver for incoming SOL
// gifts, classifies each (fee vs offering vs internal), sanitizes any memo, and
// records offerings in the `donations` table — idempotent by signature, with
// catch-up on restart. `parseOffering` is a pure function over a parsed tx so it
// is unit-testable without a chain.
//
// NOTE (docs/12 §0): this never touches the airdrop pool. Recording a gift does
// not change a wallet's eligibility.

import {
  classifyDonor,
  fetchVaultConfig,
  offeringConfig,
  sanitizeMemo,
  shortDonor,
  tierFor,
  type ClassifyContext,
  type LoadedVault,
  type MemoryDb,
  type OfferingConfig,
} from "@pennyboi/shared";
import type { Connection, PublicKey } from "@solana/web3.js";
import type { Logger } from "./log.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const MEMO_PROGRAMS = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

/** Normalize a pubkey (PublicKey | string | {toBase58}) to a base58 string. */
function keyStr(k: unknown): string {
  if (!k) return "";
  if (typeof k === "string") return k;
  const o = k as { toBase58?: () => string; toString?: () => string };
  if (typeof o.toBase58 === "function") return o.toBase58();
  if (typeof o.toString === "function") return o.toString();
  return String(k);
}

export interface RawOffering {
  txSig: string;
  slot: number;
  ts: number;
  donor: string;
  lamports: number; // net credited to the FeeReceiver this tx
  memoRaw: string | null;
  reference: string | null;
}

/**
 * Extract an offering from a parsed transaction, or null if it isn't a positive
 * SOL credit to the FeeReceiver. Reads the net balance delta (robust to how the
 * SOL arrived), the transfer source as donor, an optional SPL Memo, and an
 * optional Solana Pay reference (an extra read-only, non-signer account key).
 */
export function parseOffering(
  sig: string,
  tx: unknown,
  feeReceiver: string,
  nowSecs: number
): RawOffering | null {
  const t = tx as any;
  if (!t || !t.meta || t.meta.err != null) return null;
  const msg = t.transaction?.message;
  const keys: any[] = msg?.accountKeys ?? [];
  if (!keys.length) return null;
  const keyStrs = keys.map((k) => keyStr(k.pubkey ?? k));

  const idx = keyStrs.indexOf(feeReceiver);
  if (idx < 0) return null;
  const pre = t.meta.preBalances?.[idx] ?? 0;
  const post = t.meta.postBalances?.[idx] ?? 0;
  const lamports = post - pre;
  if (lamports <= 0) return null;

  let donor = "";
  let memoRaw: string | null = null;
  for (const ix of msg.instructions ?? []) {
    const program = ix.program ?? "";
    const programId = keyStr(ix.programId);
    if ((program === "system" || programId === SYSTEM_PROGRAM) && ix.parsed?.type === "transfer") {
      const info = ix.parsed.info ?? {};
      if (keyStr(info.destination) === feeReceiver && info.source) donor = keyStr(info.source);
    }
    if (program === "spl-memo" || MEMO_PROGRAMS.has(programId)) {
      memoRaw = typeof ix.parsed === "string" ? ix.parsed : (ix.parsed?.toString?.() ?? null);
    }
  }
  if (!donor) donor = keyStrs[0] ?? ""; // fee payer fallback

  const known = new Set<string>([feeReceiver, donor, SYSTEM_PROGRAM, ...MEMO_PROGRAMS]);
  let reference: string | null = null;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (!k.signer && !k.writable && !known.has(keyStrs[i]!)) {
      reference = keyStrs[i]!;
      break;
    }
  }

  return {
    txSig: sig,
    slot: t.slot ?? 0,
    ts: (t.blockTime ?? nowSecs) as number,
    donor,
    lamports,
    memoRaw,
    reference,
  };
}

export interface OfferingWatcherDeps {
  connection: Connection;
  feeReceiver: PublicKey;
  db: MemoryDb;
  classifyCtx: ClassifyContext;
  cfg: OfferingConfig;
  log: Logger;
}

export class OfferingWatcher {
  private until: string | undefined;
  private scanning = false;

  constructor(private deps: OfferingWatcherDeps) {
    this.until = deps.db.lastDonationSig() ?? undefined;
  }

  /** One pass: fetch new signatures at the FeeReceiver and record any offerings. */
  async scan(): Promise<number> {
    if (this.scanning) return 0;
    this.scanning = true;
    let recorded = 0;
    try {
      const sigs = await this.deps.connection.getSignaturesForAddress(this.deps.feeReceiver, {
        until: this.until,
        limit: 50,
      });
      if (!sigs.length) return 0;

      // Oldest -> newest, so a mid-batch failure doesn't skip anything.
      for (const s of [...sigs].reverse()) {
        if (s.err) continue;
        if (this.deps.db.hasDonation(s.signature)) continue;
        const tx = await this.deps.connection.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        const raw = parseOffering(
          s.signature,
          tx,
          this.deps.feeReceiver.toBase58(),
          Math.floor(Date.now() / 1000)
        );
        if (!raw) continue;

        const { cls, isCreator } = classifyDonor(raw.donor, this.deps.classifyCtx);
        if (cls !== "offering") continue; // fees + internal transfers aren't offerings

        const tier = tierFor(raw.lamports, this.deps.cfg.minAnnounceLamports, this.deps.cfg.grandLamports);
        const memoClean = sanitizeMemo(raw.memoRaw, this.deps.cfg.memoBlock);
        const isNew = this.deps.db.recordDonation({
          tx_sig: raw.txSig,
          ts: raw.ts,
          slot: raw.slot,
          donor: raw.donor,
          lamports: raw.lamports,
          is_creator: isCreator ? 1 : 0,
          reference: raw.reference,
          memo_raw: raw.memoRaw,
          memo_clean: memoClean,
          tier,
        });
        if (isNew) {
          recorded += 1;
          this.deps.log.info(`offering: ${raw.lamports} lamports from ${shortDonor(raw.donor)} [${tier}]`);
        }
      }
      this.until = sigs[0]!.signature; // advance to the newest seen
    } catch (e) {
      this.deps.log.error("offering scan failed", e);
    } finally {
      this.scanning = false;
    }
    return recorded;
  }

  start(intervalSecs: number): NodeJS.Timeout {
    this.deps.log.info(`offering watcher polling FeeReceiver every ${intervalSecs}s`);
    return setInterval(() => void this.scan(), Math.max(5, intervalSecs) * 1000);
  }
}

/** Build the classifier context from chain + env, then start the watcher. */
export async function startOfferingWatcher(args: {
  connection: Connection;
  vault: LoadedVault;
  db: MemoryDb;
  log: Logger;
  intervalSecs: number;
}): Promise<void> {
  const cfg = offeringConfig();
  let admin = "";
  let agent = "";
  try {
    const vcfg = await fetchVaultConfig(args.vault.program, args.vault.configPda);
    admin = vcfg.admin;
    agent = vcfg.agent;
  } catch (e) {
    args.log.warn("offering watcher: couldn't read config for admin/agent; creator tithes stay unlabeled", e);
  }
  const internal = new Set<string>([
    args.vault.configPda.toBase58(),
    args.vault.treasuryPda.toBase58(),
    args.vault.feesPda.toBase58(),
    args.vault.burnPda.toBase58(),
  ]);
  const classifyCtx: ClassifyContext = { admin, agent, internal, feeSources: cfg.feeSources, creatorTithes: cfg.creatorTithes };
  const watcher = new OfferingWatcher({
    connection: args.connection,
    feeReceiver: args.vault.feesPda,
    db: args.db,
    classifyCtx,
    cfg,
    log: args.log,
  });
  await watcher.scan();
  watcher.start(args.intervalSecs);
}
