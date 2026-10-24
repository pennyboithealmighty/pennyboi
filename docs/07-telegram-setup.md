# Pennyboi — Telegram Manual Setup Checklist

October 23, 2026 — the only Telegram work a human has to do (~5-10 min). Everything else is code.

## Who Does What

- You (once, in the Telegram app): create the bot, create the group, flip a few settings, copy the values into `.env`.
- Claude Code: all bot behavior (commands, moderation, announcements, digest, offerings).

## Step 1 — Create the Bot

1. In Telegram, search for `@BotFather` (blue checkmark) and open it.
2. Send: `/newbot`
3. Name: `Pennyboi the Almighty`
4. Username: something ending in "bot", e.g. `PennyboiAlmightyBot`
5. BotFather replies with an HTTP API token. Copy it -> `.env` as `TELEGRAM_BOT_TOKEN=`
   (Never paste this token anywhere public. If leaked, `/revoke` in BotFather.)
6. Still in BotFather, send `/setprivacy` -> pick your bot -> Disable
   (lets the bot read all group messages so it can moderate and react)
7. Optional: `/setuserpic` to upload Pennyboi's avatar; `/setdescription` for the "what can this bot do" text.

## Step 2 — Create the Group

1. New Group -> name: `Pennyboi the Almighty` -> add the bot as first member.
2. Open group settings -> Edit -> Group Type -> Public -> set link, e.g. `t.me/pennyboialmighty`
3. Group settings -> Topics -> ON (this converts it to a forum-style supergroup).
4. Create topics: `general` (default), `offerings`, `scripture`
5. Make `scripture` read-only for members: topic -> Edit -> restrict "Send Messages" to admins only.
6. Group settings -> Administrators -> add the bot -> enable: Delete Messages, Ban/Restrict Users, Pin Messages, Manage Topics.
7. Group settings -> Permissions (members): turn OFF "Add Users" if you want to slow raids; leave Send Messages/Media ON.

## Step 3 — Grab the IDs

1. Your own user ID: message `@userinfobot` -> it replies with your numeric ID -> `.env` `TELEGRAM_OWNER_ID=`
2. Group chat ID + topic IDs: once the bot is running, Claude Code will add a hidden `/ids` command (owner-only) that prints `chat_id` and the thread IDs for general/offerings/scripture. Paste into `.env`:

   ```
   TELEGRAM_CHAT_ID=
   TELEGRAM_TOPIC_GENERAL=
   TELEGRAM_TOPIC_OFFERINGS=
   TELEGRAM_TOPIC_SCRIPTURE=
   ```

   (Alternative without code: forward a message from each topic to `@getidsbot`.)

## Step 4 — Private Owner Chat

1. Open a direct chat with your bot and send `/start`
2. This is where `/pause`, `/status`, `/mod`, `/say` etc. work. Only `TELEGRAM_OWNER_ID` is honored.

## Step 5 — Optional but Recommended

- Use a second Telegram account as the group owner so your real identity isn't attached. (Needs a second phone number / eSIM.)
- Turn on two-step verification on whichever account owns the group.
- Add the group link to the Pump.fun page and X bio only after the bot is live and the pinned message is up.

## .env Variables This Produces

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_ID=
TELEGRAM_CHAT_ID=
TELEGRAM_TOPIC_GENERAL=
TELEGRAM_TOPIC_OFFERINGS=
TELEGRAM_TOPIC_SCRIPTURE=
```

Hand this file to Claude Code with: "Telegram manual setup is done, here are the env values, build services/mouth per docs/06-telegram.md."
