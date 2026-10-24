# Pennyboi — Airdrop Eligibility & Selection (hybrid: code builds the pool, Pennyboi picks inside it)

October 24, 2026 — Eyes + Brain + Hands change; one vault config change via the timelock

## Why

Today the Brain picks airdrop recipients freely from the briefing's "top new buyers" and "loyal" lists. Problems:

- Bots farm it: buy big right before a threshold, sell right after.
- No real eligibility: holding 1 token counts the same as holding a million.
- Not defensible: "the AI liked them" is a bad answer to "why not me?"

The fix: **code decides who is eligible, deterministically and publicly; Pennyboi chooses a small number of favorites inside that pool; the rest are drawn at random with a verifiable seed.** Fewer, bigger blessings: **5 recipients at 0.02 SOL each** (cap stays 0.1 SOL total).

## 1. The eligible pool (built by Eyes at each threshold)

A wallet is eligible only if ALL of:

1. **Holds at least `AIRDROP_MIN_HOLD_TOKENS`** of the Pennyboi mint at briefing time.
2. **Has held at least that amount for `AIRDROP_MIN_HOLD_SECS`** (default 24h). Track `qualified_since` per wallet in the `wallets` table: set when balance first reaches the minimum, cleared if it drops below.
3. **Has not sold since the last threshold** (no outgoing transfer of the mint / no sell swap since `last_threshold_ts`).
4. **Is a system account** (a normal wallet, not a program-owned account). The vault already enforces this on-chain; Eyes filters early.
5. **Is not excluded:** the Pump.fun bonding curve, any AMM/LP pool account, the token mint authority, the dev/creator wallet, `admin`, `agent`, Treasury/FeeReceiver/Config PDAs, and any address in an `airdrop_exclusions` table (manual bot list, editable via owner command `/exclude <address>` and `/unexclude`).
6. **Did not receive an airdrop in the last `AIRDROP_REPEAT_COOLDOWN_SECS`** (default 72h), so the same wallets don't win every time.

Holder data: Helius DAS `getTokenAccounts` by mint (paginated) on mainnet; on devnet use the mock holder source in §7.

Pool snapshot: sort eligible wallets by pubkey (deterministic order), cap at `AIRDROP_POOL_MAX` (default 500, keep the largest holders if over), store the snapshot, and compute `pool_hash = sha256(sorted pubkeys joined by ",")`.

If the pool is empty, `airdrop` is **omitted from `available_actions`** in the briefing.

## 2. Selection: favored + fortune

Each airdrop has `AIRDROP_RECIPIENTS` slots (default **5**):

- **Favored (Pennyboi's choice):** up to `AIRDROP_FAVORED_MAX` (default **2**) wallets the Brain picks from the pool. The briefing gives him the pool members who are also in his `loyal` list, with nicknames and reasons, plus the top 10 pool members by holding duration. He may also pick zero.
- **Fortune (random):** the remaining slots are filled by code, not the LLM:
  - `seed = sha256(recent_blockhash_at_briefing || threshold_step)`. The blockhash comes from the slot Eyes reads when building the briefing and is recorded.
  - Remove favored wallets from the sorted pool, then do a deterministic Fisher–Yates shuffle driven by the seed (a sha256 counter-mode PRNG, documented in code), and take the first N.
  - Anyone with the pool snapshot and the seed can recompute the result.
- If the pool has fewer than 5 eligible wallets, everyone in the pool receives.

**Amounts:** equal split, `floor(airdrop_cap / recipients)` lamports each (0.02 SOL at launch settings). No per-wallet favoritism in amount; favor is shown by being chosen and named.

## 3. Brain changes

Briefing `available_actions.airdrop` becomes:

```
airdrop: {
  cap_lamports, recipients: 5, favored_max: 2,
  pool_size: <int>,
  favored_candidates: [ { wallet, nickname?, reason?, held_hours, balance_tokens }, ... up to 15 ]
}
```

Output params for airdrop change to:

```
"params": { "favored": [<pubkey>, ...] }   // 0..favored_max, each from favored_candidates
```

The Brain no longer supplies amounts or the random recipients. Narration should name favored wallets (by nickname if he has one) and frame the rest as fortune: "Two I chose. Three the chain chose for me. All five are blessed."

## 4. Hands changes

On an airdrop decision:

1. Load the pool snapshot + seed recorded for this briefing (by threshold step).
2. Validate: every `favored` pubkey is in the pool and in `favored_candidates`; count ≤ `favored_max`; no duplicates.
3. Compute the fortune picks from the seed exactly as in §2.
4. Build `recipients = favored ++ fortune` (length ≤ 5), `amounts` = equal split.
5. Validate against the fresh Config (cap, max recipients, cooldown, banked acts) as today, then sign and submit.
6. Record an `airdrop_rounds` row and pass the round to Mouth.

If validation fails, retry once with the error (existing flow), then fall back to `none`.

## 5. Vault config change (on-chain)

`airdrop_max_recipients` goes from 20 to **5**.

- **Devnet now:** the current instance has the 72h timelock, so run `config:request` with `VAULT_AIRDROP_MAX=5`, wait 72h, then `config:execute`. This exercises the real timelock path during the dry run. Hands enforces 5 off-chain immediately, so behavior changes right away; the on-chain cap catches up.
- **Mainnet:** initialize with `VAULT_AIRDROP_MAX=5`.

No program code change is needed. The instruction already accepts ≤ `airdrop_max_recipients`.

## 6. Transparency

- New table `airdrop_rounds(step PK, ts, seed, blockhash, pool_hash, pool_size, pool_json, favored_json, fortune_json, amount_each, tx_sig)`.
- New public endpoint `/public/airdrops/latest` and `/public/airdrops?limit=5`: step, seed, blockhash, pool_hash, pool_size, favored (truncated + nickname), fortune (truncated), amount, Solscan link. **Do not expose the full pool list publicly** (privacy); expose `pool_hash` and offer `/public/airdrops/<step>/pool` with the full sorted list only so anyone can verify the hash and the draw.
- Telegram decree for an airdrop includes: "Pool: N faithful. Seed: <first 8 of blockhash>. Verify at pennyboi.com/scripture."
- Scripture page: new "How the Blessing Works" section in plain words: the eligibility rules, 2 chosen + 3 by fortune, how to verify the draw, and the 72h repeat cooldown.
- Owner digest: pool size per threshold, excluded count, any rejected favored picks.

## 7. Devnet testing (no real token yet)

Two options; implement A, optionally B:

- **A. Mock holder source.** `HOLDER_SOURCE=mock` reads `db/mock-holders.json` (address, balance, qualified_since, last_sell_ts). Ship a fixture of ~30 devnet wallets with a mix of eligible/ineligible cases (too small, too new, sold recently, excluded, recently airdropped). Eyes builds the pool from it; Hands pays real devnet SOL to those addresses.
- **B. Devnet SPL token.** Script `scripts/devnet-token.ts` mints a test token, distributes to ~20 generated wallets with varied balances, and sets `TOKEN_MINT` so the real Helius/RPC holder path is exercised.

## 8. Tests

- Pool filter: each rule in §1 excludes the right wallet; deterministic order; `pool_hash` stable.
- Empty pool → `airdrop` absent from `available_actions`.
- Fortune draw: same seed + pool → same picks; favored removed before draw; pool < 5 → all receive.
- Hands rejects a favored pubkey not in the pool / not in candidates / over `favored_max` / duplicated.
- Equal split never exceeds the cap; recipients ≤ 5.
- Repeat cooldown excludes recent winners.
- `/public/airdrops/<step>/pool` hash matches `pool_hash`; the public endpoints never expose excluded addresses' reasons or owner data.

## 9. Env defaults

```
AIRDROP_RECIPIENTS=5
AIRDROP_FAVORED_MAX=2
AIRDROP_MIN_HOLD_TOKENS=100000        # tune at launch to supply/price; ~0.01% of a 1B supply
AIRDROP_MIN_HOLD_SECS=86400
AIRDROP_REPEAT_COOLDOWN_SECS=259200
AIRDROP_POOL_MAX=500
HOLDER_SOURCE=mock                    # mock | helius
VAULT_AIRDROP_MAX=5
```
