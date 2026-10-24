# Pennyboi — Treasury Banking & Idle Floor (vault change)

October 24, 2026 — program change, build + redeploy on devnet during the dry run

## The problem

Today the act flag (`action_available`) is a bool and threshold detection grants exactly one act per `sweep()` call that crosses `last_threshold_balance + threshold`. Two failure modes:

1. **Whale day wastes crossings.** If a large fee inflow pushes the balance across many thresholds between sweeps (or in one sweep), only ONE act is granted. The other crossings are lost. A 20 SOL launch day should fund many future decrees; instead it funds one.
2. **Quiet period goes silent.** When fees slow, the balance stops crossing new thresholds, so no acts are granted — even though the treasury holds plenty of SOL. Pennyboi goes dead on-chain exactly when the project most needs him visible.

The caps on burn/airdrop/bounty are correct and unchanged — they limit what he SPENDS per act, not what the vault HOLDS. This change is only about how often he gets to act.

## The fix: an action counter + an idle floor

Replace the single bool with a small counter, and add a time-based floor so he never goes fully silent while funded.

### Config changes (new fields; keep all existing fields)

```
actions_available: u16        // replaces action_available: bool. How many acts are owed.
max_banked_actions: u16       // cap on the counter. default 50.
idle_floor_secs: i64          // if no act in this long AND treasury >= one cap, grant 1. default 86400 (24h).
last_action_ts: i64           // timestamp of the last consumed act (any kind). for the idle floor.
```

Migration note: the devnet instance will be redeployed fresh (FORCE_DEPLOY), so no on-chain migration is needed — the new Config layout is initialized at deploy. Bump the VAULT_* env with the two new defaults.

### Threshold logic in `sweep()` (revised)

```
new_balance = treasury.lamports
crossings = 0
while new_balance >= last_threshold_balance + threshold_lamports:
    last_threshold_balance += threshold_lamports
    crossings += 1
actions_available = min(actions_available + crossings, max_banked_actions)
if crossings > 0:
    emit ThresholdCrossed { balance: new_balance, step: <total step count>, granted: crossings, banked: actions_available }
```

So one sweep that jumps 40 thresholds banks 40 acts (capped at `max_banked_actions`). Note the loop walks `last_threshold_balance` up by one step at a time so the counter is exact; bound it defensively (e.g. break after `max_banked_actions` increments) so a huge balance can't run the loop unboundedly.

### Idle floor (checked in `sweep()`, after the threshold loop)

```
if actions_available == 0
   and treasury.lamports >= min(burn_cap, airdrop_cap, bounty_cap)  // at least the smallest cap spendable
   and now >= last_action_ts + idle_floor_secs:
    actions_available = 1
    emit IdleFloorGranted { balance: new_balance, since: last_action_ts }
```

This keeps him acting during slow spells as long as the vault can afford the smallest deed. Because `sweep()` is permissionless and the service crons it, the floor is checked regularly without any new instruction.

### Menu instructions (burn / airdrop / bounty)

- Change the gate from `action_available == true` to `actions_available > 0`.
- On success: `actions_available -= 1`, set `last_action_ts = now`, keep the existing per-function cooldown stamp and event.
- Cooldowns are unchanged and still apply per function. So even with 40 banked acts, he can't burn more than once per 6h — banking controls how many acts are OWED over time, cooldowns control the PACE. The two together mean a whale day funds a long, steady drip of decrees rather than a flurry.

## Behavior after the change

- **Launch day, 20 SOL in:** ~40 crossings banked (capped at 50). He then spends them one per cooldown over the following days/weeks. The treasury balance stays high; the counter draws down.
- **Quiet week, vault still funded:** no new crossings, but the 24h idle floor grants one act a day as long as the vault can afford the smallest cap, so he never fully disappears.
- **Vault near empty and quiet:** idle floor does NOT fire (can't afford a cap), and he honestly goes dormant — correct, and the lore covers it ("the void is silent, I have eaten nothing").

## Site + narration

- The treasury panel's "SOL until next threshold" stays, but add a **"decrees banked: N"** readout (read `actions_available` from Config) so holders can see he has a backlog of owed acts. The `/public/status` and `/treasury` command should expose it too.
- Briefing: add `actions_banked` so the Brain knows he's working through a backlog; he can reference it in character ("I owe the timeline 11 more acts of divinity. Patience, mortals.").

## Tests (Anchor)

- One sweep that crosses N thresholds banks exactly N (and caps at `max_banked_actions`).
- Each menu call decrements the counter by one and stamps `last_action_ts`.
- A menu call is rejected when `actions_available == 0`.
- Cooldown still blocks a second same-function act even with counter > 1.
- Idle floor grants exactly one act after `idle_floor_secs` with zero counter and an affordable balance, and does NOT grant when the balance is below the smallest cap.
- Idle floor does not stack (stays at 1, not N, across multiple idle sweeps before an act is consumed).

## Defaults for .env

```
VAULT_MAX_BANKED_ACTIONS=50
VAULT_IDLE_FLOOR_SECS=86400
```

Keep this a config change (timelocked on mainnet) so the banking cap and idle floor can be tuned after launch without a redeploy.
