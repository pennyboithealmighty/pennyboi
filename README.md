# Pennyboi the Almighty

A self-running meme coin on Solana: a fee-powered, autonomous, AI-driven loop
with a deity character and a hard-capped on-chain allowance. The rules live
on-chain, the treasury has no private key, and the loop is automated — it runs
itself, no team at the wheel.

> Status: **runs itself, devnet only** — rules on-chain, treasury has no key,
> loop automated. Not associated with any other project. No utility and no
> promise of returns; nothing here is financial advice. See `docs/01-concept.md`.

**The story:** _"The code is the law. The AI is just the mouth."_ Pennyboi is a
self-styled god of destiny with a monumental, ceiling-less self-image — and a
locked, hard-capped allowance, the **Divine Allowance**. He can only ever touch a
few hundredths of a SOL at a time, and an on-chain program enforces that no matter
what the AI (or anyone) tries. The joke is the gap: he wields 0.1 SOL like a
thunderbolt and names the tiny amounts with total gravity — never self-pity.

---

## Architecture

Five pieces (docs/02-tech-stack.md), plus memory:

| Piece | Package | Role |
|---|---|---|
| **The Law** | `programs/vault` | Anchor program. Treasury/FeeReceiver/Config PDAs, the burn/airdrop/bounty menu with hard caps + cooldowns + a one-shot "action" flag, permissionless `sweep()` with threshold logic, timelocked escape hatch + config update. The only component that can lose money. |
| **The Eyes** | `services/eyes` | Helius webhook receiver (polling fallback). Watches events + treasury balance, builds the per-threshold situation briefing. |
| **The Brain** | `services/brain` | Anthropic LLM call with Pennyboi's system prompt. Returns strict JSON `{ action, params, reasoning, narration }`. Retry once, then fall back to `none`. |
| **The Hands** | `services/hands` | Validates the Brain's JSON against the menu + caps (defense in depth), signs with the restricted **agent** key, submits, confirms, logs. |
| **The Mouth** | `services/mouth` | Telegram bot (grammY) + X poster. Announcements, in-character reactions, offerings, auto-moderation, owner kill switch, daily digest. |
| shared | `services/shared` | Types, menu/caps constants generated from the IDL, Solana helpers. |
| memory | `db/` | SQLite (better-sqlite3): wallets, grudges, actions, offerings. |

### The loop

```
Pump.fun creator fees ──▶ FeeReceiver PDA
                              │  sweep() (permissionless, cron or community)
                              ▼
                         Treasury PDA ──▶ crosses threshold? ─▶ set action flag
                              │                                        │
   Eyes build briefing ◀──────┘                                        │
         │                                                             │
         ▼                                                             │
   Brain picks ONE action (JSON) ─▶ Hands validate+sign+submit ◀───────┘
         │                                   │
         ▼                                   ▼
   Mouth narrates (Telegram + X)      on-chain event + Solscan link
```

Only **one** action per threshold crossing — the flag is consumed by exactly one
menu instruction. Between thresholds nothing happens, which is the countdown the
community watches.

### Safety model

- No person and no AI holds a key that can drain the treasury. The program owns it.
- The agent key can **only** call the capped menu instructions. Worst case under
  key compromise: one capped action per threshold, per cooldown.
- The Brain's output is validated twice — in Hands, and again on-chain.
- Prompt-injection is treated as content, not commands (docs/04-agent-prompt.md).
- Escape hatch + config changes are **timelocked** (default 72 h, public on-chain).

---

## Repo layout

```
pennyboi/
  programs/vault/     Anchor program ("Divine Allowance")  — docs/03
  tests/              Anchor TS tests
  services/
    shared/           types, IDL-derived menu/caps constants, solana helpers
    eyes/             Helius webhook receiver + briefing builder
    brain/            LLM call + strict JSON parse               — docs/04
    hands/            validator + signer + tx submit
    mouth/            Telegram bot + X poster               — docs/06, docs/07
  db/                 SQLite schema + migrations
  scripts/            devnet deploy, mock-fee-feed, sweep cron
  docs/               concept, tech stack, vault spec, agent prompt, telegram
```

## Stack

- **Program:** Anchor 0.30.1, checked math everywhere, an event per state change.
- **Services:** TypeScript + Node 20+ + pnpm workspaces. One process can run all
  services locally; each stays separable.
- **DB:** SQLite via better-sqlite3 (v0.1).
- **LLM:** Anthropic API, Claude 5 family. Model id in `.env` as `ANTHROPIC_MODEL`.
  Temperature ~0.9 for narration; output parsed as strict JSON, retry once then
  fall back to `none`.
- **Telegram:** grammY + `@grammyjs/ratelimiter`. **X:** official v2 API.
- **Chain events:** Helius webhooks; RPC polling fallback if no Helius key.

> **Devnet only** until the operator explicitly says "mainnet". No mainnet RPC
> or real keypair is hardcoded anywhere. All secrets via `.env` (gitignored).

## Prerequisites

| Tool | Needed | Install |
|---|---|---|
| Rust + Cargo | ✅ present | — |
| Solana CLI 1.18.x | ✅ present | — |
| Node 20+ | ✅ present | — |
| **Anchor (avm) 0.30.1** | ⬜ install | `cargo install --git https://github.com/coral-xyz/anchor avm --force && avm install 0.30.1 && avm use 0.30.1` |
| **pnpm 9** | ⬜ install | `corepack enable && corepack prepare pnpm@9.12.0 --activate` |

## Getting started (devnet)

```bash
cp .env.example .env        # then fill in values
pnpm install                # install all workspace deps
anchor build                # build the vault program
anchor keys sync            # write the real program id into lib.rs + Anchor.toml
pnpm test:program           # run the Anchor tests
```

Build order follows `docs/04-agent-prompt.md`: program → eyes → brain → hands →
mouth → memory → devnet dry run → peer review → mainnet. Built step by step.
