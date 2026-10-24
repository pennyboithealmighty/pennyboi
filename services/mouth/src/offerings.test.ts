import test from "node:test";
import assert from "node:assert/strict";
import { rankOfferings, type OfferingRecord } from "./offerings.js";

function row(id: number, upvotes: number, ts: number): OfferingRecord {
  return { id, upvotes, ts, wallet: `u${id}`, text: `offer ${id}`, chosen: 0 };
}

test("ranks by upvotes desc, ties by earliest ts", () => {
  const rows = [row(1, 3, 100), row(2, 5, 200), row(3, 5, 150), row(4, 1, 50)];
  const top = rankOfferings(rows, 3);
  assert.deepEqual(
    top.map((r) => r.id),
    [3, 2, 1] // 5@150 before 5@200, then 3
  );
});

test("caps the result at n", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(i, i, i));
  assert.equal(rankOfferings(rows, 5).length, 5);
});
