// Shared handler context, assembled in index.ts and passed to the bot wiring.
import type { MemoryDb } from "@pennyboi/shared";
import type { Bot } from "grammy";
import type { ChainReader } from "./chain.js";
import type { MouthConfig } from "./config.js";
import type { Logger } from "./log.js";
import type { ReplyRateLimiter } from "./ratelimit.js";
import type { XPoster } from "./xposter.js";

export interface MouthCtx {
  cfg: MouthConfig;
  db: MemoryDb;
  bot: Bot;
  x: XPoster;
  chain: ChainReader;
  rate: ReplyRateLimiter;
  log: Logger;
}
