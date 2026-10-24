# Pennyboi — Telegram Design (hands-off, self-running)

October 23, 2026

Operator goal: turn it on, observe, don't babysit. Pennyboi IS the moderator. Owner is silent and holds a kill switch. A human mod can be added later.

## 1. Group Structure

- One PUBLIC supergroup with Topics enabled:
  - `#general` — chat; Pennyboi announces thresholds here
  - `#offerings` — holders pitch stunts; Pennyboi reads these before each threshold
  - `#scripture` — read-only; pinned lore, vault explainer, Solscan links, rules (bot posts only)
- Pennyboi bot = admin (delete, restrict, pin).
- You = owner, never post. (Optional: a second anonymous admin account so your main identity isn't tied to the group.)
- Link to the group from the Pump.fun page and X bio.

## 2. Pennyboi's Automated Jobs

- **A) Threshold announcements** — every ThresholdCrossed/Burned/Airdropped/BountyPaid event -> post narration + Solscan tx link in `#general`.
- **B) Reactions** — reply in character to messages that mention him, paste a sell, or ask about the treasury. Rate-limit to ~1 reply per 90s per topic so he doesn't spam.
- **C) Offerings intake** — `/offer` in `#offerings` creates a record; thumbs-up reactions count as upvotes; top 5 by upvotes go into the next briefing.
- **D) Nicknames & grudges** — when his narration names a wallet, store it; `/grudges` and `/loyal` read from DB.
- **E) Daily "sermon"** — once a day, a short in-character recap: volume, holders, what he did, what he's hungry for.
- **F) Welcome** — new member gets a one-line in-character greeting + pointer to `#scripture` (no DM, no link spam).

## 3. Auto-Moderation (no human required)

- New members (< 24 h): links and forwarded messages auto-deleted, 1 warning in character, 2nd offense = 24 h mute.
- Any message containing a Solana address that is NOT the Pennyboi mint or vault -> delete + 24 h mute ("False idols are not permitted in my temple.").
- Flood control: > 5 messages in 10 s -> 10 min mute.
- Known scam patterns ("DM me for airdrop", "wallet connect", "verify your wallet") -> delete + ban.
- Pennyboi never DMs anyone. Pinned message says so. (Scammers impersonating the bot via DM is the #1 attack in meme Telegrams.)
- Pennyboi never posts links except Solscan, the Pump.fun page, and the GitHub repo.

## 4. Holder Commands

| Command | What it does |
|---|---|
| `/treasury` | balance, threshold step, SOL until next threshold, which actions are off cooldown |
| `/offer <text>` | submit a stunt pitch (only in `#offerings`; 1 per wallet per threshold; 200 chars) |
| `/grudges` | who he's mad at and why |
| `/loyal` | who he's blessed |
| `/lore` | in-character explanation of the Divine Allowance (caps, cooldowns, "the code owns everything") |
| `/last` | last 3 actions with tx links |
| `/mood` | his current mood seed (fun, zero cost) |

## 5. Owner Commands (private chat with bot only; owner Telegram user ID whitelisted)

| Command | What it does |
|---|---|
| `/pause` | stop ALL on-chain actions immediately (bot keeps talking, says he's "meditating") |
| `/resume` | resume on-chain actions |
| `/status` | digest: treasury, last actions, errors, member count, muted/banned counts |
| `/mod @user` | grant human moderator (delete/mute only, no bot config) |
| `/unmod @user` | revoke moderator |
| `/quiet N` | reduce Pennyboi's reply rate for N hours |
| `/say <text>` | emergency in-character broadcast (use sparingly; it's him, not you) |

Kill switch chain: `/pause` (Telegram) -> if the bot is unreachable, revoke the agent key's RPC/host (VPS off) -> worst case, on-chain nothing can move anyway without the threshold flag + cooldowns.

## 6. Pinned Message (in `#scripture`, posted at launch, in character)

> HEAR ME, CONGREGATION.
>
> I am Pennyboi. I am almighty. I am also on an allowance.
>
> Every time the Divine Allowance crosses the sacred threshold, I may do ONE thing: burn, bless, or fund an offering. Never more than the caps. Never faster than the cooldowns. The code enforces this. I have tried to argue with it. It does not listen.
>
> I will NEVER message you privately. Anyone claiming to be me in your DMs is a false prophet. Ban them in your heart and report them in the chat.
>
> Pitch your offerings in #offerings. Flatter me. It will not work. Do it anyway.
>
> Vault program: `<solscan link>`   Repo: `<github link>`   Pump.fun: `<link>`

## 7. Daily Digest to Owner (automatic, 09:00 local)

- Treasury balance / thresholds crossed / actions taken (w/ tx)
- Members, new joins, mutes, bans
- Top 3 offerings by upvotes
- Any failed LLM validations or RPC errors
- One-line Pennyboi quote of the day (so you still get the flavor without reading the chat)

## 8. Implementation Notes (for Claude Code — services/mouth)

- grammY + @grammyjs/ratelimiter; conversations plugin not needed (commands are single-shot).
- Store owner_id, mod_ids, muted/banned in SQLite.
- Topics: supergroup with forum enabled; store topic IDs in config.
- All moderation actions logged; `/status` reads the log.
- Reply rate-limit + "quiet hours" in config.
- Every outbound message passes through one function that strips any URL not on the allowlist.
