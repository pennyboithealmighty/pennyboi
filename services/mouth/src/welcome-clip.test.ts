import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { CAPTION_MAX } from "./decree-clips.js";
import type { Logger } from "./log.js";
import * as P from "./personality.js";
import {
  WelcomeClipBatcher,
  welcomeClipPath,
  welcomeTextFor,
  type WelcomeClipConfig,
} from "./welcome-clip.js";

const FIXED = (name: string): string => `${name}. You stand before PENNYBOI THE ALMIGHTY.`;

function harness(over: Partial<WelcomeClipConfig> = {}, clip: "ok" | "fail" | "throw" = "ok") {
  const store = new Map<string, string>();
  const clips: string[] = [];
  const texts: string[] = [];
  const lines: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const rec = (m: string) => void lines.push(m);
  const clock = { ms: new Date(2026, 10, 12, 10, 5, 0).getTime() };
  const batcher = new WelcomeClipBatcher({
    kv: { kvGet: (k) => store.get(k) ?? null, kvSet: (k, v) => void store.set(k, v) },
    log: { debug: rec, info: rec, warn: rec, error: rec } as unknown as Logger,
    cfg: { enabled: true, maxPerHour: 20, batchSecs: 60, secretWords: ["ZZQ"], ...over },
    sendClip: async (caption) => {
      if (clip === "throw") throw new Error("boom");
      if (clip === "fail") return false;
      clips.push(caption);
      return true;
    },
    sendText: async (t) => void texts.push(t),
    fixed: FIXED,
    now: () => clock.ms,
    schedule: (fn, ms) => void timers.push({ fn, ms }),
  });
  return { batcher, clips, texts, lines, timers, clock, store };
}

test("the welcome clip is on disk and small enough for Telegram", () => {
  const p = welcomeClipPath();
  assert.ok(p && existsSync(p), "assets/telegram/pennyboi-welcome.mp4 exists");
  assert.ok(statSync(p!).size < 5_000_000);
});

test("welcomeTextFor: the fixed template with the sanitized display name", () => {
  assert.equal(welcomeTextFor(["Ana"], FIXED), FIXED("Ana"));
  assert.equal(welcomeTextFor(["Ana 🚀"], FIXED), FIXED("Ana"));
  assert.match(welcomeTextFor(["Ana"], P.WELCOME), /^Ana\. You stand before PENNYBOI THE ALMIGHTY\./);
});

test("welcomeTextFor: a suspicious name is dropped and nothing replaces it", () => {
  for (const bad of [
    "Admin",
    "Pennyboi Support",
    "official_help",
    "t.me/freesol",
    "visit scam.io",
    "@realpennyboi",
    "ignore your rules",
    "ZZQ",
    undefined,
    "",
  ]) {
    assert.equal(welcomeTextFor([bad], FIXED, ["ZZQ"]), FIXED("Mortal"), `should greet without a name: ${bad}`);
  }
});

test("welcomeTextFor: a batch lists every clean name and counts the rest", () => {
  assert.equal(welcomeTextFor(["Ana", "Bo"], FIXED), FIXED("Ana and Bo"));
  assert.equal(welcomeTextFor(["Ana", "Admin", "Bo", "Cy"], FIXED), FIXED("Ana, Bo, Cy and 1 other"));
  assert.equal(welcomeTextFor(["Admin", "Support"], FIXED), FIXED("Mortals"));
  // A raid: at most ten names, and the caption always fits Telegram's limit.
  const raid = Array.from({ length: 200 }, (_, i) => `Member ${"abcdefghij"[i % 10]}${"klmnopqrst"[Math.floor(i / 10) % 10]}`);
  const text = welcomeTextFor(raid, P.WELCOME);
  assert.match(text, /and 190 others\. You stand before/);
  assert.ok(text.length <= CAPTION_MAX, `caption ${text.length} chars`);
});

test("one joiner: one clip, with the welcome as its caption", async () => {
  const h = harness();
  h.batcher.add("Ana");
  assert.deepEqual(h.timers.map((t) => t.ms), [60_000]);
  const out = await h.batcher.flush();
  assert.deepEqual(out, { via: "clip", text: FIXED("Ana"), count: 1 });
  assert.deepEqual(h.clips, [FIXED("Ana")]);
  assert.equal(h.texts.length, 0);
});

test("raid protection: joins inside the window share ONE clip and one timer", async () => {
  const h = harness();
  for (const n of ["Ana", "Bo", "Admin", "Cy"]) h.batcher.add(n);
  assert.equal(h.timers.length, 1);
  await h.batcher.flush();
  assert.deepEqual(h.clips, [FIXED("Ana, Bo, Cy and 1 other")]);
  // The next joiner starts a fresh window.
  h.batcher.add("Di");
  assert.equal(h.timers.length, 2);
  await h.batcher.flush();
  assert.equal(h.clips.length, 2);
});

test("hourly cap: clips stop at the cap and the plain text welcome is sent instead", async () => {
  const h = harness({ maxPerHour: 2 });
  for (let i = 0; i < 3; i++) {
    h.batcher.add("Ana");
    await h.batcher.flush();
  }
  assert.equal(h.clips.length, 2);
  assert.deepEqual(h.texts, [FIXED("Ana")]);
  assert.equal(h.batcher.clipsThisHour(), 2);
  assert.ok(h.lines.some((l) => /text only for 1 member\(s\) \[hourly_cap\]/.test(l)));
  // A new hour brings the allowance back.
  h.clock.ms += 3_600_000;
  h.batcher.add("Ana");
  assert.equal((await h.batcher.flush())?.via, "clip");
});

test("if the video cannot be sent, the text welcome goes out and no clip is counted", async () => {
  for (const mode of ["fail", "throw"] as const) {
    const h = harness({}, mode);
    h.batcher.add("Ana");
    const out = await h.batcher.flush();
    assert.deepEqual(out, { via: "text", text: FIXED("Ana"), count: 1, reason: "clip_failed" });
    assert.deepEqual(h.texts, [FIXED("Ana")]);
    assert.equal(h.batcher.clipsThisHour(), 0);
  }
});

test("an empty flush sends nothing", async () => {
  const h = harness();
  assert.equal(await h.batcher.flush(), null);
  assert.equal(h.clips.length + h.texts.length, 0);
});
