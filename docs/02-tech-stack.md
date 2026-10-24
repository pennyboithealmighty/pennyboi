# Pennyboi the Almighty — Tech Stack & Architecture

October 23, 2026 — companion to "Concept & Design Notes"

## Five Pieces

### 1. The Brain (agent)

- LLM API (Claude or similar).
- Long system prompt = Pennyboi's character bible (voice rules, lore, hard "cannot exceed the Divine Allowance" rule).
- Memory store: wallet nicknames, grudges, loyalty history, past actions and their outcomes.
- DB: Postgres or SQLite is plenty.
- LLM output must be STRUCTURED (JSON): `{ action, params, narration }`. Never free-form instructions to the signer.

### 2. The Eyes (on-chain listener)

- Solana RPC listener / Helius webhooks.
- Watches: buys, sells, new holders, top-holder changes, treasury balance, threshold flag.
- This is what wakes Pennyboi up.

### 3. The Hands (restricted signer)

- Node or Python service holding the restricted signing key.
- Only knows how to call the vault's menu functions, nothing else.
- Flow: LLM returns structured choice -> service validates against menu + caps -> signs -> submits -> logs tx signature.
- Validation happens in the service AND is enforced again on-chain by the program (defense in depth).

### 4. The Mouth (social)

- Telegram bot via Bot API (threshold announcements w/ Solscan link, reactions, Offerings channel).
- X posting via X API.
- Same service, two outputs; narration text comes from the LLM.

### 5. The Law (vault)

- Anchor program on Solana.
- Treasury PDA; menu functions (buy-and-burn, airdrop, bounty, timelock escape hatch); per-call hard caps; cooldowns; threshold flag; PDA sweeper for Pump.fun creator fees.
- This is the real engineering lift and the ONLY component that can lose money. Get it audited or at least peer-reviewed before mainnet.

## Hosting

- One small VPS, or a Cloudflare Worker + cron, is enough for Brain/Eyes/Hands/Mouth.
- Keep the signing key in a secret store, never in repo.
- Devnet first, with a fake fee feed, before anything touches mainnet.

## Next

- Spec the Anchor program's exact menu: function list, caps, cooldowns, threshold size, who can call what, escape-hatch timelock length.
