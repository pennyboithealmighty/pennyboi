# Devnet dry run — runbook

Goal: run the whole loop unattended for ~a week on devnet and watch Pennyboi
behave. Build-plan Step 7. The program is already deployed + initialized and the
first burn fired end to end.

Everything runs under **pm2** (one process manager, restart-on-crash, logs) via
`ecosystem.config.cjs`.

## 0. One-time prep

**Install pm2** (if you don't have it):

```bash
npm install -g pm2
```

If pm2 can't find `pnpm`, start it from a shell where `pnpm -v` works (corepack
on PATH), or set the full pnpm path as the `script` in `ecosystem.config.cjs`.

**Keep the Mac awake** for the whole run (sleep pauses the processes):

```bash
caffeinate -dimsu &
```

(or run pm2 under it: `caffeinate -dimsu pm2 ...`). A small always-on VPS is the
more robust home for this — see `docs/02-tech-stack.md` — but caffeinate on your
Mac is fine for a first week.

## 1. Funding

The fee feed drips SOL from **admin** into the FeeReceiver PDA; **agent** only
pays tiny tx fees. Over a week at the pace below admin spends ~14 SOL (it mostly
accumulates in the treasury, it isn't burned). The feed also **auto-tops-up
admin** from the faucet (best-effort) when it runs low, but pre-fund a buffer so
it isn't relying on rate-limited airdrops:

```bash
ADMIN=$(solana address -k keys/admin.json)
# devnet faucet caps ~2 SOL/request and has a daily cap — repeat a few times:
solana airdrop 2 "$ADMIN" --url devnet
# ...aim for ~16 SOL in admin. Agent is already funded (~2.5 SOL) — plenty.
solana balance "$ADMIN" --url devnet
```

## 2. Tune the pace (.env)

Defaults cross the 0.5 SOL threshold about every ~6 h, which lines up with the
burn cooldown so a burn can fire most crossings:

```
MOCK_FEE_LAMPORTS=50000000      # 0.05 SOL per drip
MOCK_FEE_INTERVAL_SECS=2100     # every 35 min  -> ~2 SOL/day
SWEEP_INTERVAL_SECS=300         # sweep every 5 min
```

Lower the interval to move faster (more crossings, more admin SOL/day); raise it
to stretch the run. The **threshold itself (0.5 SOL) is fixed on-chain** — it was
set at initialize and can only change via the 72 h timelocked config update.

## 3. Start

```bash
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save            # remember this process set
pm2 startup         # (optional) survive a reboot — run the line it prints
```

`pm2 status` should show six processes **online**: `pb-mouth pb-hands pb-brain
pb-eyes pb-feed pb-sweep`.

## 4. Monitor (without watching)

- **Telegram** is the main window: threshold announcements land in #general with
  Solscan links; `/treasury`, `/last`, `/status` (owner DM) on demand; a **daily
  sermon + owner digest at 09:00** gives you the flavor and the numbers.
- `pm2 status` — all six online, restart counts.
- `pm2 logs` — tail everything; `pm2 logs pb-brain` for one. Files are in `logs/`.
- Brain logs the raw LLM output + reason for any rejected attempt, so a
  fallback-to-none is diagnosable.

## 5. Stop

```bash
pm2 stop all        # pause
pm2 delete all      # remove the processes
# kill the caffeinate you backgrounded, too
```

## What to expect

- On devnet there are **no real traders**, so the briefing's buyers / sellers /
  offerings are empty → the agent will mostly **burn** (every ~6 h, when off
  cooldown) or choose **none**. Airdrop/bounty need wallets from the briefing, so
  they'll rarely fire until real activity exists. That's expected: the dry run
  validates the *mechanics* (fees → threshold → decision → signed action →
  narration → memory), not community dynamics.
- To exercise airdrop/bounty, post an `/offer` in Telegram (gives the briefing an
  offering wallet) or send some token trades the Eyes webhook/poller can see.
- Devnet occasionally resets; if the program/state ever disappears, re-run
  `pnpm --filter @pennyboi/scripts deploy:devnet` (idempotent).
