// Manual check for the offering clip: sends ONE clip to the owner's private
// chat (never the group) with a sample batched thank-you as its caption, so it
// can be seen before TG_OFFERING_CLIP_ENABLED is turned on. Does not need the
// flag.
//
// Run: cd services/mouth && node --import tsx src/offering-clip-test.ts

import { Bot } from "grammy";
import { loadMouthConfig } from "./config.js";
import { sendClip } from "./decree-clips.js";
import { log } from "./log.js";
import { OFFERING_CLIP_KEY, offeringClipPath } from "./offering-clip.js";
import { composeOfferingThanks } from "./offering-thanker.js";
import { stripDisallowedUrls } from "./sanitize.js";

async function main(): Promise<void> {
  const cfg = loadMouthConfig();
  if (!cfg.botToken || !cfg.ownerId) {
    console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID must be set.");
    process.exit(1);
  }
  const caption = stripDisallowedUrls(
    composeOfferingThanks("[clip test] BEHOLD. Two mortals tithe, and the Divine Allowance swells.", [
      { display: "THE FAITHFUL", sol: 0.05, solscanUrl: "https://solscan.io/tx/EXAMPLE1?cluster=devnet" },
      { display: "7xKq…9fPa", sol: 0.1, solscanUrl: "https://solscan.io/tx/EXAMPLE2?cluster=devnet" },
    ]),
    cfg.allowedHosts
  );
  const mem = new Map<string, string>();
  const ok = await sendClip(
    {
      api: new Bot(cfg.botToken).api,
      kv: { kvGet: (k) => mem.get(k) || null, kvSet: (k, v) => void mem.set(k, v) },
      log,
      pathFor: () => offeringClipPath(),
    },
    { chatId: cfg.ownerId },
    OFFERING_CLIP_KEY,
    caption
  );
  console.log(ok ? "sent the offering clip to the owner's private chat" : "the clip was NOT sent (see the warning above)");
  process.exit(ok ? 0 : 1);
}

void main();
