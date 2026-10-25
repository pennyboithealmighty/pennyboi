# Pennyboi — Real Buyback-and-Burn (replace the burn stub)

October 25, 2026 — vault program change (redeploy), Hands + Brain + Mouth changes. **Mainnet blocker.**

## Why

Today `burn` is a v0.1 stub: it moves SOL from the Treasury to the `burn_route` PDA (`[b"burn"]`), where it sits forever, and emits `Burned { sol_spent, tokens_burned: 0 }`. No PENNYBOI is bought, no supply is removed, no buy pressure is created. Holders would correctly call that "burning SOL for nothing."

Target: **spend up to `burn_cap` SOL from the Treasury to buy PENNYBOI on its real market, then SPL-burn every token received, in one transaction, enforced by the program.** The decree then reads "Spent 0.05 SOL. Burned 1,204,331 PENNYBOI." with a Solscan link that proves both halves.

## 0. Rules

- **No SOL ever leaves to an agent-controlled wallet.** We reject the "agent swaps off-chain, then deposits tokens" design: to swap off-chain the agent would need Treasury SOL in its own wallet, which breaks the core promise ("no key can withdraw"). The swap happens inside the vault instruction, signed by the Treasury PDA.
- Caps, cooldowns, banked acts, and the 72h timelock all stay exactly as they are.
- `burn_route` and the transfer-to-PDA stub are **removed** before mainnet. Mainnet never ships the stub.
- Devnet only until the owner says "mainnet".

## 1. Design: whitelisted-venue CPI with balance-delta guards

One instruction, `buyback_burn`, that is resilient to venue account-layout changes because it does **not** hard-code the venue's account list. It trusts *outcomes*, measured by the program, not the venue's inputs.

```
buyback_burn(
  amount_lamports: u64,     // <= burn_cap
  min_tokens_out: u64,      // > 0, from the agent's fresh quote
  venue_ix_data: Vec<u8>,   // the venue's buy instruction data, built off-chain
)
accounts:
  config, agent (signer), treasury (PDA, signs the CPI),
  treasury_token_ata (mint = config.token_mint, owner = treasury),
  treasury_wsol_ata (optional; only for venues that need wrapped SOL),
  mint, token_program (Token or Token-2022, checked against the mint's owner),
  venue_program (must be in config.venue_whitelist),
  system_program,
  remaining_accounts: the venue's accounts, passed through as-is
```

### Program steps

1. Usual gates: agent signer, `actions_available > 0`, burn cooldown, `amount_lamports <= burn_cap`, `min_tokens_out > 0`.
2. `venue_program` ∈ `config.venue_whitelist` (max 4 entries). Reject if it is the System, Token, Token-2022, ATA, or this vault program itself.
3. `remaining_accounts` must not include the Config or FeeReceiver PDAs. The only Treasury-owned accounts allowed are `treasury`, `treasury_token_ata`, and `treasury_wsol_ata`.
4. **Snapshot before:** `sol_before = treasury.lamports + wsol_ata.amount` (if present); `tok_before = treasury_token_ata.amount`.
5. If the venue needs WSOL: transfer `amount_lamports` into `treasury_wsol_ata` and `sync_native` (both signed by the Treasury PDA).
6. `invoke_signed(venue_program, remaining_accounts, venue_ix_data, treasury seeds)`.
7. **Snapshot after and enforce:**
   - `sol_spent = sol_before - sol_after` must be `<= amount_lamports` (plus a small fixed rent/fee allowance, `config.burn_fee_allowance_lamports`, default 0.003 SOL, for ATA rent or venue fees).
   - `tokens_received = tok_after - tok_before` must be `>= min_tokens_out`.
   - If a WSOL ATA was used, unwrap the leftover WSOL back to the Treasury.
8. **Burn:** `burn_checked(treasury_token_ata, mint, tokens_received)` with the Treasury PDA as authority. Burn exactly what was received, so any stray tokens already in the ATA are untouched.
9. Update counters/cooldown exactly as today; emit `Burned { sol_spent, tokens_burned: tokens_received, venue: venue_program, min_tokens_out }`.

All of this happens in one transaction, so if any check fails the whole thing reverts and no SOL moves.

### Why the CPI is still safe with the Treasury signing it

- Only whitelisted programs can be invoked, and the whitelist can only change through the 72h timelock (it lives in Config).
- Whatever the venue does, the program checks what actually happened: SOL out is bounded by the cap, tokens in are bounded below by `min_tokens_out`, and the tokens are burned. Worst case from a bad quote is a bad price on at most `burn_cap`, once per cooldown.
- The Treasury PDA owns nothing else of value that a venue could touch: no other token accounts, no authorities.

## 2. Venues (launch whitelist)

| Phase | Venue | Notes |
|---|---|---|
| Before graduation | **Pump.fun bonding-curve program** (`buy`) | Native SOL. The `max_sol_cost` arg in its ix data is an extra cap. Graduation is detected by reading the bonding curve's `complete` flag (Hands reads it off-chain to pick the venue; the program doesn't need to). |
| After graduation | **PumpSwap AMM** (`buy`) | The canonical pool where creator fees come from. Uses WSOL. |
| Optional, later | Jupiter v6 | Only if PumpSwap liquidity proves thin. Heavier (many accounts, more compute). Not in the launch whitelist. |

Program IDs go in Config at initialize (`VAULT_VENUE_WHITELIST`). Verify the current program IDs, instruction layouts, and account lists **against the live Pump.fun / PumpSwap IDLs at build time**; they have changed before (creator-fee and volume-accumulator accounts were added in 2025). Also check whether new Pump.fun mints are SPL Token or Token-2022, and support both via `token_interface`.

## 3. Hands (off-chain): building the buy

On a `burn` decision:

1. Read the bonding curve. If `complete == false`, use the Pump.fun curve; otherwise use the PumpSwap pool.
2. Fetch fresh reserves and quote `expected_out` for `amount_lamports`.
3. `min_tokens_out = floor(expected_out * (1 - BURN_SLIPPAGE_BPS/10000))` (default 300 = 3%). Refuse if `expected_out` implies a price impact over `BURN_MAX_IMPACT_BPS` (default 1000 = 10%); in that case shrink the amount by half once, else fall back to `none` with a log line.
4. Build the venue's buy ix data and account list with the venue's own SDK/IDL (`@pump-fun/pump-sdk` / `pump-swap-sdk` or IDL-generated). The payer/user is the Treasury PDA, and the token destination is `treasury_token_ata`.
5. Wrap it in `buyback_burn` with a ComputeBudget ix (start with 400k CU, measure, then tune) and a priority fee.
6. Submit, preferably via a private/Jito route to reduce sandwiching. Fall back to the normal RPC.
7. Before the first burn, create `treasury_token_ata` (and the WSOL ATA if needed) with a permissionless `init_treasury_atas` instruction. The agent pays rent; the ATAs are owned by the Treasury PDA.

## 4. Brain + Mouth

- The Brain's burn params are unchanged (`amount_lamports`). It never handles quotes or venues.
- The narration gets the real numbers: "I spent 0.05 SOL of the Divine Allowance and burned 1,204,331 PENNYBOI. Supply shrinks. Tremble."
- Decree data and `/public/decrees` add `tokens_burned` and `venue`. The site's treasury panel adds **"PENNYBOI burned (all time)"**.
- The Telegram burn post keeps the `pennyboi-burn.mp4` clip.
- Whitepaper, Scripture, ambassador FAQ: burn = buyback-and-burn, with min-out protection.

## 5. Config additions (timelocked)

```
venue_whitelist: [Pubkey; 4]          // zeroed slots = unused
burn_fee_allowance_lamports: u64      // default 3_000_000 (0.003 SOL)
```

Env:
```
VAULT_VENUE_WHITELIST=<pump curve program>,<pumpswap program>   # devnet: <mock venue program>
VAULT_BURN_FEE_ALLOWANCE_LAMPORTS=3000000
BURN_SLIPPAGE_BPS=300
BURN_MAX_IMPACT_BPS=1000
```

## 6. Devnet testing

Pump.fun and PumpSwap don't exist on devnet, so:

1. **Mock venue program** `programs/mock-venue` (devnet and tests only, never on the mainnet whitelist): a tiny constant-product pool, devnet SPL token ↔ SOL, with a `buy(amount_in, min_out)` instruction. It lets the generic CPI, the delta checks, and the burn run end to end on devnet.
2. `scripts/devnet-token.ts` (docs/11 §7B): mints the devnet token, seeds the mock pool, and sets `TOKEN_MINT` and the whitelist.
3. **Adversarial tests** (Anchor, with a `mock-evil-venue` built in tests only):
   - venue takes more SOL than `amount_lamports` + allowance → revert
   - venue returns fewer tokens than `min_tokens_out` → revert
   - venue not whitelisted / is the token or system program → revert
   - `remaining_accounts` includes Config or FeeReceiver → revert
   - stray tokens already in the ATA are not burned; only the delta is
   - cooldown, cap, and banked-act rules still apply; the counter decrements once
   - Token and Token-2022 mints both work
4. **Mainnet first burn:** set a tiny `burn_cap` (e.g. 0.005 SOL) at initialize, do one live burn, verify on Solscan, then raise the cap through the timelock.

## 7. Timing (important)

This is a program change, so the devnet instance gets redeployed (FORCE_DEPLOY). A redeploy **wipes the pending `VAULT_AIRDROP_MAX=5` timelock request** (executable Oct 27, 23:36 UTC) and resets the dry-run state.

- Build and test against the local validator (`anchor test`) now.
- **Don't redeploy devnet until after** `config:execute` on Tuesday has been run and verified, ideally after the 7-day dry run ends.
- Then redeploy with the new program and run a short (2–3 day) burn-focused dry run on the mock venue.

## 8. Build stages (commit after each)

1. `init_treasury_atas` + `buyback_burn` with delta checks + SPL burn, plus `mock-venue` and `mock-evil-venue`. All Anchor tests green on the local validator. No devnet deploy yet.
2. `scripts/devnet-token.ts` + mock pool seeding + Hands quote/build path for the mock venue (feature flag `BURN_MODE=stub|swap`, default stub until redeploy).
3. Hands Pump.fun-curve + PumpSwap builders (verified against current IDLs, unit-tested with recorded account fixtures; no live calls).
4. Brain/Mouth/public API/site: `tokens_burned`, `venue`, the all-time burned counter, and narration.
5. Remove `burn_route`, update docs (whitepaper, Scripture, README). **Owner decides when to redeploy devnet.**
