// One-off migration (docs/12 fix). The mock fee feed used to drip from the ADMIN
// wallet, so its deposits were recorded as "Creator tithe" offerings. Now that
// the feed has its own wallet, reclassify those historical admin-sourced rows as
// fees — i.e. remove them from the `donations` (offerings) table, where fees
// don't belong. Prints every row it changes.
//
// Run:  pnpm --filter @pennyboi/scripts reclassify-offerings [-- --dry-run]
// Env:  RECLASSIFY_DONOR (defaults to the admin wallet's pubkey).

import { envStr, MemoryDb } from "@pennyboi/shared";
import { loadOrCreateKeypair, log } from "./lib.js";

function main(): void {
  const db = new MemoryDb(envStr("DATABASE_PATH", "./db/pennyboi.db"));
  const override = envStr("RECLASSIFY_DONOR");
  let donor = override;
  if (!donor) {
    const admin = loadOrCreateKeypair("admin");
    if (admin.created) {
      log("WARNING: keys/admin.json did not exist and was just generated — its pubkey");
      log("won't match historical rows. Pass RECLASSIFY_DONOR=<old admin pubkey> instead.");
    }
    donor = admin.keypair.publicKey.toBase58();
  }
  const dryRun = process.argv.includes("--dry-run");

  const rows = db.listDonationsByDonor(donor);
  log(`reclassify: ${rows.length} donation row(s) from ${donor} -> fee${dryRun ? " (dry run)" : ""}`);
  let total = 0;
  for (const r of rows) {
    total += r.lamports;
    log(`  ${r.tx_sig}  ${(r.lamports / 1e9).toFixed(4)} SOL  tier=${r.tier}  creator=${r.is_creator}  ts=${r.ts}`);
    if (!dryRun) db.deleteDonation(r.tx_sig);
  }
  log(
    dryRun
      ? `DRY RUN — nothing deleted (${rows.length} rows, ${(total / 1e9).toFixed(4)} SOL would be reclassified)`
      : `removed ${rows.length} row(s), ${(total / 1e9).toFixed(4)} SOL reclassified as fee`
  );
}

main();
