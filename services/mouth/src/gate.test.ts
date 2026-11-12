import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { MemoryDb, resolveFromRoot, type GateTrialRow } from "@pennyboi/shared";
import {
  DM_WINDOW_SECS,
  GATE_TEXT,
  GRID_DIR,
  Gate,
  WINDOW_MARGIN_SECS,
  gateKeyboard,
  loadGrids,
  type GateApi,
  type GateConfig,
  type GateStore,
  type Grid,
  type JoinRequest,
} from "./gate.js";
import type { Logger } from "./log.js";

const CHAT = -1001;
const OWNER = 9000;
const MOD = 9001;
const T0 = new Date(2026, 10, 12, 10, 0, 0).getTime();
const GRIDS: Grid[] = [
  { file: "a.jpg", answer: 1 },
  { file: "b.jpg", answer: 2 },
  { file: "c.jpg", answer: 3 },
  { file: "d.jpg", answer: 4 },
];

interface Call {
  method: string;
  args: unknown[];
  at: number; // ms since T0
}

/** A plain in-memory store that copies rows in and out, like the database does. */
function memStore(): GateStore & { rows: Map<number, GateTrialRow> } {
  const rows = new Map<number, GateTrialRow>();
  return {
    rows,
    getGateTrial: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    saveGateTrial: (t) => void rows.set(t.user_id, { ...t }),
    openGateTrials: () =>
      [...rows.values()].filter((t) => t.status !== "approved" && t.status !== "declined").map((t) => ({ ...t })),
    gateTrialByToken: (token) => {
      const hit = [...rows.values()].find((t) => t.token === token);
      return hit ? { ...hit } : null;
    },
  };
}

function world(opts: { cfg?: Partial<GateConfig>; store?: GateStore; startMs?: number; photos?: number } = {}) {
  const clock = { ms: opts.startMs ?? T0 };
  let seq = 0;
  const timers: Array<{ at: number; seq: number; fn: () => unknown }> = [];
  const schedule = (fn: () => unknown, ms: number): void => void timers.push({ at: clock.ms + ms, seq: seq++, fn });
  /** Move time forward, running every timer that falls due, in order. */
  async function advance(ms: number): Promise<void> {
    const target = clock.ms + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      clock.ms = Math.max(clock.ms, next.at);
      await next.fn();
    }
    clock.ms = target;
  }

  const calls: Call[] = [];
  const failNext: Array<{ method: string; error: unknown }> = [];
  let msgId = 100;
  function record(method: string, args: unknown[]): void {
    calls.push({ method, args, at: clock.ms - T0 });
    const i = failNext.findIndex((f) => f.method === method);
    if (i >= 0) throw failNext.splice(i, 1)[0]!.error;
  }
  const api: GateApi = {
    async sendPhoto(chatId, photo, other) {
      record("sendPhoto", [chatId, photo, other]);
      return { message_id: ++msgId, photo: [{ file_id: `FILE-${String(photo)}` }] };
    },
    async sendMessage(chatId, text) {
      record("sendMessage", [chatId, text]);
    },
    async approveChatJoinRequest(chatId, userId) {
      record("approve", [chatId, userId]);
    },
    async declineChatJoinRequest(chatId, userId) {
      record("decline", [chatId, userId]);
    },
    async getUserProfilePhotos(userId) {
      record("photos", [userId]);
      return { total_count: opts.photos ?? 1 };
    },
  };

  const store = opts.store ?? memStore();
  const kv = new Map<string, string>();
  const lines: string[] = [];
  const rec = (m: string) => void lines.push(m);
  let tokens = 0;
  let pick = 0;
  const make = (): Gate =>
    new Gate({
      api,
      store,
      kv: { kvGet: (k) => kv.get(k) ?? null, kvSet: (k, v) => void kv.set(k, v) },
      log: { debug: rec, info: rec, warn: rec, error: rec } as unknown as Logger,
      cfg: { enabled: true, timeoutSecs: 180, cooldownSecs: 1800, dmIntervalMs: 1100, maxActive: 20, ...opts.cfg },
      chatId: CHAT,
      isTrusted: (id) => id === OWNER || id === MOD,
      grids: GRIDS,
      now: () => clock.ms,
      schedule,
      rng: () => (pick++ % 4) / 4 + 0.01, // walks through the grids in turn
      newToken: () => (++tokens).toString(16).padStart(8, "0"),
      photoFor: (g) => g.file,
    });
  const gate = make();

  const request = (userId: number, over: Partial<JoinRequest> = {}): JoinRequest => ({
    chatId: CHAT,
    userId,
    userChatId: userId + 50_000,
    date: Math.floor(clock.ms / 1000),
    firstName: "Ana",
    username: "ana",
    ...over,
  });
  /** Press the right or a wrong button on the grid this user currently has. */
  async function press(g: Gate, userId: number, which: "right" | "wrong", fromId = userId): Promise<string> {
    const t = store.getGateTrial(userId)!;
    assert.ok(t.token && t.answer, "the user has a live grid");
    const n = which === "right" ? t.answer! : (t.answer! % 4) + 1;
    return g.onButton({ fromId, data: `gate:${t.token}:${n}` });
  }
  const names = (): string[] => calls.map((c) => c.method);
  const texts = (): string[] => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.args[1]));
  return { gate, make, store, clock, advance, calls, names, texts, lines, failNext, request, press, kv };
}

test("the trial images on disk: 32 grids, every answer 1-4 equally often, all files present", () => {
  const grids = loadGrids();
  assert.equal(grids.length, 32);
  for (const n of [1, 2, 3, 4]) assert.equal(grids.filter((g) => g.answer === n).length, 8);
  for (const g of grids) assert.ok(existsSync(resolveFromRoot(join(GRID_DIR, g.file))), g.file);
});

test("buttons are labelled 1 to 4 only; the answer is not in them", () => {
  const rows = gateKeyboard("abcd").inline_keyboard;
  assert.deepEqual(rows.map((r) => r.map((b) => b.text)), [["1", "2"], ["3", "4"]]);
  const data = rows.flat().map((b) => ("callback_data" in b ? b.callback_data : ""));
  assert.deepEqual(data, ["gate:abcd:1", "gate:abcd:2", "gate:abcd:3", "gate:abcd:4"]);
});

test("a correct answer: the confirming DM goes out BEFORE the request is approved", async () => {
  const w = world();
  assert.equal(await w.gate.onJoinRequest(w.request(1)), "queued");
  await w.advance(100);
  assert.deepEqual(w.names(), ["sendPhoto"]);
  const [chat, , other] = w.calls[0]!.args as [number, string, { caption: string }];
  assert.equal(chat, 50_001, "sent to the join request's private chat id");
  assert.equal(other.caption, GATE_TEXT.trial);

  assert.equal(await w.press(w.gate, 1, "right"), "The gate opens.");
  await w.advance(5_000);
  assert.deepEqual(w.names(), ["sendPhoto", "sendMessage", "approve"]);
  assert.deepEqual(w.texts(), [GATE_TEXT.approved]);
  assert.deepEqual(w.calls[2]!.args, [CHAT, 1]);
  const t = w.store.getGateTrial(1)!;
  assert.deepEqual({ s: t.status, r: t.reason, c: t.cooldown_until }, { s: "approved", r: "correct", c: 0 });
  assert.ok(!w.names().includes("photos"), "a username means no profile-photo lookup");
});

test("wrong once: one retry on a NEW grid; wrong twice: declined with a cooldown", async () => {
  const w = world();
  await w.gate.onJoinRequest(w.request(1));
  await w.advance(100);
  const first = w.store.getGateTrial(1)!;
  assert.equal(await w.press(w.gate, 1, "wrong"), "Wrong. One more chance.");
  await w.advance(2_000);
  const second = w.store.getGateTrial(1)!;
  assert.notEqual(second.grid, first.grid, "a different grid");
  assert.notEqual(second.token, first.token);
  assert.equal((w.calls[1]!.args[2] as { caption: string }).caption, GATE_TEXT.retry);
  // The first grid's buttons are dead.
  assert.equal(await w.gate.onButton({ fromId: 1, data: `gate:${first.token}:${first.answer}` }), "This trial has ended.");

  assert.equal(await w.press(w.gate, 1, "wrong"), "Wrong. The gate stays shut.");
  await w.advance(5_000);
  assert.deepEqual(w.names(), ["sendPhoto", "sendPhoto", "sendMessage", "decline"]);
  assert.deepEqual(w.texts(), [GATE_TEXT.wrong(1800)]);
  assert.match(w.texts()[0]!, /Return in 30 minutes/);
  const t = w.store.getGateTrial(1)!;
  assert.deepEqual({ s: t.status, r: t.reason }, { s: "declined", r: "wrong" });
  assert.equal(t.cooldown_until, Math.floor(w.clock.ms / 1000) - 5 + 1800);
});

test("cooldown: a new request inside it is told when to return and declined, with no trial", async () => {
  const w = world();
  await w.gate.onJoinRequest(w.request(1));
  await w.advance(100);
  await w.press(w.gate, 1, "wrong");
  await w.advance(2_000);
  await w.press(w.gate, 1, "wrong");
  await w.advance(5_000);
  const before = w.calls.length;

  await w.advance(10 * 60_000);
  assert.equal(await w.gate.onJoinRequest(w.request(1)), "cooldown");
  await w.advance(5_000);
  assert.deepEqual(w.names().slice(before), ["sendMessage", "decline"]);
  assert.match(w.texts().at(-1)!, /^Not yet, mortal\. The gate opens to you again in 20 minutes\.$/);

  // Once the cooldown has passed, they are tested again.
  await w.advance(21 * 60_000);
  assert.equal(await w.gate.onJoinRequest(w.request(1)), "queued");
  await w.advance(100);
  assert.equal(w.names().at(-1), "sendPhoto");
  assert.equal(w.store.getGateTrial(1)!.attempts, 2);
});

test("no answer within the time limit: verdict DM, then declined, with a cooldown", async () => {
  const w = world();
  await w.gate.onJoinRequest(w.request(1));
  await w.advance(100);
  await w.advance(179_000);
  assert.deepEqual(w.names(), ["sendPhoto"], "nothing happens before the limit");
  await w.advance(3_000);
  assert.deepEqual(w.names(), ["sendPhoto", "sendMessage", "decline"]);
  assert.deepEqual(w.texts(), [GATE_TEXT.timeout(1800)]);
  const t = w.store.getGateTrial(1)!;
  assert.deepEqual({ s: t.status, r: t.reason }, { s: "declined", r: "timeout" });
  assert.ok(t.cooldown_until > 0);
  // A late press does nothing.
  assert.equal(await w.gate.onButton({ fromId: 1, data: "gate:00000001:1" }), "This trial has ended.");
});

test("everything stays inside Telegram's 5-minute window, however long the timeout is set", async () => {
  const w = world({ cfg: { timeoutSecs: 3600 } });
  const req = w.request(1);
  await w.gate.onJoinRequest(req);
  await w.advance(100);
  const t = w.store.getGateTrial(1)!;
  assert.ok(t.deadline_ts <= req.date + DM_WINDOW_SECS - WINDOW_MARGIN_SECS - 10);
  await w.advance(300_000);
  const verdict = w.calls.find((c) => c.method === "sendMessage")!;
  assert.ok(verdict.at <= (DM_WINDOW_SECS - WINDOW_MARGIN_SECS) * 1000, `verdict DM at ${verdict.at}ms`);
  assert.ok(w.calls.findIndex((c) => c.method === "sendMessage") < w.calls.findIndex((c) => c.method === "decline"));
});

test("no profile photo AND no username: two correct rounds are required", async () => {
  const w = world({ photos: 0 });
  await w.gate.onJoinRequest(w.request(1, { username: undefined }));
  await w.advance(100);
  assert.equal(w.store.getGateTrial(1)!.needed, 2);
  assert.equal(await w.press(w.gate, 1, "right"), "Good. One more.");
  await w.advance(2_000);
  assert.equal((w.calls.at(-1)!.args[2] as { caption: string }).caption, GATE_TEXT.second);
  assert.ok(!w.names().includes("approve"), "not approved after one round");
  assert.equal(await w.press(w.gate, 1, "right"), "The gate opens.");
  await w.advance(5_000);
  assert.equal(w.names().at(-1), "approve");

  // A photo but no username, or a username but no photo: one round.
  const photo = world({ photos: 3 });
  await photo.gate.onJoinRequest(photo.request(2, { username: undefined }));
  assert.equal(photo.store.getGateTrial(2)!.needed, 1);
  const user = world({ photos: 0 });
  await user.gate.onJoinRequest(user.request(3, { username: "bo" }));
  assert.equal(user.store.getGateTrial(3)!.needed, 1);
});

test("the owner and moderators are never tested", async () => {
  const w = world();
  assert.equal(await w.gate.onJoinRequest(w.request(OWNER)), "trusted");
  assert.equal(await w.gate.onJoinRequest(w.request(MOD)), "trusted");
  await w.advance(5_000);
  assert.deepEqual(w.names(), ["approve", "approve"]);
  assert.equal(w.store.getGateTrial(OWNER), null);
});

test("a button press only counts for the user the trial was sent to", async () => {
  const w = world();
  await w.gate.onJoinRequest(w.request(1));
  await w.advance(100);
  assert.equal(await w.press(w.gate, 1, "right", 777), "This trial is not yours.");
  assert.equal(await w.press(w.gate, 1, "wrong", 777), "This trial is not yours.");
  const t = w.store.getGateTrial(1)!;
  assert.deepEqual({ s: t.status, c: t.correct, w: t.wrong }, { s: "pending", c: 0, w: 0 });
  for (const junk of ["gate:zz:1", "gate:00000001:9", "other", ""]) {
    assert.equal(await w.gate.onButton({ fromId: 1, data: junk }), "This trial has ended.");
  }
  assert.deepEqual(w.names(), ["sendPhoto"]);
});

test("cancelling and asking again mid-trial does not wipe a wrong answer", async () => {
  const w = world();
  await w.gate.onJoinRequest(w.request(1));
  await w.advance(100);
  await w.press(w.gate, 1, "wrong");
  await w.advance(2_000);
  await w.gate.onJoinRequest(w.request(1)); // a fresh request while the trial is open
  await w.advance(2_000);
  assert.equal(w.store.getGateTrial(1)!.wrong, 1);
  assert.equal(await w.press(w.gate, 1, "wrong"), "Wrong. The gate stays shut.");
});

test("requests for another chat are ignored; an old request gets no trial and no penalty", async () => {
  const w = world();
  assert.equal(await w.gate.onJoinRequest(w.request(1, { chatId: -555 })), "ignored");
  // Learned of 4.5 minutes late (the bot was down): too late to message fairly.
  const old = w.request(2, { date: Math.floor(w.clock.ms / 1000) - 270 });
  assert.equal(await w.gate.onJoinRequest(old), "stale");
  await w.advance(5_000);
  assert.deepEqual(w.names(), ["decline"], "declined with no DM");
  const t = w.store.getGateTrial(2)!;
  assert.deepEqual({ s: t.status, r: t.reason, c: t.cooldown_until }, { s: "declined", r: "stale_request", c: 0 });
});

test("a wave of requests: messages are paced, trials are capped, the rest are declined with no DM", async () => {
  const w = world({ cfg: { maxActive: 20, dmIntervalMs: 1100 } });
  const outcomes: string[] = [];
  for (let u = 1; u <= 30; u++) outcomes.push(await w.gate.onJoinRequest(w.request(u)));
  assert.equal(outcomes.filter((o) => o === "queued").length, 20);
  assert.equal(outcomes.filter((o) => o === "busy").length, 10);
  await w.advance(60_000);

  const photos = w.calls.filter((c) => c.method === "sendPhoto");
  assert.equal(photos.length, 20, "exactly the capped number of trials were messaged");
  assert.equal(w.calls.filter((c) => c.method === "sendMessage").length, 0, "nobody over the cap was messaged");
  assert.equal(w.calls.filter((c) => c.method === "decline").length, 10);
  // Never two outbound calls closer together than the interval.
  const paced = w.calls.filter((c) => c.method === "sendPhoto" || c.method === "decline").map((c) => c.at);
  for (let i = 1; i < paced.length; i++) assert.ok(paced[i]! - paced[i - 1]! >= 1100, `gap ${paced[i]! - paced[i - 1]!}ms`);
  for (let u = 21; u <= 30; u++) {
    const t = w.store.getGateTrial(u)!;
    assert.deepEqual({ s: t.status, r: t.reason, c: t.cooldown_until }, { s: "declined", r: "busy", c: 0 });
  }
});

test("a flood-limit error from Telegram pauses the queue for as long as told, then delivers", async () => {
  const w = world();
  w.failNext.push({ method: "sendPhoto", error: { error_code: 429, parameters: { retry_after: 7 } } });
  await w.gate.onJoinRequest(w.request(1));
  await w.advance(6_000);
  assert.deepEqual(w.names(), ["sendPhoto"], "the failed attempt only; nothing during the pause");
  assert.equal(w.store.getGateTrial(1)!.status, "queued");
  await w.advance(2_000);
  assert.deepEqual(w.names(), ["sendPhoto", "sendPhoto"]);
  assert.equal(w.store.getGateTrial(1)!.status, "pending");
  assert.ok(w.lines.some((l) => /flood limit — pausing all gate messages for 7s/.test(l)));
});

test("a requester who cannot be messaged is declined with no cooldown", async () => {
  const w = world();
  w.failNext.push({ method: "sendPhoto", error: { error_code: 403, description: "Forbidden: bot was blocked by the user" } });
  await w.gate.onJoinRequest(w.request(1));
  await w.advance(5_000);
  assert.deepEqual(w.names(), ["sendPhoto", "decline"]);
  const t = w.store.getGateTrial(1)!;
  assert.deepEqual({ s: t.status, r: t.reason, c: t.cooldown_until }, { s: "declined", r: "dm_failed", c: 0 });
});

test("restart: state survives in the database; nobody is approved unproven and nobody is lost", async () => {
  const path = join(tmpdir(), `pb-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new MemoryDb(path);
  try {
    const a = world({ store: db });
    await a.gate.onJoinRequest(a.request(1)); // will be answered correctly, approval interrupted
    await a.gate.onJoinRequest(a.request(2)); // left waiting for an answer
    await a.gate.onJoinRequest(a.request(3)); // wrong once, retry grid never delivered
    await a.advance(4_000);
    await a.press(a.gate, 3, "wrong");
    await a.press(a.gate, 1, "right");
    // The process dies here: user 1 is "approving", user 2 "pending", user 3 "pending" with no live grid.
    assert.deepEqual(
      db.openGateTrials().map((t) => [t.user_id, t.status, t.token === null]),
      [[1, "approving", true], [2, "pending", false], [3, "pending", true]]
    );

    // A new process, 20 seconds later, on the same database.
    const b = world({ store: db, startMs: a.clock.ms + 20_000 });
    assert.equal(b.gate.restore(), 3);
    await b.advance(3_000);
    assert.deepEqual(b.calls.filter((c) => c.method === "approve").map((c) => c.args[1]), [1], "only the one who passed");
    assert.equal(db.getGateTrial(1)!.status, "approved");
    assert.equal(db.getGateTrial(2)!.status, "pending", "still being tested, same deadline");
    assert.ok(db.getGateTrial(3)!.token, "the retry grid was sent after the restart");

    // User 2 answers on the grid sent before the restart.
    assert.equal(await b.press(b.gate, 2, "right"), "The gate opens.");
    // User 3 never answers: the original deadline still applies.
    await b.advance(200_000);
    assert.equal(db.getGateTrial(2)!.status, "approved");
    const three = db.getGateTrial(3)!;
    assert.deepEqual({ s: three.status, r: three.reason }, { s: "declined", r: "timeout" });
    assert.equal(db.openGateTrials().length, 0);
  } finally {
    for (const ext of ["", "-wal", "-shm"]) rmSync(path + ext, { force: true });
  }
});

test("restart long after: an expired trial is declined without a DM, since the window has shut", async () => {
  const a = world();
  await a.gate.onJoinRequest(a.request(1));
  await a.advance(2_000);
  const b = world({ store: a.store, startMs: a.clock.ms + 3_600_000 });
  b.gate.restore();
  await b.advance(5_000);
  assert.deepEqual(b.names(), ["decline"]);
  assert.equal(a.store.getGateTrial(1)!.reason, "timeout");
});
