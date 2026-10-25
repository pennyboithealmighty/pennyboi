// docs/12 §4/§8: dust is excluded from the public list but counted in stats;
// receipts resolve by signature and by reference. Exercised against a real
// (temp) MemoryDb so the SQL is covered.

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { MemoryDb } from "./index.js";

function tempDb(): { db: MemoryDb; cleanup: () => void } {
  const path = join(tmpdir(), `pb-donations-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

function rec(
  db: MemoryDb,
  over: Partial<Parameters<MemoryDb["recordDonation"]>[0]> = {},
  opts: Parameters<MemoryDb["recordDonation"]>[1] = {}
) {
  return db.recordDonation(
    {
      tx_sig: "sig" + Math.random().toString(36).slice(2),
      ts: 1000,
      slot: 1,
      donor: "DonorA",
      lamports: 50_000_000,
      is_creator: 0,
      reference: null,
      memo_raw: null,
      memo_clean: null,
      tier: "offering",
      ...over,
    },
    opts
  );
}

test("dust is excluded from the list but counted in stats", () => {
  const { db, cleanup } = tempDb();
  try {
    rec(db, { tx_sig: "dust1", tier: "dust", lamports: 1_000_000, donor: "Dustman" });
    rec(db, { tx_sig: "off1", tier: "offering", lamports: 50_000_000, donor: "DonorA" });
    rec(db, { tx_sig: "grand1", tier: "grand", lamports: 2_000_000_000, donor: "Whale" });

    const list = db.recentOfferings(10);
    assert.deepEqual(list.map((r) => r.tx_sig).sort(), ["grand1", "off1"]);
    assert.ok(!list.some((r) => r.tier === "dust"), "dust excluded from the list");

    const stats = db.offeringStats(2000);
    assert.equal(stats.count, 3, "dust counted in stats");
    assert.equal(stats.donors, 3);
    assert.equal(stats.largest?.tx_sig, "grand1");
    assert.equal(stats.totalLamports, 1_000_000 + 50_000_000 + 2_000_000_000);
  } finally {
    cleanup();
  }
});

test("idempotent by tx_sig; receipt resolves by sig and by ref", () => {
  const { db, cleanup } = tempDb();
  try {
    assert.equal(rec(db, { tx_sig: "s1", reference: "ref-1", donor: "DonorA" }), true);
    assert.equal(rec(db, { tx_sig: "s1", reference: "ref-1", donor: "DonorA" }), false); // duplicate ignored

    assert.equal(db.getDonation("s1")?.tx_sig, "s1");
    assert.equal(db.getDonationByRef("ref-1")?.tx_sig, "s1");
    assert.equal(db.getDonation("nope"), null);
    assert.equal(db.getDonationByRef("nope"), null);
    assert.equal(db.countDonationsByDonor("DonorA"), 1);
  } finally {
    cleanup();
  }
});

test("unannouncedOfferings skips dust and announced rows", () => {
  const { db, cleanup } = tempDb();
  try {
    rec(db, { tx_sig: "d", tier: "dust", lamports: 1_000_000 });
    rec(db, { tx_sig: "a", tier: "offering" });
    rec(db, { tx_sig: "b", tier: "grand", lamports: 2_000_000_000 });
    db.markOfferingAnnounced("a", { tg: true });

    const q = db.unannouncedOfferings(10);
    assert.deepEqual(q.map((r) => r.tx_sig), ["b"]);
  } finally {
    cleanup();
  }
});

test("silent record (backfill) is never queued for a thanks", () => {
  const { db, cleanup } = tempDb();
  try {
    rec(db, { tx_sig: "live", tier: "offering" });
    rec(db, { tx_sig: "back", tier: "grand", lamports: 2_000_000_000 }, { silent: true });
    // Only the live gift is queued; the backfilled one is pre-marked announced.
    assert.deepEqual(db.unannouncedOfferings(10).map((r) => r.tx_sig), ["live"]);
    assert.equal(db.getDonation("back")?.announced_tg, 1);
    assert.equal(db.getDonation("back")?.announced_x, 1);
  } finally {
    cleanup();
  }
});

test("reclassify helpers: list a donor's rows, then delete them", () => {
  const { db, cleanup } = tempDb();
  try {
    rec(db, { tx_sig: "adm1", donor: "ADMIN", is_creator: 1 });
    rec(db, { tx_sig: "adm2", donor: "ADMIN", is_creator: 1 });
    rec(db, { tx_sig: "other", donor: "Stranger" });

    const adminRows = db.listDonationsByDonor("ADMIN");
    assert.deepEqual(adminRows.map((r) => r.tx_sig).sort(), ["adm1", "adm2"]);

    for (const r of adminRows) db.deleteDonation(r.tx_sig);
    assert.equal(db.listDonationsByDonor("ADMIN").length, 0);
    assert.equal(db.getDonation("other")?.tx_sig, "other"); // untouched
  } finally {
    cleanup();
  }
});
