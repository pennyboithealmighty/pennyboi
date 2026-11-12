// The pinned scripture (docs/06). Nothing posts it automatically: the owner
// runs /scripture_post, which puts SCRIPTURE_PINNED into the scripture topic
// and pins it. Running it again REPLACES the scripture in place (the same
// message is edited and stays pinned), so duplicates never stack up.
//
// Where the scripture topic is: TELEGRAM_TOPIC_SCRIPTURE if set, else the
// thread the bot has been told about (/ids scripture, or running
// /scripture_post inside the topic once).

import { envStr } from "@pennyboi/shared";
import type { Context } from "grammy";
import type { MouthConfig } from "./config.js";
import type { MouthCtx } from "./deps.js";
import * as P from "./personality.js";
import { stripDisallowedUrls } from "./sanitize.js";
import type { Kv } from "./x-mentions.js";

export const KV_SCRIPTURE_THREAD = "scripture_thread_id";
export const KV_SCRIPTURE_MESSAGE = "scripture_message_id";

/** The scripture topic's thread id, or undefined if it is not known yet. */
export function scriptureThreadId(m: { cfg: MouthConfig; db: Kv }): number | undefined {
  if (m.cfg.topics.scripture != null) return m.cfg.topics.scripture;
  const learned = Number(m.db.kvGet(KV_SCRIPTURE_THREAD));
  return learned > 1 ? learned : undefined;
}

/** The scripture as it is posted: links filled in where known, then the usual link filter. */
export function scriptureText(cfg: MouthConfig, programId = envStr("VAULT_PROGRAM_ID")): string {
  const base = cfg.solscanBase.replace(/\/+$/, "");
  const q = cfg.cluster && cfg.cluster !== "mainnet-beta" ? `?cluster=${cfg.cluster}` : "";
  const text = P.SCRIPTURE_PINNED({
    vault: programId ? `${base}/account/${programId}${q}` : undefined,
    repo: cfg.links.github || undefined,
    pump: cfg.links.pumpfun || undefined,
  });
  return stripDisallowedUrls(text, cfg.allowedHosts);
}

/**
 * The scripture carries no link preview. Telegram's preview of the Solscan
 * link ignores ?cluster=devnet and shows a card for mainnet (0 SOL), which is
 * wrong and misleading. The links themselves stay clickable.
 */
export const NO_PREVIEW = { is_disabled: true } as const;

export interface ScriptureApi {
  sendMessage(
    chatId: number,
    text: string,
    other: { message_thread_id?: number; link_preview_options: { is_disabled: boolean } }
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    other: { link_preview_options: { is_disabled: boolean } }
  ): Promise<unknown>;
  pinChatMessage(chatId: number, messageId: number, other?: { disable_notification?: boolean }): Promise<unknown>;
  unpinChatMessage(chatId: number, messageId: number): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
}

export type ScriptureResult =
  | { ok: true; action: "posted" | "replaced"; messageId: number }
  | { ok: false; error: string };

const describe = (e: unknown): string => String((e as { description?: string })?.description ?? (e as Error)?.message ?? e);

/**
 * Post the scripture and pin it, or replace the one already pinned.
 * Replacing edits the existing message, so its pin and position are kept.
 */
export async function postScripture(deps: {
  api: ScriptureApi;
  kv: Kv;
  chatId: number;
  threadId: number;
  text: string;
}): Promise<ScriptureResult> {
  const { api, kv, chatId, threadId, text } = deps;
  const existing = Number(kv.kvGet(KV_SCRIPTURE_MESSAGE)) || 0;

  if (existing > 0) {
    try {
      // Editing with the preview off also removes a card the old post showed.
      await api.editMessageText(chatId, existing, text, { link_preview_options: NO_PREVIEW });
    } catch (e) {
      // Identical text is not an error for us; anything else means the old
      // message is gone or cannot be edited, so a new one is posted below.
      if (!/not modified/i.test(describe(e))) return postNew(existing);
    }
    try {
      await api.pinChatMessage(chatId, existing, { disable_notification: true });
    } catch (e) {
      return { ok: false, error: `replaced the scripture, but could not pin it: ${describe(e)}` };
    }
    return { ok: true, action: "replaced", messageId: existing };
  }
  return postNew(0);

  async function postNew(old: number): Promise<ScriptureResult> {
    let id: number;
    try {
      id = (await api.sendMessage(chatId, text, { message_thread_id: threadId, link_preview_options: NO_PREVIEW }))
        .message_id;
    } catch (e) {
      return { ok: false, error: `could not post in the scripture topic: ${describe(e)}` };
    }
    kv.kvSet(KV_SCRIPTURE_MESSAGE, String(id));
    try {
      await api.pinChatMessage(chatId, id, { disable_notification: true });
    } catch (e) {
      return { ok: false, error: `posted the scripture (message ${id}), but could not pin it: ${describe(e)}` };
    }
    // The one it replaces must not linger as a second pinned scripture.
    if (old > 0) {
      await api.unpinChatMessage(chatId, old).catch(() => {});
      await api.deleteMessage(chatId, old).catch(() => {});
    }
    return { ok: true, action: "posted", messageId: id };
  }
}

/** Owner-only /scripture_post. Never runs by itself. */
export function registerScripture(m: MouthCtx): void {
  m.bot.command("scripture_post", async (c: Context) => {
    if (m.cfg.ownerId === 0 || c.from?.id !== m.cfg.ownerId) return; // silent for everyone else

    // Answer the owner in private, so the scripture topic holds only scripture.
    const inGroup = c.chat?.id === m.cfg.chatId;
    const tell = async (text: string): Promise<void> => {
      if (inGroup) await m.bot.api.sendMessage(m.cfg.ownerId, text).catch(() => {});
      else await c.reply(text).catch(() => {});
    };

    let threadId = scriptureThreadId(m);
    const here = c.message?.message_thread_id;
    if (threadId === undefined && inGroup && here != null && here > 1) {
      // Run inside the topic: remember that this is where scripture lives.
      threadId = here;
      m.db.kvSet(KV_SCRIPTURE_THREAD, String(here));
    }
    if (inGroup) await c.deleteMessage().catch(() => {}); // remove the command itself

    if (threadId === undefined) {
      await tell(
        "I do not know which topic is #scripture yet. Send /scripture_post once INSIDE the scripture topic and I will remember it (or set TELEGRAM_TOPIC_SCRIPTURE and restart me)."
      );
      return;
    }
    if (!m.cfg.chatId) {
      await tell("TELEGRAM_CHAT_ID is not set.");
      return;
    }

    const result = await postScripture({
      api: m.bot.api,
      kv: m.db,
      chatId: m.cfg.chatId,
      threadId,
      text: scriptureText(m.cfg),
    });
    if (result.ok) {
      m.log.info(`scripture: ${result.action} and pinned (message ${result.messageId}, thread ${threadId})`);
      await tell(
        result.action === "posted"
          ? `The scripture is posted and pinned in #scripture (message ${result.messageId}).`
          : `The pinned scripture was replaced in place (message ${result.messageId}). No duplicate was posted.`
      );
    } else {
      m.log.warn(`scripture: ${result.error}`);
      await tell(`Scripture not done: ${result.error}`);
    }
  });
}
