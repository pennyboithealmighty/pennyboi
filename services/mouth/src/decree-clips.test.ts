import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { CAPTION_MAX, DECREE_CLIPS, clipPathFor, sendClip, type ClipDeps } from "./decree-clips.js";
import type { Logger } from "./log.js";

function harness(opts: { fail?: Array<"cached" | "upload">; cachedId?: string; path?: string | null } = {}) {
  const store = new Map<string, string>();
  if (opts.cachedId) store.set("tg_clip_file_id:burn", opts.cachedId);
  const calls: Array<{ chatId: number; video: unknown; caption?: string; thread?: number }> = [];
  const lines: string[] = [];
  const rec = (m: string) => void lines.push(m);
  const deps: ClipDeps = {
    api: {
      async sendVideo(chatId, video, other) {
        calls.push({ chatId, video, caption: other?.caption, thread: other?.message_thread_id });
        const kind = typeof video === "string" ? "cached" : "upload";
        if (opts.fail?.includes(kind)) throw new Error(`${kind} refused`);
        return { video: { file_id: "FILE123" } };
      },
    },
    kv: { kvGet: (k) => store.get(k) || null, kvSet: (k, v) => void store.set(k, v) },
    log: { debug: rec, info: rec, warn: rec, error: rec } as unknown as Logger,
    pathFor: () => (opts.path === undefined ? "/tmp/clip.mp4" : opts.path),
  };
  return { deps, store, calls, lines };
}

const TARGET = { chatId: -100, threadId: 7 };

test("the three decree clips exist on disk; non-decrees have none", () => {
  for (const action of Object.keys(DECREE_CLIPS)) {
    const p = clipPathFor(action);
    assert.ok(p && existsSync(p), `clip for ${action}`);
  }
  assert.deepEqual(Object.keys(DECREE_CLIPS).sort(), ["airdrop", "bounty", "burn"]);
  assert.equal(clipPathFor("none"), null);
  assert.equal(clipPathFor("sermon"), null);
});

test("first send uploads the file with the narration as caption and caches the file id", async () => {
  const h = harness();
  assert.equal(await sendClip(h.deps, TARGET, "burn", "BEHOLD. I burn.\n\nhttps://solscan.io/tx/abc"), true);
  assert.equal(h.calls.length, 1);
  assert.notEqual(typeof h.calls[0]!.video, "string", "an upload, not a file id");
  assert.equal(h.calls[0]!.caption, "BEHOLD. I burn.\n\nhttps://solscan.io/tx/abc");
  assert.deepEqual({ c: h.calls[0]!.chatId, t: h.calls[0]!.thread }, { c: -100, t: 7 });
  assert.equal(h.store.get("tg_clip_file_id:burn"), "FILE123");
});

test("later sends reuse the cached file id; a stale id falls back to uploading", async () => {
  const ok = harness({ cachedId: "OLD" });
  assert.equal(await sendClip(ok.deps, TARGET, "burn", "again"), true);
  assert.deepEqual(ok.calls.map((c) => c.video), ["OLD"]);

  const stale = harness({ cachedId: "OLD", fail: ["cached"] });
  assert.equal(await sendClip(stale.deps, TARGET, "burn", "again"), true);
  assert.equal(stale.calls.length, 2);
  assert.equal(stale.store.get("tg_clip_file_id:burn"), "FILE123");
});

test("any failure returns false so the text announcement is sent instead", async () => {
  const down = harness({ fail: ["upload"] });
  assert.equal(await sendClip(down.deps, TARGET, "burn", "text"), false);
  assert.ok(down.lines.some((l) => /failed — sending text/.test(l)));

  const missing = harness({ path: null });
  assert.equal(await sendClip(missing.deps, TARGET, "burn", "text"), false);
  assert.equal(missing.calls.length, 0);

  const long = harness();
  assert.equal(await sendClip(long.deps, TARGET, "burn", "x".repeat(CAPTION_MAX + 1)), false);
  assert.equal(long.calls.length, 0);
});
