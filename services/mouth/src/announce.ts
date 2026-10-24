// Outbound messaging. Every message Pennyboi sends goes through sendSafe, which
// strips any link that isn't on the allowlist (docs/06 §8). Threshold/action
// announcements land in #general and mirror to X.

import type { MouthCtx } from "./deps.js";
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

/** Announce a completed (or skipped/failed) action in #general + on X. */
export async function announce(ctx: MouthCtx, a: AnnounceInput): Promise<void> {
  let text = a.narration?.trim() || "...";
  if (a.solscanUrl) text += `\n\n${a.solscanUrl}`;

  await sendSafe(ctx, text, { threadId: ctx.cfg.topics.general });

  // Mirror to X (narration + link). sendSafe's filter is Telegram-only; Solscan
  // is on the allowlist and X links are fine, so post the same text.
  await ctx.x.post(a.solscanUrl ? `${a.narration}\n${a.solscanUrl}` : a.narration);
}
