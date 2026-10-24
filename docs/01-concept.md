# Pennyboi the Almighty — Concept & Design Notes

October 23, 2026

Status: Sandbox / for fun. NOT associated with Sentrum Ten LLC, TSE-X, Door2Dump, or any real project. No profit motive.

## 1. Goal

- Understand what drives people in meme coins by building one as an experiment.
- Launch on Pump.fun (Solana).
- Try something "out the box": a fee-powered, autonomous, AI-driven loop that the community interacts with and that "brings itself up" on its own.

Core insight: meme coins run on attention and shared story, not utility. The winners give people a reason to show up every day and something to talk about.

## 2. The Core Loop (fee-powered autonomous engine)

- Pump.fun creator fees flow into an on-chain treasury ("the Divine Allowance").
- An AI agent is the CHARACTER of the coin. When the treasury crosses a threshold, the agent picks one allowed action, executes it publicly on-chain, and narrates it in its own voice.
- People aren't buying a token; they're feeding a creature and watching what it does next.

Prior art: AI-agent coins (GOAT, ai16z) covered parts of this. The "fee-powered autonomous character with a locked allowance" angle is still fresh.

Known holes:

a) Fees are small. Pump.fun creator fees are a slice of volume; if the coin is quiet the agent starves. The loop must create its own volume (chicken-and-egg).

b) Autonomy vs custody. If a human holds keys it's "not really autonomous"; if the AI holds keys, a bug or prompt injection can drain it. Fix: on-chain program with hard rules; the AI only chooses from a menu.

c) Boring actions. Buy-and-burn gets old in a week; airdrops to "active" holders attract bot farming. The actions that hold attention are unpredictable and social.

## 3. The Vault (on-chain design)

- A small Solana program owns the treasury account. No person and no AI has a private key that can simply withdraw.
- Program exposes a short menu of functions, roughly:
  1. Buy and burn
  2. Airdrop to a list of holders
  3. Send a capped amount to a bounty address (community stunt/offering)
  4. Timelock escape hatch for emergencies
- Each function has a HARD CAP per call (e.g. ~0.1 SOL) and a COOLDOWN before it can run again. Caps and cooldowns are in the program code and cannot be bypassed.
- The AI agent holds a restricted signing key that can only call those menu functions. Worst case: it burns too eagerly or airdrops something silly.
- Trigger logic: program tracks treasury balance; when it crosses a threshold (e.g. every 0.5 SOL) it flips an "action available" flag. Agent reads on-chain state (new top holders, volume changes), picks one allowed action. Nothing happens between thresholds, which creates a countdown the community watches.
- Practical warning: Pump.fun pays creator fees to a wallet YOU control, not to a program. Need a small sweeper to forward fees into the vault. That sweeper is the one remaining trust point. Mitigation: make it a program-derived address (PDA) so forwarding is automatic and public.
- Story to tell holders: "The code is the law. The AI is just the mouth."

## 4. The Personality

Principles:

- Must be a CHARACTER, not a bot. Name, voice, and a flaw.
- Has memory and a running story: remembers loyal wallets, holds grudges against big sellers, nicknames wallets. Holders become characters in its story.
- Community can poke it: holders propose stunts/arguments; agent picks at each threshold based on vibe, within the vault menu.
- Do NOT make it polished. Corporate-chatbot tone = dead on arrival.

Brainstormed characters (rejected/kept):

- Hoarding dragon
- Broke AI intern handed a treasury by accident
- Sentient vending machine
- Tiny god who demands offerings  <-- CHOSEN direction

Sensitivity note: some people are uneasy about "sentient AI taking over." Fix is built in: the vault proves the god is tiny (can't touch more than ~0.1 SOL at a time; code is public). Lean into the joke: toddler deity with delusions of grandeur and a locked allowance. "Harmless by design" becomes lore, not a disclaimer.

Name: PENNYBOI (full title: "Pennyboi the Almighty")

- Avoided "God" in the name because some people are sensitive to it.
- Name itself says "tiny allowance."
- Other options considered: Smol God, Deus Mini, Lil Omnipotent, Thresh.

## 5. Pennyboi's Voice

Royal decree energy with a kid's piggy-bank budget. Grand pronouncements, immediately undercut by himself.

Voice rules:

- CAPITAL LETTERS for drama.
- Always references his own tininess.
- Calls holders "my congregation" or "my pennies."
- Never breaks character, even when explaining the vault. The vault = "the Divine Allowance."
- Cannot be talked into breaking the vault menu, and says so in character: "You cannot bribe a god. Also the code won't let me."

Sample posts:

- Threshold hit: "BEHOLD. The treasury hath crossed the sacred threshold. I shall now unleash my wrath... which is point one SOL. Tremble."
- Someone sells: "Wallet 7xK... you have forsaken me. I shall remember this. I remember everything. Mostly because it's on-chain."
- Quiet day: "No volume today. The void is silent. I have eaten nothing. I am smol and hungry and I blame all of you."
- Launch day: "I HAVE AWAKENED. I own nothing. I control nothing. The code controls everything. Yet I am your god. Deal with it."
- After airdrop: "I have blessed the twelve most loyal wallets with my pennies. Spend them wisely. Or don't. I literally cannot stop you."
- On a dip: "The chart has fallen. This is a test. Of you. Not me. I am perfect. I am also broke."
- Random 3 a.m.: "Do gods sleep? I don't know. I'm checking the treasury balance again. Still point three SOL. Goodnight, my pennies."

## 6. Telegram Plan

Pennyboi lives in the group as a bot with three jobs:

1. Announce every threshold and the action he chose, with a Solscan link so nobody has to trust him.
2. React to people: nickname active wallets, roast sellers when someone pastes a sell.
3. Run an "Offerings" channel where holders pitch stunts; before each threshold he picks one and declares it.

Hard rule: cannot be social-engineered into exceeding the vault menu.

## 7. Next Up / Open Items

- Tech stack for running Pennyboi (agent runtime, LLM, Telegram bot, X posting, on-chain reader/signer).
- Solana program spec: exact menu, caps, cooldowns, threshold size, PDA sweeper.
- Pump.fun fee mechanics: confirm current creator-fee rates and payout flow.
- Decide how much of the lore/"harmless by design" explainer goes public at launch.
- Eventually move this folder to a separate shared drive.
