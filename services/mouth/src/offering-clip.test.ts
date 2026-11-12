import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import type { MouthCtx } from "./deps.js";
import { CAPTION_MAX } from "./decree-clips.js";
import type { Logger } from "./log.js";
import { OFFERING_CLIP_KEY, offeringClipPath, sendOfferingClip } from "./offering-clip.js";
import { composeOfferingThanks } from "./offering-thanker.js";

function ctx(opts: { fail?: boolean; chatId?: number } = {}) {
  const store = new Map<string, string>();
  const calls: Array<{ chatId: number; video: unknown; caption?: string; thread?: number }> = [];
  const lines: string[] = [];
  const rec = (m: string) => void lines.push(m);
  const m = {
    cfg: { chatId: opts.chatId ?? -100, allowedHosts: ["solscan.io", "t.me"] },
    db: { kvGet: (k: string) => store.get(k) || null, kvSet: (k: string, v: string) => void store.set(k, v) },
    log: { debug: rec, info: rec, warn: rec, error: rec } as unknown as Logger,
    bot: {
      api: {
        async sendVideo(chatId: number, video: unknown, other?: { caption?: string; message_thread_id?: number }) {
          calls.push({ chatId, video, caption: other?.caption, thread: other?.message_thread_id });
          if (opts.fail) throw new Error("refused");
          return { video: { file_id: "OFFER-FILE" } };
        },
      },
    },
  } as unknown as MouthCtx;
  return { m, store, calls, lines };
}

/** Run with the flag set for the duration of one test. */
async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.TG_OFFERING_CLIP_ENABLED;
  if (value === undefined) delete process.env.TG_OFFERING_CLIP_ENABLED;
  else process.env.TG_OFFERING_CLIP_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TG_OFFERING_CLIP_ENABLED;
    else process.env.TG_OFFERING_CLIP_ENABLED = prev;
  }
}

test("the offering clip is on disk and small enough for Telegram", () => {
  const p = offeringClipPath();
  assert.ok(p && existsSync(p), "assets/telegram/pennyboi-offering.mp4 exists");
  assert.ok(statSync(p!).size < 5_000_000);
});

test("off by default: nothing is sent, so the caller sends the text as before", async () => {
  const h = ctx();
  assert.equal(await withFlag("false", () => sendOfferingClip(h.m, "thanks", 4)), false);
  assert.equal(h.calls.length, 0);
});

test("on: ONE clip for a whole batch, in the offerings topic, with the thank-you as the caption", async () => {
  const h = ctx();
  const message = composeOfferingThanks("The Allowance swells.", [
    { display: "THE FAITHFUL", sol: 0.05, solscanUrl: "https://solscan.io/tx/aaa?cluster=devnet" },
    { display: "7xKq…9fPa", sol: 0.1, solscanUrl: "https://solscan.io/tx/bbb?cluster=devnet" },
    { display: "Bo", sol: 0.02, solscanUrl: "https://solscan.io/tx/ccc?cluster=devnet" },
  ]);
  assert.equal(await withFlag("true", () => sendOfferingClip(h.m, message, 4)), true);
  assert.equal(h.calls.length, 1, "three donors, one clip");
  assert.deepEqual({ c: h.calls[0]!.chatId, t: h.calls[0]!.thread }, { c: -100, t: 4 });
  assert.equal(h.calls[0]!.caption, message);
  assert.equal(h.store.get(`tg_clip_file_id:${OFFERING_CLIP_KEY}`), "OFFER-FILE", "the file id is cached");

  // The next thank-you reuses Telegram's copy instead of uploading again.
  await withFlag("true", () => sendOfferingClip(h.m, "Another tithe.", 4));
  assert.equal(h.calls[1]!.video, "OFFER-FILE");
});

test("the caption goes through the same link filter as other group messages", async () => {
  const h = ctx();
  await withFlag("true", () =>
    sendOfferingClip(h.m, "Thanks. https://evil.example/claim and https://solscan.io/tx/aaa", undefined)
  );
  assert.equal(h.calls[0]!.caption, "Thanks. [link removed] and https://solscan.io/tx/aaa");
});

test("fallbacks: a refused video, an over-long caption or no chat id all return false for the text path", async () => {
  const refused = ctx({ fail: true });
  assert.equal(await withFlag("true", () => sendOfferingClip(refused.m, "thanks", 4)), false);
  assert.ok(refused.lines.some((l) => /failed — sending text/.test(l)));

  const long = ctx();
  assert.equal(await withFlag("true", () => sendOfferingClip(long.m, "x".repeat(CAPTION_MAX + 1), 4)), false);
  assert.equal(long.calls.length, 0);

  const noChat = ctx({ chatId: 0 });
  assert.equal(await withFlag("true", () => sendOfferingClip(noChat.m, "thanks", 4)), false);
});
