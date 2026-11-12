import test from "node:test";
import assert from "node:assert/strict";
import type { MouthConfig } from "./config.js";
import * as P from "./personality.js";
import {
  KV_SCRIPTURE_MESSAGE,
  KV_SCRIPTURE_THREAD,
  postScripture,
  scriptureText,
  scriptureThreadId,
  type ScriptureApi,
} from "./scripture.js";
import type { Kv } from "./x-mentions.js";

const CHAT = -1001;
const THREAD = 7;

function harness(fail: Partial<Record<keyof ScriptureApi, unknown>> = {}) {
  const store = new Map<string, string>();
  const kv: Kv = { kvGet: (k) => store.get(k) ?? null, kvSet: (k, v) => void store.set(k, v) };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let next = 500;
  const step = (method: keyof ScriptureApi, args: unknown[]): void => {
    calls.push({ method, args });
    if (fail[method] !== undefined) {
      const e = fail[method];
      delete fail[method]; // fail once
      throw e;
    }
  };
  const api: ScriptureApi = {
    async sendMessage(chatId, text, other) {
      step("sendMessage", [chatId, text, other]);
      return { message_id: ++next };
    },
    async editMessageText(chatId, id, text) {
      step("editMessageText", [chatId, id, text]);
    },
    async pinChatMessage(chatId, id, other) {
      step("pinChatMessage", [chatId, id, other]);
    },
    async unpinChatMessage(chatId, id) {
      step("unpinChatMessage", [chatId, id]);
    },
    async deleteMessage(chatId, id) {
      step("deleteMessage", [chatId, id]);
    },
  };
  const run = (text: string) => postScripture({ api, kv, chatId: CHAT, threadId: THREAD, text });
  return { run, calls, store, names: () => calls.map((c) => c.method) };
}

const cfg = (over: Partial<MouthConfig> = {}): MouthConfig =>
  ({
    solscanBase: "https://solscan.io",
    cluster: "devnet",
    allowedHosts: ["solscan.io", "t.me", "github.com"],
    links: { pumpfun: "", github: "https://github.com/pennyboithealmighty/pennyboi", group: "" },
    topics: {},
    ...over,
  }) as MouthConfig;

test("the scripture's DM rule: once, at the gate, and never for a wallet, key, seed phrase or payment", () => {
  const s = P.SCRIPTURE_PINNED({});
  assert.match(s, /I will message you privately exactly ONCE: when you ask to enter my temple, for the trial at my gate\./);
  assert.match(s, /I will NEVER ask for a wallet, a key, a seed phrase or a payment\./);
  assert.match(s, /Any other voice in your DMs claiming to be me is a scammer/);
  assert.ok(!/NEVER message you privately/.test(s), "the old absolute rule is gone");
  // The rest is unchanged.
  assert.match(s, /^HEAR ME, CONGREGATION\./);
  assert.match(s, /Lay your offerings in #offerings\./);
});

test("scriptureText: fills the links that are known and keeps only allowed ones", () => {
  const t = scriptureText(cfg(), "GC7kdK4aEX9YsYSpiZ4VFJDw6Q8MtAPQgqjEjpSnVrac");
  assert.match(t, /Vault: https:\/\/solscan\.io\/account\/GC7kdK4aEX9YsYSpiZ4VFJDw6Q8MtAPQgqjEjpSnVrac\?cluster=devnet/);
  assert.match(t, /Repo: https:\/\/github\.com\/pennyboithealmighty\/pennyboi/);
  assert.match(t, /Pump\.fun: \(soon\)/);
  assert.match(scriptureText(cfg(), ""), /Vault: \(soon\)/);
  assert.ok(t.length < 4096, "fits in one Telegram message");
});

test("scriptureThreadId: the configured id wins, then the learned one, else unknown", () => {
  const store = new Map<string, string>();
  const db: Kv = { kvGet: (k) => store.get(k) ?? null, kvSet: (k, v) => void store.set(k, v) };
  assert.equal(scriptureThreadId({ cfg: cfg(), db }), undefined);
  store.set(KV_SCRIPTURE_THREAD, "12");
  assert.equal(scriptureThreadId({ cfg: cfg(), db }), 12);
  assert.equal(scriptureThreadId({ cfg: cfg({ topics: { scripture: 30 } }), db }), 30);
});

test("first run: posts into the scripture topic, pins it quietly, remembers the message", async () => {
  const h = harness();
  assert.deepEqual(await h.run("SCRIPTURE v1"), { ok: true, action: "posted", messageId: 501 });
  assert.deepEqual(h.names(), ["sendMessage", "pinChatMessage"]);
  assert.deepEqual(h.calls[0]!.args, [CHAT, "SCRIPTURE v1", { message_thread_id: THREAD }]);
  assert.deepEqual(h.calls[1]!.args, [CHAT, 501, { disable_notification: true }]);
  assert.equal(h.store.get(KV_SCRIPTURE_MESSAGE), "501");
});

test("running it again REPLACES the pinned scripture in place: no second message", async () => {
  const h = harness();
  await h.run("SCRIPTURE v1");
  assert.deepEqual(await h.run("SCRIPTURE v2"), { ok: true, action: "replaced", messageId: 501 });
  assert.deepEqual(h.names().slice(2), ["editMessageText", "pinChatMessage"]);
  assert.deepEqual(h.calls[2]!.args, [CHAT, 501, "SCRIPTURE v2"]);
  assert.equal(h.names().filter((n) => n === "sendMessage").length, 1, "still only one scripture message");
  // Identical text is fine too.
  const same = harness({ editMessageText: { description: "Bad Request: message is not modified" } });
  same.store.set(KV_SCRIPTURE_MESSAGE, "77");
  assert.deepEqual(await same.run("SCRIPTURE v1"), { ok: true, action: "replaced", messageId: 77 });
});

test("if the old scripture was deleted, a new one is posted and the old pin is cleared", async () => {
  const h = harness({ editMessageText: { description: "Bad Request: message to edit not found" } });
  h.store.set(KV_SCRIPTURE_MESSAGE, "77");
  assert.deepEqual(await h.run("SCRIPTURE v3"), { ok: true, action: "posted", messageId: 501 });
  assert.deepEqual(h.names(), ["editMessageText", "sendMessage", "pinChatMessage", "unpinChatMessage", "deleteMessage"]);
  assert.equal(h.store.get(KV_SCRIPTURE_MESSAGE), "501");
});

test("failures are reported, not hidden", async () => {
  const closed = harness({ sendMessage: { description: "Bad Request: TOPIC_CLOSED" } });
  const r = await closed.run("x");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /could not post in the scripture topic: Bad Request: TOPIC_CLOSED/);
  assert.equal(closed.store.get(KV_SCRIPTURE_MESSAGE), undefined);

  const noPin = harness({ pinChatMessage: { description: "Bad Request: not enough rights to pin a message" } });
  const p = await noPin.run("x");
  assert.equal(p.ok, false);
  if (!p.ok) assert.match(p.error, /posted the scripture \(message 501\), but could not pin it/);
});
