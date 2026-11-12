import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { MemoryDb } from "@pennyboi/shared";
import { PostGuard, shapeForPublic, shouldAllowPublicPost } from "./public-post.js";

function tempDb(): { db: MemoryDb; cleanup: () => void } {
  const path = join(tmpdir(), `pb-post-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new MemoryDb(path);
  return {
    db,
    cleanup: () => {
      for (const ext of ["", "-wal", "-shm"]) {
        try {
          rmSync(path + ext, { force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
}

test("shouldAllowPublicPost: scheduled posts obey the cap, decrees are exempt", () => {
  assert.equal(shouldAllowPublicPost("scheduled", 0, 1), true);
  assert.equal(shouldAllowPublicPost("scheduled", 1, 1), false);
  assert.equal(shouldAllowPublicPost("decree", 99, 1), true); // never capped
});

test("PostGuard: one scheduled post per channel per day, persisted in kv; decrees pass", () => {
  const { db, cleanup } = tempDb();
  try {
    const g = new PostGuard(db, 1);
    assert.equal(g.tryTake("telegram", "scheduled"), true); // the sermon
    assert.equal(g.tryTake("telegram", "scheduled"), false); // any second scheduled TG post
    assert.equal(g.tryTake("x", "scheduled"), true); // channels are independent
    assert.equal(g.tryTake("x", "scheduled"), false);
    assert.equal(g.tryTake("telegram", "decree"), true); // decrees exempt, and...
    assert.equal(g.countToday("telegram"), 1, "...decrees don't consume the scheduled slot");

    // A fresh guard instance (restart) still sees today's count.
    assert.equal(new PostGuard(db, 1).tryTake("telegram", "scheduled"), false);

    // A new day resets.
    const tomorrow = Date.now() + 86_400_000;
    assert.equal(g.tryTake("telegram", "scheduled", tomorrow), true);
  } finally {
    cleanup();
  }
});

test("shapeForPublic: clamps, throttles catchphrases across posts, persists state", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = shapeForPublic(db, "The hall is EMPTY, my pennies. Tremble.", 200);
    assert.equal(a, "The hall is EMPTY, my pennies. Tremble.");
    // Used again on the very next post -> stripped (within the 5-post window).
    const b = shapeForPublic(db, "Still empty, my pennies. I wait.", 200);
    assert.equal(b, "Still empty. I wait.");
    assert.equal(db.kvGet("public_post_counter"), "2");
    // Over-length text is cut at the last full sentence.
    const long = "One short verdict. " + "This second sentence rambles on far longer than the limit allows for sure.";
    const c = shapeForPublic(db, long, 40);
    assert.equal(c, "One short verdict.");
    // Hard sentence cap: never more than 3, even when the chars would fit.
    const d = shapeForPublic(db, "One. Two. Three. Four. Five.", 200);
    assert.equal(d, "One. Two. Three.");
  } finally {
    cleanup();
  }
});
