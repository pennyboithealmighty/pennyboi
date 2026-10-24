// @pennyboi/mouth — entrypoint.
// Boots the grammY Telegram bot (announcements, reactions, offerings, auto-mod,
// holder + owner commands, hidden /ids, daily sermon) and a small HTTP server
// for Hands -> Mouth narration (docs/06, docs/07).

import { MemoryDb } from "@pennyboi/shared";
import { Bot } from "grammy";
import { ChainReader } from "./chain.js";
import { registerCommands } from "./commands.js";
import { loadMouthConfig } from "./config.js";
import { startDailySchedule } from "./daily.js";
import type { MouthCtx } from "./deps.js";
import { log } from "./log.js";
import { registerModeration } from "./moderation.js";
import { createNarrateServer } from "./narrate-server.js";
import { ProphecyScheduler } from "./prophecy-scheduler.js";
import { ReplyRateLimiter } from "./ratelimit.js";
import { XPoster } from "./xposter.js";

async function main(): Promise<void> {
  const cfg = loadMouthConfig();
  if (!cfg.botToken) {
    log.error("TELEGRAM_BOT_TOKEN not set — cannot start the bot.");
    process.exit(1);
  }
  if (!cfg.ownerId) log.warn("TELEGRAM_OWNER_ID not set — owner commands are disabled.");
  if (!cfg.chatId) log.warn("TELEGRAM_CHAT_ID not set — moderation/announcements limited until set.");
  if (!cfg.topics.general) log.warn("Topic IDs not set — run the hidden /ids command in each topic, then fill .env.");

  const db = new MemoryDb(cfg.dbPath);
  const bot = new Bot(cfg.botToken);
  const rate = new ReplyRateLimiter(cfg.replyRateSecs);

  // Restore quiet mode if it was set before a restart.
  const quiet = db.kvGet("quiet_until");
  if (quiet) rate.setQuietUntil(Number(quiet));

  const m: MouthCtx = {
    cfg,
    db,
    bot,
    x: new XPoster(cfg, log),
    chain: new ChainReader(),
    rate,
    log,
    prophecy: undefined as unknown as ProphecyScheduler, // set just below
  };
  m.prophecy = new ProphecyScheduler(m);

  bot.catch((err) => log.error("bot error", err.error));
  registerCommands(m);
  registerModeration(m);
  m.prophecy.start(); // no-op when X_MODE=off

  // HTTP endpoint for Hands narration + health.
  createNarrateServer(m).listen(cfg.httpPort, () => {
    log.info(`mouth HTTP on :${cfg.httpPort} (POST /narrate, GET /health)`);
  });

  startDailySchedule(m);

  // Long-poll Telegram. message_reaction must be in allowed_updates to arrive.
  await bot.start({
    allowed_updates: ["message", "message_reaction", "chat_member"],
    onStart: (info) => log.info(`bot @${info.username} started`),
  });
}

main().catch((e) => {
  log.error("fatal", e);
  process.exit(1);
});
