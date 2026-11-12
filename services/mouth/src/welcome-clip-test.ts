// Manual check for the welcome clip: sends ONE clip to the owner's private
// chat (never the group) with the fixed welcome and a sample name as its
// caption, so it can be seen before TG_WELCOME_CLIP_ENABLED is turned on.
// Does not need the flag.
//
// Run: cd services/mouth && node --import tsx src/welcome-clip-test.ts [name]
//      e.g. ... welcome-clip-test.ts "Ana"        -> greeted by name
//           ... welcome-clip-test.ts "Admin"      -> greeted without a name

import { secretWordsFromEnv } from "@pennyboi/shared";
import { Bot } from "grammy";
import { loadMouthConfig } from "./config.js";
import { sendClip } from "./decree-clips.js";
import { log } from "./log.js";
import * as P from "./personality.js";
import { stripDisallowedUrls } from "./sanitize.js";
import { WELCOME_CLIP_KEY, welcomeClipPath, welcomeTextFor } from "./welcome-clip.js";

async function main(): Promise<void> {
  const name = process.argv[2] ?? "Ana";
  const cfg = loadMouthConfig();
  if (!cfg.botToken || !cfg.ownerId) {
    console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID must be set.");
    process.exit(1);
  }
  const caption = stripDisallowedUrls(welcomeTextFor([name], P.WELCOME, secretWordsFromEnv()), cfg.allowedHosts);
  console.log(`caption: ${caption}`);
  const mem = new Map<string, string>();
  const ok = await sendClip(
    {
      api: new Bot(cfg.botToken).api,
      kv: { kvGet: (k) => mem.get(k) || null, kvSet: (k, v) => void mem.set(k, v) },
      log,
      pathFor: () => welcomeClipPath(),
    },
    { chatId: cfg.ownerId },
    WELCOME_CLIP_KEY,
    caption
  );
  console.log(ok ? "sent the welcome clip to the owner's private chat" : "the clip was NOT sent (see the warning above)");
  process.exit(ok ? 0 : 1);
}

void main();
