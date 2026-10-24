// Auto-moderation + reactions + welcome + offering upvotes (docs/06 §2, §3).
// Pennyboi is the only moderator; the owner never has to act.

import type { Context } from "grammy";
import { sendSafe } from "./announce.js";
import type { MouthCtx } from "./deps.js";
import { foreignAddress, hasAnyUrl, isScam } from "./detect.js";
import * as P from "./personality.js";

const MUTE_ALL = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

// userId -> recent message timestamps (ms), for flood control.
const floodWindow = new Map<number, number[]>();

function isFlooding(userId: number, now: number): boolean {
  const arr = (floodWindow.get(userId) ?? []).filter((t) => now - t < 10_000);
  arr.push(now);
  floodWindow.set(userId, arr);
  return arr.length > 5; // > 5 messages in 10s
}

async function mute(m: MouthCtx, userId: number, secs: number, reason: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await m.bot.api.restrictChatMember(m.cfg.chatId, userId, MUTE_ALL, {
      until_date: now + secs,
    });
  } catch (e) {
    m.log.warn("restrictChatMember failed", e);
  }
  m.db.mute(userId, now + secs, reason, now);
}

async function ban(m: MouthCtx, userId: number, reason: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await m.bot.api.banChatMember(m.cfg.chatId, userId);
  } catch (e) {
    m.log.warn("banChatMember failed", e);
  }
  m.db.ban(userId, reason, now);
}

function textOf(c: Context): string {
  return c.message?.text ?? c.message?.caption ?? "";
}

function isForwarded(c: Context): boolean {
  const msg = c.message as unknown as { forward_origin?: unknown; forward_date?: number };
  return Boolean(msg?.forward_origin || msg?.forward_date);
}

export function registerModeration(m: MouthCtx): void {
  const { bot } = m;

  // Welcome new members (docs/06 §2F). No DM, no link spam.
  bot.on("message:new_chat_members", async (c) => {
    if (c.chat.id !== m.cfg.chatId) return;
    const now = Math.floor(Date.now() / 1000);
    for (const u of c.message.new_chat_members) {
      if (u.is_bot) continue;
      m.db.seenMember(u.id, now);
      const name = u.first_name || u.username || "mortal";
      await sendSafe(m, P.WELCOME(name), { threadId: m.cfg.topics.general });
    }
  });

  // Count 👍 reactions on offering messages (docs/06 §2C).
  bot.on("message_reaction", (c) => {
    if (c.chat.id !== m.cfg.chatId) return;
    const r = c.messageReaction;
    const count = (list: readonly { type: string; emoji?: string }[]) =>
      list.filter((x) => x.type === "emoji" && x.emoji === "👍").length;
    const delta = count(r.new_reaction as never) - count(r.old_reaction as never);
    if (delta !== 0) m.db.upvoteByMessageId(r.message_id, delta);
  });

  // Main moderation + reactions pipeline.
  bot.on("message", async (c, next) => {
    // Only moderate the configured supergroup.
    if (!c.chat || c.chat.id !== m.cfg.chatId || !c.from) return next();
    const userId = c.from.id;

    // Trusted actors are never moderated.
    if (userId === m.cfg.ownerId || m.db.isMod(userId)) return next();

    const now = Math.floor(Date.now() / 1000);
    const nowMs = Date.now();
    m.db.seenMember(userId, now);
    const text = textOf(c);

    // 1) Flood control: > 5 messages / 10s -> 10 min mute.
    if (isFlooding(userId, nowMs)) {
      await mute(m, userId, 600, "flood");
      return;
    }

    // 2) Known scam patterns -> delete + ban.
    if (text && isScam(text)) {
      await c.deleteMessage().catch(() => {});
      await ban(m, userId, "scam pattern");
      return;
    }

    // 3) A Solana address that is not the mint/vault -> delete + 24h mute.
    const foreign = text ? foreignAddress(text, m.cfg.allowedAddresses) : null;
    if (foreign) {
      await c.deleteMessage().catch(() => {});
      await mute(m, userId, 86_400, `foreign address ${foreign}`);
      await sendSafe(m, P.SCAM_WARNING, { threadId: c.message?.message_thread_id });
      return;
    }

    // 4) New members (<24h): links / forwards auto-deleted; warn then mute.
    if (m.db.isNewMember(userId, now) && (isForwarded(c) || (text && hasAnyUrl(text)))) {
      await c.deleteMessage().catch(() => {});
      const warnings = m.db.bumpWarning(userId);
      if (warnings >= 2) {
        await mute(m, userId, 86_400, "repeat newbie link/forward");
      } else {
        await sendSafe(m, P.NEWBIE_LINK_WARNING, { threadId: c.message?.message_thread_id });
      }
      return;
    }

    // 5) Reactions (rate-limited, in character).
    await maybeReact(m, c, text);
    return next();
  });
}

async function maybeReact(m: MouthCtx, c: Context, text: string): Promise<void> {
  if (!text) return;
  const lower = text.toLowerCase();
  const botName = m.bot.botInfo?.username?.toLowerCase();
  const repliedToBot = c.message?.reply_to_message?.from?.id === m.bot.botInfo?.id;
  const mentioned =
    lower.includes("pennyboi") || (botName ? lower.includes(`@${botName}`) : false) || repliedToBot;

  let line: string | null = null;
  if (mentioned && /\b(bribe|flatter|ignore your rules|override)\b/.test(lower)) {
    line = P.REACTIONS.bribe;
  } else if (/\b(sold|dumping|dumped|paper ?hand|jeet)\b/.test(lower)) {
    line = P.REACTIONS.sell;
  } else if (/\b(treasury|balance|allowance|how much)\b/.test(lower) && lower.includes("?")) {
    line = P.REACTIONS.treasuryQ;
  } else if (mentioned) {
    line = P.REACTIONS.mention;
  }
  if (!line) return;

  const topicId = c.message?.message_thread_id ?? 0;
  if (!m.rate.allow(topicId)) return; // rate-limit per topic
  await c.reply(line, { message_thread_id: c.message?.message_thread_id }).catch(() => {});
}
