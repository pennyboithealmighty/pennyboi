// Holder + owner commands (docs/06 §4, §5) plus the hidden owner-only /ids.

import { envStr, pickMood } from "@pennyboi/shared";
import type { Context } from "grammy";
import { sendSafe } from "./announce.js";
import type { MouthCtx } from "./deps.js";
import { solscanTx } from "./links.js";
import * as P from "./personality.js";

function isOwner(c: Context, m: MouthCtx): boolean {
  return c.from?.id === m.cfg.ownerId && m.cfg.ownerId !== 0;
}
function ownerPrivate(c: Context, m: MouthCtx): boolean {
  return isOwner(c, m) && c.chat?.type === "private";
}

async function handsPost(path: string): Promise<Response> {
  const base = new URL(envStr("HANDS_URL", "http://127.0.0.1:8789/execute"));
  return fetch(`${base.origin}${path}`, { method: "POST" });
}

/** Text after the command word, trimmed. */
function argText(c: Context): string {
  const t = c.message?.text ?? "";
  const i = t.indexOf(" ");
  return i === -1 ? "" : t.slice(i + 1).trim();
}

export function registerCommands(m: MouthCtx): void {
  const { bot } = m;

  // ---- Holder commands ---------------------------------------------------

  bot.command("treasury", async (c) => {
    const s = await m.chain.treasuryStatus().catch(() => null);
    if (!s) return c.reply("My treasury is not yet of this realm (program not deployed). Patience.");
    return c.reply(P.treasuryStatus(s));
  });

  bot.command("lore", (c) => c.reply(P.LORE));

  bot.command("mood", (c) => c.reply(P.moodLine(pickMood())));

  bot.command("grudges", (c) => {
    const rows = m.db.listGrudges(10);
    if (!rows.length) return c.reply("I hold no grudges. Yet. Give it time, my pennies.");
    return c.reply(
      "THOSE WHO HAVE WRONGED ME:\n" +
        rows.map((r) => `• ${r.nickname ?? r.wallet} — ${r.reason}`).join("\n")
    );
  });

  bot.command("loyal", (c) => {
    const rows = m.db.listLoyal(10);
    if (!rows.length) return c.reply("None have proven loyal enough to name. Disappointing.");
    return c.reply(
      "MY BLESSED:\n" + rows.map((r) => `• ${r.nickname ?? r.wallet} — ${r.reason}`).join("\n")
    );
  });

  bot.command("last", (c) => {
    const rows = m.db.lastActions(3);
    if (!rows.length) return c.reply("I have done nothing yet. The void is patient. So am I.");
    const lines = rows.map((r) => {
      const link = r.tx_sig ? ` ${solscanTx(m.cfg, r.tx_sig)}` : "";
      return `• ${r.action}: ${(r.narration ?? "").slice(0, 80)}${link}`;
    });
    return c.reply("MY RECENT DEEDS:\n" + lines.join("\n"));
  });

  bot.command("offer", async (c) => {
    const text = argText(c);
    if (!text) return c.reply("An empty offering? Bold. Try: /offer <your stunt> (200 chars).");
    if (text.length > 200) return c.reply("Your offering rambles. 200 characters, mortal.");
    // Must be in the #offerings topic when that topic is configured.
    const thread = c.message?.message_thread_id;
    if (m.cfg.topics.offerings && thread !== m.cfg.topics.offerings) {
      return c.reply("Offerings belong in #offerings. Take it there.");
    }
    // Learn the Offerings topic thread so SOL-offering thanks land here too,
    // even when TELEGRAM_TOPIC_OFFERINGS isn't configured (docs/12 fix).
    if (thread != null) m.db.kvSet("offerings_thread_id", String(thread));
    const status = await m.chain.treasuryStatus().catch(() => null);
    const step = status?.step ?? 0;
    const handle = c.from?.username ? `@${c.from.username}` : `tg:${c.from?.id}`;
    const ok = m.db.addOffering({
      tgUserId: c.from!.id,
      wallet: handle,
      text,
      step,
      now: Math.floor(Date.now() / 1000),
      messageId: c.message?.message_id,
    });
    return c.reply(
      ok
        ? "Your offering is noted. Thumbs-up from others raise its standing. I will consider it. Probably not."
        : "You have already made an offering this threshold. One per threshold. I am tiny; so is my attention."
    );
  });

  // ---- Owner commands (private chat; owner ID whitelisted) ---------------

  bot.command("start", (c) => {
    if (ownerPrivate(c, m)) return c.reply("I hear you, operator. /status, /pause, /resume, /say, /quiet, /mod, /ids.");
  });

  bot.command("pause", async (c) => {
    if (!ownerPrivate(c, m)) return;
    try {
      await handsPost("/pause");
      return c.reply("Very well. I am meditating. Nothing shall move on-chain until you say otherwise.");
    } catch {
      return c.reply("I could not reach my hands. The kill switch may need the VPS cut manually.");
    }
  });

  bot.command("resume", async (c) => {
    if (!ownerPrivate(c, m)) return;
    try {
      await handsPost("/resume");
      return c.reply("I awaken. The allowance flows again.");
    } catch {
      return c.reply("Could not reach my hands to resume.");
    }
  });

  bot.command("quiet", async (c) => {
    if (!ownerPrivate(c, m)) return;
    const n = Number(argText(c));
    if (!Number.isFinite(n) || n <= 0) return c.reply("Usage: /quiet <hours>");
    const until = Date.now() + n * 3600 * 1000;
    m.rate.setQuietUntil(until);
    m.db.kvSet("quiet_until", String(until));
    return c.reply(`I shall speak less for ${n}h. A rare mercy.`);
  });

  bot.command("say", async (c) => {
    if (!ownerPrivate(c, m)) return;
    const text = argText(c);
    if (!text) return c.reply("Usage: /say <message>");
    await sendSafe(m, text, { threadId: m.cfg.topics.general });
    return c.reply("Spoken.");
  });

  bot.command("mod", async (c) => {
    if (!ownerPrivate(c, m) && !(isOwner(c, m))) return;
    const target = c.message?.reply_to_message?.from?.id ?? Number(argText(c));
    if (!Number.isFinite(target) || !target) {
      return c.reply("Reply to the user's message with /mod, or /mod <user_id>.");
    }
    m.db.addMod(target, Math.floor(Date.now() / 1000));
    try {
      await m.bot.api.promoteChatMember(m.cfg.chatId, target, {
        can_delete_messages: true,
        can_restrict_members: true,
      });
    } catch (e) {
      m.log.warn("promoteChatMember failed (grant stored in DB anyway)", e);
    }
    return c.reply(`Mortal ${target} is now a moderator. Delete and mute only. No divine powers.`);
  });

  bot.command("unmod", async (c) => {
    if (!ownerPrivate(c, m) && !isOwner(c, m)) return;
    const target = c.message?.reply_to_message?.from?.id ?? Number(argText(c));
    if (!Number.isFinite(target) || !target) return c.reply("Reply with /unmod, or /unmod <user_id>.");
    m.db.removeMod(target);
    try {
      await m.bot.api.promoteChatMember(m.cfg.chatId, target, {
        can_delete_messages: false,
        can_restrict_members: false,
      });
    } catch {
      /* best effort */
    }
    return c.reply(`Moderator ${target} is relieved of duty.`);
  });

  bot.command("status", async (c) => {
    if (!ownerPrivate(c, m)) return;
    const now = Math.floor(Date.now() / 1000);
    const s = await m.chain.treasuryStatus().catch(() => null);
    const lines = [
      "OPERATOR DIGEST",
      s
        ? `treasury: ${s.balanceSol.toFixed(4)} SOL, step ${s.step}, off-cooldown: ${s.available.join(", ") || "none"}`
        : "treasury: (program not deployed)",
      `muted: ${m.db.mutedCount(now)}  banned: ${m.db.bannedCount()}`,
      `recent actions: ${m.db.lastActions(3).map((a) => a.action).join(", ") || "none"}`,
      `recent mod events: ${m.db.recentLog(3).map((l) => l.action).join(", ") || "none"}`,
    ];
    return c.reply(lines.join("\n"));
  });

  // ---- Hidden: owner-only /ids (prints chat_id + this topic's thread id) --

  bot.command("ids", async (c) => {
    if (!isOwner(c, m)) return; // silent for everyone else
    const thread = c.message?.message_thread_id;
    return c.reply(
      [
        `chat_id: ${c.chat.id}`,
        `this topic's thread id: ${thread ?? "(none — this is General/root)"}`,
        "",
        "Run /ids inside #general, #offerings and #scripture to collect each id, then fill .env:",
        "TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_GENERAL, TELEGRAM_TOPIC_OFFERINGS, TELEGRAM_TOPIC_SCRIPTURE",
      ].join("\n")
    );
  });

  // ---- X pre-launch "Prophecy" owner controls (docs/09 §5) ---------------

  bot.command("xstatus", async (c) => {
    if (!ownerPrivate(c, m)) return;
    const s = m.prophecy.status();
    const recent = m.db.recentXPosts(3);
    const rej = m.db.lastXRejection();
    const lines = [
      `X mode: ${s.mode}${s.paused ? "  (PAUSED)" : ""}`,
      `posts today: ${s.postsToday}   next slot: ${s.nextSlotIso ?? "none scheduled"}`,
      "recent:",
      ...recent.map((r) => `  [${r.status}] ${r.x_post_id ? r.x_post_id + " " : ""}${r.text.slice(0, 80)}`),
      rej ? `last rejection: ${rej.rejection_reason} — ${rej.text.slice(0, 80)}` : "last rejection: none",
    ];
    return c.reply(lines.join("\n"));
  });

  bot.command("xpost", async (c) => {
    if (!ownerPrivate(c, m)) return;
    const text = argText(c);
    if (!text) return c.reply("Usage: /xpost <text>");
    const r = await m.prophecy.postExact(text);
    return c.reply(
      r.status === "posted"
        ? `posted to X (${r.xPostId})`
        : `not posted: ${r.status}${r.reason ? " — " + r.reason : ""}`
    );
  });

  bot.command("xpause", async (c) => {
    if (!ownerPrivate(c, m)) return;
    m.prophecy.pause();
    return c.reply("Prophecy schedule paused. (mode unchanged)");
  });

  bot.command("xresume", async (c) => {
    if (!ownerPrivate(c, m)) return;
    m.prophecy.resume();
    return c.reply("Prophecy schedule resumed.");
  });

  bot.command("xdryrun", async (c) => {
    if (!ownerPrivate(c, m)) return;
    const r = await m.prophecy.produceAndPost(true);
    return c.reply(
      r.status === "dryrun"
        ? `[dry run · ${r.theme}] would post:\n\n${r.text}`
        : `dry run produced nothing: ${r.status}${r.reason ? " — " + r.reason : ""}`
    );
  });
}
