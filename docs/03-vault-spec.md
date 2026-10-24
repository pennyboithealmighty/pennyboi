# Pennyboi the Almighty — Anchor Vault Program Spec v0.1 ("The Divine Allowance")

October 23, 2026 — all numbers are starting points, tune freely

## 1. State

### Treasury PDA

- Seeds: `["treasury"]`
- Holds SOL. Owned by the program. No private key exists.

### FeeReceiver PDA

- Seeds: `["fees"]`
- The address registered with Pump.fun as the creator-fee recipient (if Pump.fun allows a PDA; otherwise a sweeper wallet that forwards here — see open items).

### Config account (PDA, seeds: `["config"]`)

- `admin: Pubkey` (deploy wallet; only used for escape hatch + param tuning under timelock)
- `agent: Pubkey` (Pennyboi's restricted signing key)
- `token_mint: Pubkey`
- `threshold_lamports: u64` (default 0.5 SOL)
- `last_threshold_balance: u64` (treasury balance at last threshold crossing)
- `action_available: bool` (the "flag")
- `burn_cap_lamports: u64` (default 0.10 SOL)
- `airdrop_cap_lamports: u64` (default 0.10 SOL total)
- `airdrop_max_recipients: u8` (default 5)
- `bounty_cap_lamports: u64` (default 0.05 SOL)
- `burn_cooldown_secs: i64` (default 6 h)
- `airdrop_cooldown_secs: i64` (default 12 h)
- `bounty_cooldown_secs: i64` (default 24 h)
- `last_burn_ts, last_airdrop_ts, last_bounty_ts: i64`
- `escape_timelock_secs: i64` (default 72 h)
- `pending_withdraw: Option<{ amount: u64, to: Pubkey, unlock_ts: i64 }>`
- bump seeds

## 2. The Menu (agent-callable instructions)

Common checks on every menu instruction:

- `signer == config.agent`
- `config.action_available == true`
- `amount <= per-function cap`
- `now >= last_<fn>_ts + <fn>_cooldown`
- on success: set `last_<fn>_ts = now`; `action_available = false`; emit event

### A) `burn(amount_lamports)`

- Swap up to `burn_cap` into token via Pump.fun bonding curve (pre-graduation) or Raydium/Jupiter CPI (post-graduation), then burn received tokens.
- Cooldown 6 h.
- Event: `Burned { sol_spent, tokens_burned, tx }`

### B) `airdrop(recipients: Vec<Pubkey>, amounts: Vec<u64>)`

- `len(recipients) <= airdrop_max_recipients` (5)
- `sum(amounts) <= airdrop_cap`
- Pays SOL (v0.1) — simpler than token transfers; token airdrop can be v0.2.
- Cooldown 12 h.
- Event: `Airdropped { count, total }`

### C) `bounty(to: Pubkey, amount_lamports, memo: String<=140)`

- `amount <= bounty_cap`
- memo = the "offering" being funded (shows on Solscan)
- Cooldown 24 h.
- Event: `BountyPaid { to, amount, memo }`

### (D) Escape hatch — see section 5; NOT agent-callable.

## 3. Sweep (permissionless)

`sweep()`

- Anyone can call. No signer restriction.
- Moves all lamports above rent-exempt minimum from FeeReceiver PDA -> Treasury PDA.
- Then runs threshold check (section 4).
- Because anyone can call it, nobody has to trust the team to forward fees. Pennyboi's service calls it on a cron, but the community can too.

## 4. Threshold Logic

Inside `sweep()`:

```
new_balance = treasury.lamports
if new_balance >= last_threshold_balance + threshold_lamports:
    action_available = true
    last_threshold_balance = new_balance - (new_balance - last_threshold_balance) % threshold_lamports
    emit ThresholdCrossed { balance, step }
```

- Flag stays set until a menu instruction consumes it.
- Only ONE action per threshold crossing. Creates the countdown the community watches.

## 5. Escape Hatch (admin, timelocked)

`request_withdraw(amount, to)`

- `signer == admin`
- sets `pending_withdraw { amount, to, unlock_ts = now + escape_timelock_secs }`
- emit `WithdrawRequested` — public 72 h notice on-chain

`execute_withdraw()`

- `signer == admin`; `now >= unlock_ts`; pays out; clears pending

`cancel_withdraw()`

- `signer == admin`; clears pending

Optional v0.2: allow a holder-vote veto during the timelock.

## 6. Admin Param Updates (timelocked)

`update_config(new_values)` uses the same 72 h timelock pattern so caps/cooldowns can't be silently raised.

Optional: `renounce_admin()` to burn admin entirely once stable.

## 7. Events (what Pennyboi narrates from)

`ThresholdCrossed`, `Burned`, `Airdropped`, `BountyPaid`, `WithdrawRequested`, `WithdrawExecuted`, `ConfigUpdateRequested`.

Pennyboi's "eyes" subscribe to these; every post links the tx on Solscan.

## 8. Security Notes

- Agent key compromise worst case: one capped action per threshold, per cooldown. Bounded loss.
- Validate all recipient accounts are system accounts (no program accounts) on airdrop/bounty.
- Checked math everywhere (u64 overflow).
- Swap CPI: set min-out slippage so burn can't be sandwiched into nothing.
- Devnet first with a mock fee feed. Peer review / audit before mainnet — this is the only component that can lose money.

## 9. Open Items

- Confirm whether Pump.fun will pay creator fees directly to a PDA. If not, the fee wallet -> FeeReceiver forward is the one remaining trust point; document it publicly.
- Decide burn route pre- vs post-graduation (bonding curve vs Raydium/Jupiter).
- Threshold size: 0.5 SOL may be too slow at low volume; consider dynamic (e.g. every N trades OR every X SOL, whichever first).
- Token-denominated airdrops in v0.2.
