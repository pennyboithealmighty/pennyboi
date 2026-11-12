// Manual check for the gate: sends ONE trial (a random grid with buttons 1-4
// and the trial text) to the owner's private chat only, so the image and the
// wording can be seen. The owner is never tested for real, so this is the only
// way to see it without a second account. Works with TG_GATE_ENABLED off.
// The buttons are for show: pressing one answers "This trial has ended."
// (or nothing at all while the gate is off).
//
// Run: cd services/mouth && node --import tsx src/gate-preview.ts

import { resolveFromRoot } from "@pennyboi/shared";
import { Bot, InputFile } from "grammy";
import { join } from "node:path";
import { loadMouthConfig } from "./config.js";
import { GATE_TEXT, GRID_DIR, gateKeyboard, loadGrids } from "./gate.js";

async function main(): Promise<void> {
  const cfg = loadMouthConfig();
  if (!cfg.botToken || !cfg.ownerId) {
    console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID must be set.");
    process.exit(1);
  }
  const grids = loadGrids();
  if (grids.length === 0) {
    console.error(`no trial images in ${GRID_DIR} — run: swift scripts/make-gate-grids.swift`);
    process.exit(1);
  }
  const grid = grids[Math.floor(Math.random() * grids.length)]!;
  await new Bot(cfg.botToken).api.sendPhoto(cfg.ownerId, new InputFile(resolveFromRoot(join(GRID_DIR, grid.file))), {
    caption: GATE_TEXT.trial,
    reply_markup: gateKeyboard("0000000000000000"),
  });
  console.log(`sent ${grid.file} to the owner's private chat (the true coin is in cell ${grid.answer})`);
}

main().catch((e) => {
  console.error("preview failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
