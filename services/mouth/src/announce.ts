// Outbound messaging. Every message Pennyboi sends goes through sendSafe, which
// strips any link that isn't on the allowlist (docs/06 §8).
//
// Public-post discipline: only a DECREE — an on-chain act that actually
// executed — is announced, immediately, in #general (and on X when live). A
// "none" decision, or a failed/paused/invalid attempt, is logged and shows up in
// the owner digest only. Decrees are clamped to the channel limit and the
// catchphrases are throttled; the Solscan link is appended after clamping.

import { LIMITS, shapeDry } from "@pennyboi/shared";
import type { MouthCtx } from "./deps.js";
import { shapeForPublic } from "./public-post.js";
import { stripDisallowedUrls } from "./sanitize.js";

/** Send to a topic (or the group root), with the outbound URL filter applied. */
export async function sendSafe(
  ctx: MouthCtx,
  text: string,
  opts: { threadId?: number } = {}
): Promise<void> {
  const safe = stripDisallowedUrls(text, ctx.cfg.allowedHosts);
  if (!ctx.cfg.chatId) {
    ctx.log.warn("TELEGRAM_CHAT_ID not set — cannot send");
    return;
  }
  try {
    await ctx.bot.api.sendMessage(ctx.cfg.chatId, safe, {
      message_thread_id: opts.threadId,
    });
  } catch (e) {
    ctx.log.error("sendMessage failed", e);
  }
}

export interface AnnounceInput {
  narration: string;
  action: string;
  status: string;
  signature?: string;
  solscanUrl?: string;
}

/** Only on-chain acts that actually executed are announced publicly. */
export function isExecutedDecree(action: string, status: string): boolean {
  return status === "submitted" && action !== "none";
}

/** Announce an executed decree in #general + on X (live only). Silent otherwise. */
export async function announce(ctx: MouthCtx, a: AnnounceInput): Promise<void> {
  if (!isExecutedDecree(a.action, a.status)) return;

  // Shape once (clamp + catchphrase throttle, counter advanced once per decree);
  // X reuses the shaped text at its own limit. Links are not counted.
  const tg = shapeForPublic(ctx.db, a.narration.trim() || "...", LIMITS.telegramDecree);
  await sendSafe(ctx, a.solscanUrl ? `${tg}\n\n${a.solscanUrl}` : tg, {
    threadId: ctx.cfg.topics.general,
  });

  // Mirror to X only in live mode. In prelaunch/off, nothing on-chain/devnet
  // ever reaches X (docs/09 §1).
  if (ctx.cfg.x.mode === "live") {
    const x = shapeDry(tg, LIMITS.x);
    await ctx.x.post(a.solscanUrl ? `${x}\n${a.solscanUrl}` : x);
  }
}
