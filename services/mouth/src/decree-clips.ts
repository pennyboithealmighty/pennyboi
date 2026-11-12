// Decree video clips (TG_DECREE_CLIPS_ENABLED). When a decree is announced in
// #general, the matching short MP4 from assets/telegram/ is sent with the
// narration as its caption. Any failure returns false, and the caller sends
// the plain text announcement exactly as before.
//
// The first send uploads the file; Telegram's file_id is then cached in kv so
// later decrees reuse it instead of uploading again.

import { envBool, resolveFromRoot } from "@pennyboi/shared";
import { InputFile } from "grammy";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MouthCtx } from "./deps.js";
import type { Logger } from "./log.js";
import { stripDisallowedUrls } from "./sanitize.js";
import type { Kv } from "./x-mentions.js";

const CLIP_DIR = "assets/telegram";
/** Telegram's limit for a media caption. */
export const CAPTION_MAX = 1024;

/** One clip per decree. The offering/threshold/sermon clips are not decrees. */
export const DECREE_CLIPS: Record<string, string> = {
  burn: "pennyboi-burn.mp4",
  airdrop: "pennyboi-airdrop.mp4",
  bounty: "pennyboi-bounty.mp4",
};

export function decreeClipsEnabled(): boolean {
  return envBool("TG_DECREE_CLIPS_ENABLED", false);
}

/** Absolute path of the clip for this action, or null if there is none on disk. */
export function clipPathFor(action: string): string | null {
  const file = DECREE_CLIPS[action];
  if (!file) return null;
  const path = resolveFromRoot(join(CLIP_DIR, file));
  return existsSync(path) ? path : null;
}

type SentVideo = { video?: { file_id: string }; animation?: { file_id: string } };

export interface ClipDeps {
  api: {
    sendVideo(
      chatId: number,
      video: InputFile | string,
      other?: { caption?: string; message_thread_id?: number }
    ): Promise<SentVideo>;
  };
  kv: Kv;
  log: Logger;
  /** Injectable for tests. */
  pathFor?: (action: string) => string | null;
}

const fileIdKey = (action: string): string => `tg_clip_file_id:${action}`;

/**
 * Send the clip for `action` with `caption`. True only if Telegram accepted
 * it; false means "send the text announcement instead".
 */
export async function sendClip(
  deps: ClipDeps,
  target: { chatId: number; threadId?: number },
  action: string,
  caption: string
): Promise<boolean> {
  const path = (deps.pathFor ?? clipPathFor)(action);
  if (!path) {
    deps.log.warn(`decree clip: no clip on disk for "${action}" — sending text`);
    return false;
  }
  if (caption.length > CAPTION_MAX) {
    deps.log.warn(`decree clip: caption is ${caption.length} chars (max ${CAPTION_MAX}) — sending text`);
    return false;
  }
  const other = { caption, message_thread_id: target.threadId };
  const remember = (m: SentVideo): void => {
    const id = m.video?.file_id ?? m.animation?.file_id;
    if (id) deps.kv.kvSet(fileIdKey(action), id);
  };

  // Reuse Telegram's copy when we have one; a stale id falls through to upload.
  const cached = deps.kv.kvGet(fileIdKey(action));
  if (cached) {
    try {
      remember(await deps.api.sendVideo(target.chatId, cached, other));
      return true;
    } catch (e) {
      deps.log.warn(`decree clip: cached file id for "${action}" was refused — uploading again`, e);
      deps.kv.kvSet(fileIdKey(action), "");
    }
  }
  try {
    remember(await deps.api.sendVideo(target.chatId, new InputFile(path), other));
    return true;
  } catch (e) {
    deps.log.warn(`decree clip: sending "${action}" failed — sending text`, e);
    return false;
  }
}

/** The decree-announcement hook: clip + caption in #general, behind the flag. */
export async function sendDecreeClip(ctx: MouthCtx, action: string, text: string): Promise<boolean> {
  if (!decreeClipsEnabled()) return false;
  if (!ctx.cfg.chatId) return false;
  // Same outbound link filter as every other message he sends.
  const caption = stripDisallowedUrls(text, ctx.cfg.allowedHosts);
  const ok = await sendClip(
    { api: ctx.bot.api, kv: ctx.db, log: ctx.log },
    { chatId: ctx.cfg.chatId, threadId: ctx.cfg.topics.general },
    action,
    caption
  );
  if (ok) ctx.log.info(`decree clip: sent "${action}" with the announcement`);
  return ok;
}
