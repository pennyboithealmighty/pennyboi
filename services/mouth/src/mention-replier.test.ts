import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { MemoryDb } from "@pennyboi/shared";
import type { MentionConfig } from "./config.js";
import type { Logger } from "./log.js";
import { MentionReplier, type Generated } from "./mention-replier.js";
import { MentionsApiError, type MentionsClient, type MentionsPage, type RawMention } from "./x-mentions.js";

const BOT = "100";

function tempDb(): { db: MemoryDb; cleanup: () => void } {
  const path = join(tmpdir(), `pb-mentions-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new MemoryDb(path);
  return {
    db,
    cleanup: () => {
      for (const ext of ["", "-wal", "-shm"]) rmSync(path + ext, { force: true });
    },
  };
}

function cfg(over: Partial<MentionConfig> = {}): MentionConfig {
  return {
    enabled: true,
    dryRun: true,
    maxPerDay: 20,
    maxPerUserPerDay: 2,
    spendCapUsd: 1.0,
    minGapSecs: 180,
    pollSecs: 300,
    staleSecs: 21_600,
    pageMax: 20,
    botUsername: "Pennyboi_Sol",
    botUserId: BOT,
    costReadUsd: 0.005,
    costReplyUsd: 0.015,
    costUserLookupUsd: 0.01,
    secretWords: ["ZZQ"],
    ...over,
  };
}

function mention(id: string, over: Partial<RawMention> = {}): RawMention {
  return {
    id,
    text: "@Pennyboi_Sol who are you",
    authorId: "42",
    referenced: [],
    urls: [],
    mentionCount: 1,
    cashtagCount: 0,
    ...over,
  };
}

/** A fake X: each fetch returns the next scripted page and records what was asked. */
function fakeClient(pages: Array<MentionsPage | Error>) {
  const fetches: Array<{ sinceId?: string; startTime?: string; maxResults: number }> = [];
  const replies: Array<{ text: string; to: string }> = [];
  let lookups = 0;
  const client: MentionsClient = {
    ready: true,
    async getBotUserId() {
      lookups++;
      return BOT;
    },
    async fetchMentions(_userId, opts) {
      fetches.push(opts);
      const p = pages.shift() ?? { mentions: [], newestId: null };
      if (p instanceof Error) throw p;
      return p;
    },
    async reply(text, to) {
      replies.push({ text, to });
      return `r${replies.length}`;
    },
  };
  return { client, fetches, replies, lookups: () => lookups };
}

function harness(opts: {
  pages: Array<MentionsPage | Error>;
  cfg?: Partial<MentionConfig>;
  generate?: (text: string) => Promise<Generated>;
  db?: MemoryDb;
}) {
  const t = opts.db ? { db: opts.db, cleanup: () => {} } : tempDb();
  const lines: string[] = [];
  const rec = (m: string) => void lines.push(m);
  const log = { debug: rec, info: rec, warn: rec, error: rec } as unknown as Logger;
  const x = fakeClient(opts.pages);
  const clock = { ms: new Date(2026, 10, 12, 10, 0, 0).getTime() };
  const asked: string[] = [];
  const replier = new MentionReplier({
    db: t.db,
    log,
    cfg: cfg(opts.cfg),
    client: x.client,
    generate:
      opts.generate ??
      (async (text) => {
        asked.push(text);
        return { kind: "reply", text: "You speak to a god. Choose your words with care." };
      }),
    now: () => clock.ms,
    rng: () => 0,
  });
  return { ...t, ...x, replier, lines, clock, asked };
}

const page = (...ms: RawMention[]): MentionsPage => ({ mentions: ms, newestId: ms[0]?.id ?? null });

test("first run primes since_id and answers nothing, however many mentions exist", async () => {
  const h = harness({ pages: [page(mention("900"), mention("899"), mention("898"))] });
  try {
    const out = await h.replier.pollOnce();
    assert.equal(out.status, "primed");
    assert.equal(h.db.kvGet("x_mentions_since_id"), "900");
    assert.ok(h.db.kvGet("x_mentions_primed_at"));
    assert.equal(h.fetches[0]!.maxResults, 5);
    assert.equal(h.fetches[0]!.sinceId, undefined);
    assert.equal(h.db.recentXMentions(10).length, 0, "old mentions are not even queued");
    assert.deepEqual(await h.replier.drainOnce(), { decided: 0, replied: 0 });
    assert.equal(h.asked.length, 0);
    assert.ok(h.lines.some((l) => /primed since_id=900 — 3 existing mention\(s\) ignored, nothing answered/.test(l)));
  } finally {
    h.cleanup();
  }
});

test("priming with an empty timeline watches from now via start_time", async () => {
  const h = harness({ pages: [page(), page(mention("901"))] });
  try {
    assert.equal((await h.replier.pollOnce()).status, "primed");
    assert.equal(h.db.kvGet("x_mentions_since_id"), null);
    const out = await h.replier.pollOnce();
    assert.equal(out.status, "ok");
    assert.equal(out.queued, 1);
    assert.equal(h.fetches[1]!.sinceId, undefined);
    assert.match(h.fetches[1]!.startTime ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(h.db.kvGet("x_mentions_since_id"), "901");
  } finally {
    h.cleanup();
  }
});

test("dry-run: logs the reply it would send, stores it, and never posts", async () => {
  const h = harness({
    pages: [
      page(mention("900")),
      page(mention("902", { text: "@Pennyboi_Sol dm me for promo", authorId: "7" }), mention("901")),
    ],
  });
  try {
    await h.replier.pollOnce(); // prime
    const out = await h.replier.pollOnce();
    assert.deepEqual({ s: out.status, q: out.queued, k: out.skipped }, { s: "ok", q: 1, k: 1 });
    assert.equal(h.fetches[1]!.sinceId, "900");
    assert.equal(h.db.kvGet("x_mentions_since_id"), "902");

    const d = await h.replier.drainOnce();
    assert.equal(d.replied, 1);
    assert.equal(h.replies.length, 0, "dry-run must not post");
    assert.deepEqual(h.asked, ["who are you"], "Brain sees only the sanitized words");

    const rows = h.db.recentXMentions(10);
    const answered = rows.find((r) => r.mention_id === "901")!;
    assert.equal(answered.status, "dry_run");
    assert.equal(answered.reply_text, "You speak to a god. Choose your words with care.");
    const spam = rows.find((r) => r.mention_id === "902")!;
    assert.deepEqual({ s: spam.status, r: spam.reason }, { s: "skipped", r: "scam_pattern" });
    assert.ok(h.lines.some((l) => /DRY-RUN would reply to 901/.test(l)));
    assert.ok(h.lines.some((l) => /902 skipped \[scam_pattern\]/.test(l)));
  } finally {
    h.cleanup();
  }
});

test("live: posts the reply as a reply to the mention and records the id", async () => {
  const h = harness({ pages: [page(mention("900")), page(mention("901"))], cfg: { dryRun: false } });
  try {
    await h.replier.pollOnce();
    await h.replier.pollOnce();
    assert.equal((await h.replier.drainOnce()).replied, 1);
    assert.deepEqual(h.replies, [{ text: "You speak to a god. Choose your words with care.", to: "901" }]);
    const row = h.db.recentXMentions(1)[0]!;
    assert.deepEqual({ s: row.status, id: row.reply_id }, { s: "replied", id: "r1" });
  } finally {
    h.cleanup();
  }
});

test("minimum gap: the second reply waits, then goes out without a new read", async () => {
  const h = harness({
    pages: [page(mention("900")), page(mention("902", { authorId: "8" }), mention("901"))],
    cfg: { dryRun: false },
  });
  try {
    await h.replier.pollOnce();
    await h.replier.pollOnce();
    assert.equal((await h.replier.drainOnce()).replied, 1);
    assert.deepEqual(await h.replier.drainOnce(), { decided: 0, replied: 0, waiting: "min_gap" });
    h.clock.ms += 179_000;
    assert.equal((await h.replier.drainOnce()).waiting, "min_gap");
    h.clock.ms += 2_000;
    assert.equal((await h.replier.drainOnce()).replied, 1);
    assert.equal(h.replies.length, 2);
    assert.equal(h.fetches.length, 2, "draining costs no reads");
  } finally {
    h.cleanup();
  }
});

test("per-user and per-day limits skip with a reason", async () => {
  const h = harness({
    pages: [
      page(mention("900")),
      page(mention("904", { authorId: "9" }), mention("903"), mention("902"), mention("901")),
    ],
    cfg: { minGapSecs: 0, maxPerUserPerDay: 2, maxPerDay: 2 },
  });
  try {
    await h.replier.pollOnce();
    await h.replier.pollOnce();
    for (let i = 0; i < 4; i++) await h.replier.drainOnce();
    const by = Object.fromEntries(h.db.recentXMentions(10).map((r) => [r.mention_id, r.reason ?? r.status]));
    assert.deepEqual(by, { "901": "dry_run", "902": "dry_run", "903": "daily_limit", "904": "daily_limit" });
  } finally {
    h.cleanup();
  }

  const u = harness({
    pages: [page(mention("900")), page(mention("903"), mention("902"), mention("901"))],
    cfg: { minGapSecs: 0, maxPerUserPerDay: 2 },
  });
  try {
    await u.replier.pollOnce();
    await u.replier.pollOnce();
    for (let i = 0; i < 3; i++) await u.replier.drainOnce();
    const third = u.db.recentXMentions(10).find((r) => r.mention_id === "903")!;
    assert.deepEqual({ s: third.status, r: third.reason }, { s: "skipped", r: "user_limit" });
  } finally {
    u.cleanup();
  }
});

test("spend cap: reads and (simulated) replies both count; polling stops at the cap", async () => {
  // Cap $0.05: prime reads 1 ($0.005), poll reads 2 ($0.01), one dry-run reply ($0.015) -> $0.03 used.
  const h = harness({
    pages: [page(mention("900")), page(mention("902", { authorId: "8" }), mention("901"))],
    cfg: { spendCapUsd: 0.05, minGapSecs: 0 },
  });
  try {
    await h.replier.pollOnce();
    await h.replier.pollOnce();
    assert.equal((await h.replier.drainOnce()).replied, 1); // $0.030 used, $0.020 left
    assert.equal((await h.replier.drainOnce()).replied, 1); // $0.045 used, $0.005 left
    const out = await h.replier.pollOnce(); // cannot afford X's minimum page of 5
    assert.deepEqual({ s: out.status, r: out.reason }, { s: "skipped", r: "spend_cap" });
    assert.equal(h.fetches.length, 2, "no read once the cap is reached");
    assert.ok(h.lines.some((l) => /daily X spend cap reached/.test(l)));
    // The next day the budget is back.
    h.clock.ms += 86_400_000;
    assert.equal((await h.replier.pollOnce()).status, "ok");
  } finally {
    h.cleanup();
  }
});

test("a reply the guard rejects is skipped, not posted; a Brain outage keeps it queued", async () => {
  const bad = harness({
    pages: [page(mention("900")), page(mention("901"))],
    cfg: { dryRun: false },
    generate: async () => ({ kind: "reply", text: "Buy now and visit pennyboi.com" }),
  });
  try {
    await bad.replier.pollOnce();
    await bad.replier.pollOnce();
    assert.equal((await bad.replier.drainOnce()).replied, 0);
    assert.equal(bad.replies.length, 0);
    const row = bad.db.recentXMentions(1)[0]!;
    assert.equal(row.status, "skipped");
    assert.match(row.reason ?? "", /^guard: /);
  } finally {
    bad.cleanup();
  }

  let up = false;
  const down = harness({
    pages: [page(mention("900")), page(mention("901"))],
    generate: async () =>
      up ? { kind: "reply", text: "Speak, mortal." } : { kind: "unavailable", reason: "Brain /reply returned HTTP 404" },
  });
  try {
    await down.replier.pollOnce();
    await down.replier.pollOnce();
    assert.equal((await down.replier.drainOnce()).waiting, "brain_unavailable");
    assert.equal(down.db.recentXMentions(1)[0]!.status, "pending", "nothing is lost while Brain is down");
    up = true;
    assert.equal((await down.replier.drainOnce()).replied, 1);
  } finally {
    down.cleanup();
  }
});

test("restart: a fresh replier on the same DB neither re-primes nor re-replies", async () => {
  const first = harness({ pages: [page(mention("900")), page(mention("901"))], cfg: { dryRun: false } });
  try {
    await first.replier.pollOnce();
    await first.replier.pollOnce();
    await first.replier.drainOnce();
    assert.equal(first.replies.length, 1);

    // X hands back the same mention again (as if since_id had been ignored).
    const second = harness({ pages: [page(mention("901"))], cfg: { dryRun: false, minGapSecs: 0 }, db: first.db });
    const out = await second.replier.pollOnce();
    assert.equal(out.status, "ok", "already primed: it polls, it does not prime again");
    assert.equal(second.fetches[0]!.sinceId, "901");
    assert.equal(out.queued, 0);
    await second.replier.drainOnce();
    assert.equal(second.replies.length, 0, "a mention is never answered twice");
    assert.ok(second.lines.some((l) => /901 already seen/.test(l)));
  } finally {
    first.cleanup();
  }
});

test("rate limit pauses polling; stale queued mentions expire unanswered", async () => {
  const resetAt = Math.floor(new Date(2026, 10, 12, 10, 10, 0).getTime() / 1000);
  const h = harness({
    pages: [page(mention("900")), new MentionsApiError("Too Many Requests", 429, true, resetAt), page(mention("901"))],
    generate: async () => ({ kind: "unavailable", reason: "Brain unreachable" }),
  });
  try {
    await h.replier.pollOnce();
    assert.deepEqual((await h.replier.pollOnce()).reason, "rate_limited");
    assert.equal((await h.replier.pollOnce()).status, "skipped", "no call while rate limited");
    assert.equal(h.fetches.length, 2);
    h.clock.ms += 11 * 60_000;
    assert.equal((await h.replier.pollOnce()).queued, 1);
    await h.replier.drainOnce(); // Brain down: stays pending
    h.clock.ms += 7 * 3_600_000; // older than the 6h stale window
    await h.replier.drainOnce();
    const row = h.db.recentXMentions(1)[0]!;
    assert.deepEqual({ s: row.status, r: row.reason }, { s: "skipped", r: "stale" });
  } finally {
    h.cleanup();
  }
});

test("disabled: start() does nothing at all", () => {
  const h = harness({ pages: [], cfg: { enabled: false } });
  try {
    h.replier.start();
    assert.equal(h.fetches.length, 0);
    assert.ok(h.lines.some((l) => /mentions: OFF/.test(l)));
  } finally {
    h.cleanup();
  }
});
