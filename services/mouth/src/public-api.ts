// Read-only public JSON API for the website (docs: site v2 Stage 3).
// Additive: mounted on Mouth's existing HTTP server under /public/*. It only
// reads the shared DB + chain, behind a 30s cache and a 60/min-per-IP limit, so
// it cannot slow the bot. It NEVER exposes owner data, keys, member/telegram
// ids, mod logs, or anything from .env.

import { envStr, type MemoryDb } from "@pennyboi/shared";
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
  solscanUrl?: string;
}

/** Merge on-chain actions + posted X prophecies into a public decree feed. */
export function buildDecrees(
  actions: Array<{ ts: number; narration: string | null; tx_sig: string | null }>,
  xposts: Array<{ ts: number; text: string; status: string }>,
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
    out.push({ ts: x.ts, kind: "prophecy", text: x.text });
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
}
