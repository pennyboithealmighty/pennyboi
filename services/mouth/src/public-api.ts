// Read-only public JSON API for the website (docs: site v2 Stage 3).
// Additive: mounted on Mouth's existing HTTP server under /public/*. It only
// reads the shared DB + chain, behind a 30s cache and a 60/min-per-IP limit, so
// it cannot slow the bot. It NEVER exposes owner data, keys, member/telegram
// ids, mod logs, or anything from .env.

import { donorDisplay, lamportsToSol, type DonationRow, type MemoryDb, envStr } from "@pennyboi/shared";
import type { Express, NextFunction, Request, Response } from "express";
import type { ChainReader } from "./chain.js";
import type { MouthConfig } from "./config.js";
import { solscanTx } from "./links.js";
import type { Logger } from "./log.js";

// ---- CORS allowlist -------------------------------------------------------

export function corsOrigin(origin: string | undefined, extra: string[] = []): string | null {
  if (!origin) return null;
  const allow = ["https://pennyboi.com", "https://www.pennyboi.com", ...extra];
  if (allow.includes(origin)) return origin;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return origin;
  return null;
}

// ---- Rate limiter (fixed window per IP) -----------------------------------

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private max: number, private windowMs: number) {}

  allow(ip: string, now = Date.now()): boolean {
    const e = this.hits.get(ip);
    if (!e || now >= e.resetAt) {
      this.hits.set(ip, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    e.count += 1;
    return e.count <= this.max;
  }
}

// ---- 30s TTL cache --------------------------------------------------------

export class TtlCache<T> {
  private store = new Map<string, { at: number; val: T }>();
  constructor(private ttlMs: number) {}

  async wrap(key: string, produce: () => Promise<T>, now = Date.now()): Promise<T> {
    const e = this.store.get(key);
    if (e && now - e.at < this.ttlMs) return e.val;
    const val = await produce();
    this.store.set(key, { at: now, val });
    return val;
  }
}

// ---- Sanitizers (pure) ----------------------------------------------------

export function truncAddr(addr: string): string {
  return addr.length > 12 ? addr.slice(0, 6) + "…" + addr.slice(-4) : addr;
}

export interface Decree {
  ts: number;
  kind: "decree" | "prophecy";
  text: string;
  solscanUrl?: string; // decree entries: the Solscan tx (only when a tx landed)
  xPostId?: string; // prophecy entries: the public X status id (site builds the URL)
}

/**
 * Merge on-chain actions + posted X prophecies into a public decree feed.
 * A decree carries its Solscan tx only when a transaction actually landed, so
 * no-op ("none") narrations stay unlinked; a prophecy carries its public X
 * status id. Both are public, non-identifying — nothing else leaks.
 */
export function buildDecrees(
  actions: Array<{ ts: number; narration: string | null; tx_sig: string | null }>,
  xposts: Array<{ ts: number; text: string; status: string; x_post_id?: string | null }>,
  limit: number,
  txUrl: (sig: string) => string
): Decree[] {
  const out: Decree[] = [];
  for (const a of actions) {
    const text = (a.narration ?? "").trim();
    if (!text) continue;
    out.push({ ts: a.ts, kind: "decree", text, solscanUrl: a.tx_sig ? txUrl(a.tx_sig) : undefined });
  }
  for (const x of xposts) {
    if (x.status !== "posted" || !x.text.trim()) continue;
    const entry: Decree = { ts: x.ts, kind: "prophecy", text: x.text };
    if (x.x_post_id) entry.xPostId = x.x_post_id;
    out.push(entry);
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export function sanitizeOfferings(
  rows: Array<{ text: string; upvotes: number }>
): Array<{ by: string; text: string; upvotes: number }> {
  // No usernames/ids ever leave the building.
  return rows.map((r) => ({ by: "a mortal", text: r.text, upvotes: r.upvotes }));
}

export function sanitizeMentions(
  rows: Array<{ wallet: string; nickname: string | null; reason: string }>
): Array<{ wallet: string; nickname: string | null; reason: string }> {
  return rows.map((r) => ({ wallet: truncAddr(r.wallet), nickname: r.nickname, reason: r.reason }));
}

// ---- Offerings (docs/12 §4) -----------------------------------------------

export interface PublicOffering {
  ts: number;
  donor_display: string;
  donor_short: string;
  sol: number;
  tier: string;
  is_creator: boolean;
  memo_clean: string | null;
  tx_sig: string;
  solscan_url: string;
}

/** Shape one donation for the public feed. Never leaks the full donor address beyond the 4+4 short form. */
export function publicOffering(row: DonationRow, opts: { nickname: string | null; solscanUrl: string }): PublicOffering {
  const { display, short } = donorDisplay(row.donor, opts.nickname);
  return {
    ts: row.ts,
    donor_display: display,
    donor_short: short,
    sol: lamportsToSol(row.lamports),
    tier: row.tier,
    is_creator: row.is_creator === 1,
    memo_clean: row.memo_clean,
    tx_sig: row.tx_sig,
    solscan_url: opts.solscanUrl,
  };
}

// ---- Registration ---------------------------------------------------------

export interface PublicApiDeps {
  db: MemoryDb;
  chain: ChainReader;
  cfg: MouthConfig;
  log: Logger;
}

const clamp = (v: unknown, def: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};

export function registerPublicApi(app: Express, deps: PublicApiDeps): void {
  const { db, chain, cfg } = deps;
  const extraOrigins = envStr("API_CORS_ORIGINS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const limiter = new RateLimiter(60, 60_000);
  const cache = new TtlCache<unknown>(30_000);

  // CORS + rate-limit for every /public route.
  app.use("/public", (req: Request, res: Response, next: NextFunction) => {
    const allowed = corsOrigin(req.header("origin"), extraOrigins);
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", allowed);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "accept, content-type");
    }
    if (req.method === "OPTIONS") return res.status(204).end();

    const ip = (req.ip || req.socket.remoteAddress || "unknown").toString();
    if (!limiter.allow(ip)) return res.status(429).json({ ok: false, error: "rate limited" });
    next();
  });

  const cached = (key: string, produce: () => Promise<unknown>) =>
    async (_req: Request, res: Response) => {
      try {
        const data = await cache.wrap(key, produce);
        res.json({ ok: true, data });
      } catch (e) {
        res.status(502).json({ ok: false, error: "the oracle is silent" });
      }
    };

  const txUrl = (sig: string) => solscanTx(cfg, sig);

  app.get("/public/treasury", cached("treasury", async () => {
    const s = await chain.treasuryStatus().catch(() => null);
    return {
      network: cfg.cluster,
      programId: envStr("VAULT_PROGRAM_ID"),
      ...(s ?? { balanceSol: null, step: null, untilNextSol: null, available: [], actionsBanked: null }),
    };
  }));

  const serveCached = (
    res: Response,
    key: string,
    produce: () => Promise<unknown>
  ) =>
    cache
      .wrap(key, produce)
      .then((data) => res.json({ ok: true, data }))
      .catch(() => res.status(502).json({ ok: false, error: "the oracle is silent" }));

  app.get("/public/decrees", (req, res) => {
    const n = clamp(req.query.limit, 10, 50);
    serveCached(res, "decrees:" + n, async () =>
      buildDecrees(db.lastActions(50), db.recentXPosts(50), n, txUrl)
    );
  });

  app.get("/public/offerings", (req, res) => {
    const n = clamp(req.query.limit, 10, 50);
    serveCached(res, "offerings:" + n, async () => sanitizeOfferings(db.topOpenOfferings(n)));
  });

  app.get("/public/grudges", cached("grudges", async () => sanitizeMentions(db.listGrudges(10))));
  app.get("/public/loyal", cached("loyal", async () => sanitizeMentions(db.listLoyal(10))));

  app.get("/public/status", cached("status", async () => {
    const s = await chain.treasuryStatus().catch(() => null);
    return {
      network: cfg.cluster,
      programId: envStr("VAULT_PROGRAM_ID"),
      balanceSol: s?.balanceSol ?? null,
      thresholdStep: s?.step ?? null,
      actionsBanked: s?.actionsBanked ?? null,
      decrees: db.countActions() + db.countPostedXPosts(),
      grudges: db.countActiveGrudges(),
      loyal: db.countLoyal(),
    };
  }));

  // ---- Offerings (docs/12 §4). Singular /public/offering/* so it never
  // collides with the Telegram /public/offerings (stunt pitches) feed. --------

  app.get("/public/offering/list", (req, res) => {
    const n = clamp(req.query.limit, 10, 25);
    serveCached(res, "offering:list:" + n, async () =>
      db.recentOfferings(n).map((row) =>
        publicOffering(row, { nickname: db.nicknameOf(row.donor), solscanUrl: txUrl(row.tx_sig) })
      )
    );
  });

  app.get("/public/offering/stats", cached("offering:stats", async () => {
    const s = db.offeringStats(Math.floor(Date.now() / 1000));
    return {
      total_sol: Number(( s.totalLamports / 1e9 ).toFixed(6)),
      count: s.count,
      donors: s.donors,
      last_24h_sol: Number(( s.last24hLamports / 1e9 ).toFixed(6)),
      largest: s.largest
        ? publicOffering(s.largest, { nickname: db.nicknameOf(s.largest.donor), solscanUrl: txUrl(s.largest.tx_sig) })
        : null,
    };
  }));

  app.get("/public/offering/receipt", async (req: Request, res: Response) => {
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    const ref = typeof req.query.ref === "string" ? req.query.ref : "";
    if (!sig && !ref) return res.status(400).json({ ok: false, error: "sig or ref required" });
    try {
      const row = sig ? db.getDonation(sig) : db.getDonationByRef(ref);
      if (row) {
        return res.json({
          ok: true,
          data: {
            status: "recorded",
            sol: row.lamports / 1e9,
            donor_short: publicOffering(row, { nickname: null, solscanUrl: "" }).donor_short,
            ts: row.ts,
            tx_sig: row.tx_sig,
            solscan_url: txUrl(row.tx_sig),
            narration: row.narration ?? undefined,
          },
        });
      }
      // Not recorded by Eyes yet. If we have a sig, say whether it's on-chain.
      const confirmed = sig ? await chain.signatureConfirmed(sig).catch(() => false) : false;
      return res.json({ ok: true, data: { status: confirmed ? "confirmed" : "pending", tx_sig: sig || undefined } });
    } catch {
      return res.status(502).json({ ok: false, error: "the oracle is silent" });
    }
  });

  // Blockhash comes from the server's RPC — the Helius key never reaches the
  // browser. Stricter 30/min-per-IP limit on top of the global /public limit.
  const prepareLimiter = new RateLimiter(30, 60_000);
  app.get("/public/offering/prepare", async (req: Request, res: Response) => {
    const ip = (req.ip || req.socket.remoteAddress || "unknown").toString();
    if (!prepareLimiter.allow(ip)) return res.status(429).json({ ok: false, error: "rate limited" });
    try {
      const p = await chain.prepareOffering();
      if (!p) return res.status(503).json({ ok: false, error: "vault not deployed" });
      return res.json({ ok: true, data: { ...p, network: cfg.cluster } });
    } catch {
      return res.status(502).json({ ok: false, error: "the oracle is silent" });
    }
  });
}
