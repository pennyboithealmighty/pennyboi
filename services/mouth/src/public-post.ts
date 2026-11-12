// Public-post discipline (one voice, once a day unless he does a decree):
//   - PostGuard: a hard per-channel daily cap on SCHEDULED public posts
//     (PUBLIC_POSTS_MAX_PER_DAY, default 1). Decrees — on-chain acts that
//     actually executed — are exempt and post immediately. Offering thanks keep
//     their own caps (batch / cooldown / grand-only X cap).
//   - shapeForPublic: clamp to the channel limit + throttle catchphrases, with
//     the catchphrase usage persisted so the signature lines stay rare.
// Both are kv-backed so a restart can't reset the day's count.

import {
  CATCHPHRASES,
  envNum,
  shapeDry,
  throttleCatchphrases,
  type MemoryDb,
} from "@pennyboi/shared";

export type Channel = "telegram" | "x";
export type PostKind = "scheduled" | "decree";

function dayKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Pure: may a public post of this kind go out given today's count? */
export function shouldAllowPublicPost(kind: PostKind, countToday: number, max: number): boolean {
  if (kind === "decree") return true; // decrees are exempt
  return countToday < max;
}

export class PostGuard {
  private max: number;

  constructor(private db: MemoryDb, max?: number) {
    this.max = max ?? envNum("PUBLIC_POSTS_MAX_PER_DAY", 1);
  }

  private key(ch: Channel, now = Date.now()): string {
    return `public_posts:${ch}:${dayKey(now)}`;
  }

  countToday(ch: Channel, now = Date.now()): number {
    return Number(this.db.kvGet(this.key(ch, now)) ?? "0") || 0;
  }

  /** Check the cap; if allowed and scheduled, count it. Decrees always pass. */
  tryTake(ch: Channel, kind: PostKind, now = Date.now()): boolean {
    const n = this.countToday(ch, now);
    if (!shouldAllowPublicPost(kind, n, this.max)) return false;
    if (kind === "scheduled") this.db.kvSet(this.key(ch, now), String(n + 1));
    return true;
  }
}

const COUNTER_KEY = "public_post_counter";
const LAST_KEY = (k: string) => `catchphrase_last:${k}`;

/**
 * Final shaping before any public post: throttle the catchphrases (at most
 * once every CATCHPHRASE_WINDOW posts), cap at MAX_SENTENCES, clamp to `max`,
 * then advance the public-post counter and persist which phrases were spent.
 */
export function shapeForPublic(db: MemoryDb, text: string, max: number): string {
  const counter = Number(db.kvGet(COUNTER_KEY) ?? "0") || 0;
  const lastUsed: Record<string, number | undefined> = {};
  for (const c of CATCHPHRASES) {
    const v = db.kvGet(LAST_KEY(c.key));
    lastUsed[c.key] = v == null ? undefined : Number(v);
  }
  const t = throttleCatchphrases(text, lastUsed, counter);
  for (const k of t.used) db.kvSet(LAST_KEY(k), String(counter));
  db.kvSet(COUNTER_KEY, String(counter + 1));
  return shapeDry(t.text, max);
}
