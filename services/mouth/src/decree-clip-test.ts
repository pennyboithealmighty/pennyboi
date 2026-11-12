// Manual check for decree clips: sends ONE clip to the owner's private chat
// (never the group), so the clip, the caption and the upload can be seen
// before TG_DECREE_CLIPS_ENABLED is turned on. Does not need the flag.
//
// Run: cd services/mouth && node --import tsx src/decree-clip-test.ts [burn|airdrop|bounty]

import { Bot } from "grammy";
import { loadMouthConfig } from "./config.js";
import { DECREE_CLIPS, sendClip } from "./decree-clips.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  const action = process.argv[2] ?? "burn";
  if (!DECREE_CLIPS[action]) {
    console.error(`unknown action "${action}" — use one of: ${Object.keys(DECREE_CLIPS).join(", ")}`);
    process.exit(1);
  }
  const cfg = loadMouthConfig();
  if (!cfg.botToken || !cfg.ownerId) {
    console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID must be set.");
    process.exit(1);
  }
  const mem = new Map<string, string>();
  const ok = await sendClip(
    { api: new Bot(cfg.botToken).api, kv: { kvGet: (k) => mem.get(k) || null, kvSet: (k, v) => void mem.set(k, v) }, log },
    { chatId: cfg.ownerId },
    action,
    `[clip test · ${action}] BEHOLD. This is how a decree will look.\n\nhttps://solscan.io/tx/EXAMPLE?cluster=devnet`
  );
  console.log(ok ? `sent the ${action} clip to the owner's private chat` : "the clip was NOT sent (see the warning above)");
  process.exit(ok ? 0 : 1);
}

void main();
