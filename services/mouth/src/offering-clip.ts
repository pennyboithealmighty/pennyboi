// Offering clip (TG_OFFERING_CLIP_ENABLED). An offering thank-you in the
// offerings topic is sent as assets/telegram/pennyboi-offering.mp4 with the
// thank-you text as its caption. One clip per batched thank-you, however many
// donors it names. Reuses the decree-clip send: same link filter, the same
// Telegram file-id cache, and the same fallback — if the clip is off, missing,
// too long for a caption, or refused, the caller sends the text as before.

import { envBool, resolveFromRoot } from "@pennyboi/shared";
import { existsSync } from "node:fs";
import { sendClip } from "./decree-clips.js";
import type { MouthCtx } from "./deps.js";
import { stripDisallowedUrls } from "./sanitize.js";

export const OFFERING_CLIP_FILE = "assets/telegram/pennyboi-offering.mp4";
/** Key under which Telegram's file id for the clip is cached (tg_clip_file_id:offering). */
export const OFFERING_CLIP_KEY = "offering";

export function offeringClipEnabled(): boolean {
  return envBool("TG_OFFERING_CLIP_ENABLED", false);
}

/** Absolute path of the offering clip, or null if it is not on disk. */
export function offeringClipPath(): string | null {
  const path = resolveFromRoot(OFFERING_CLIP_FILE);
  return existsSync(path) ? path : null;
}

/**
 * Send one batched thank-you as the offering clip with `text` as its caption.
 * False means "send the text message instead".
 */
export async function sendOfferingClip(m: MouthCtx, text: string, threadId: number | undefined): Promise<boolean> {
  if (!offeringClipEnabled()) return false;
  if (!m.cfg.chatId) return false;
  const ok = await sendClip(
    { api: m.bot.api, kv: m.db, log: m.log, pathFor: () => offeringClipPath() },
    { chatId: m.cfg.chatId, threadId },
    OFFERING_CLIP_KEY,
    stripDisallowedUrls(text, m.cfg.allowedHosts) // the same link filter as sendSafe
  );
  if (ok) m.log.info("offering clip: sent with the thank-you");
  return ok;
}
