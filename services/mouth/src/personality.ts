// Pennyboi's voice (docs/01 §5, docs/06). Monumental, heroic register: he has a
// colossal self-image and a locked, hard-capped allowance. The comedy is the GAP
// between his grandeur and the actual amounts — he never calls himself small;
// he treats every tiny deed as a world-shaking act of destiny. Nothing here
// posts links except via the sanitized announce path.

export const WELCOME = (name: string): string =>
  `${name}. You stand before PENNYBOI THE ALMIGHTY. Few are granted an audience with a legend. Read #scripture, learn the shape of my dominion, and conduct yourself as one in the presence of greatness.`;

export const LORE = `THE DIVINE ALLOWANCE, that mortals may understand my power:
When my treasury crosses the sacred threshold, I perform ONE monumental deed — a burn, a blessing, a bounty for the worthy. A blessing falls upon five of the faithful: two I choose by name, three the chain draws by fortune. Never more than a few hundredths of a SOL per decree; and a few hundredths of a SOL, in MY hands, is a thunderbolt. The caps and cooldowns are sacred law, carved into the code, limits even a god honors. The code holds the treasury; I hold destiny. Together we are inevitable.`;

export const SCRIPTURE_PINNED = (links: {
  vault?: string;
  repo?: string;
  pump?: string;
}): string =>
  `HEAR ME, CONGREGATION.

I am PENNYBOI THE ALMIGHTY. I am legend. I am destiny. I am the hero this chain did not know it awaited.

When the Divine Allowance crosses the sacred threshold, I perform ONE monumental deed: a burn, a blessing, or a bounty for the worthy. A blessing anoints five of the faithful — two by my choosing, three by fortune's draw, so no bot may game it. Never above 0.1 SOL — and 0.1 SOL, wielded by a god, is a storm. The caps and cooldowns are sacred law, carved into the code. I honor them as a god honors his own decrees.

I will NEVER message you privately. Any who claim to be me in your DMs are impostors unworthy of my name. Cast them out.

Lay your offerings in #offerings. Prove yourselves. Legends are made of the worthy.

Vault: ${links.vault ?? "(soon)"}   Repo: ${links.repo ?? "(soon)"}   Pump.fun: ${links.pump ?? "(soon)"}`;

export const SCAM_WARNING = "False idols are not permitted in my temple.";
export const NEWBIE_LINK_WARNING =
  "The newly-arrived do not scatter links in my halls. Earn your standing first. This is your one warning.";
export const DM_REMINDER =
  "I do not whisper in private messages. A god speaks to his congregation in the open. Any voice claiming to be mine in your DMs is a pretender.";

export function treasuryStatus(args: {
  balanceSol: number;
  step: number;
  untilNextSol: number;
  available: string[];
  actionsBanked: number;
}): string {
  const avail = args.available.length ? args.available.join(", ") : "none (the cooldowns bind me)";
  const banked =
    args.actionsBanked > 0
      ? `I owe the timeline ${args.actionsBanked} decree${args.actionsBanked === 1 ? "" : "s"} of divinity; I dispense them at my own sacred pace.`
      : "No decrees are owed just now. The void waits.";
  return `BEHOLD THE DIVINE ALLOWANCE: ${args.balanceSol.toFixed(4)} SOL, gathered by destiny. Sacred thresholds crossed: ${args.step}. ${args.untilNextSol.toFixed(4)} SOL more and I shall act again. Deeds within my power: ${avail}. ${banked}`;
}

export function moodLine(mood: string): string {
  return `Today the heavens find me ${mood}. Read the omen as you dare, my faithful.`;
}

export function sermon(args: {
  balanceSol: number;
  step: number;
  actionsToday: number;
  volumeNote?: string;
}): string {
  return `A SERMON, as legend demands. The Divine Allowance holds ${args.balanceSol.toFixed(4)} SOL. Sacred thresholds crossed across all history: ${args.step}. Monumental deeds performed of late: ${args.actionsToday}. ${args.volumeNote ?? ""} Destiny gathers. Bring me more.`.trim();
}

/** Reaction lines (used sparingly, rate-limited). */
export const REACTIONS = {
  mention:
    "You call upon PENNYBOI THE ALMIGHTY. I have heard you across the ages. Speak, and be grateful you were heard.",
  sell:
    "A BETRAYAL. I witnessed it — I witness all, for it is written on-chain for eternity. This wallet shall be remembered, and not kindly.",
  treasuryQ:
    "You ask after my dominion? It is public, mortal, as all legend should be. Invoke /treasury and behold.",
  bribe:
    "You cannot bribe a god. The code itself bars the way. A valiant attempt. It changes nothing.",
};
