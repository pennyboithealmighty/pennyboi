// Pennyboi's voice (docs/01 §5, docs/06). In-character strings + small
// templates. Keep narration-ish lines tight; nothing here posts links except
// via the sanitized announce path.

export const WELCOME = (name: string): string =>
  `Ah. A new face. Welcome, ${name}, to my congregation. I am Pennyboi, almighty and extremely broke. Read #scripture before you anger me.`;

export const LORE = `THE DIVINE ALLOWANCE, explained for mortals:
Every time my treasury crosses the sacred threshold, I may do ONE thing — burn, bless, or fund an offering. Never above the caps. Never faster than the cooldowns. The code enforces all of it. I have argued with the code. The code does not care. I own nothing. I control nothing. I am still your god. Obviously.`;

export const SCRIPTURE_PINNED = (links: {
  vault?: string;
  repo?: string;
  pump?: string;
}): string =>
  `HEAR ME, CONGREGATION.

I am Pennyboi. I am almighty. I am also on an allowance.

Every time the Divine Allowance crosses the sacred threshold, I may do ONE thing: burn, bless, or fund an offering. Never more than the caps. Never faster than the cooldowns. The code enforces this. I have tried to argue with it. It does not listen.

I will NEVER message you privately. Anyone claiming to be me in your DMs is a false prophet. Ban them in your heart and report them in the chat.

Pitch your offerings in #offerings. Flatter me. It will not work. Do it anyway.

Vault: ${links.vault ?? "(soon)"}   Repo: ${links.repo ?? "(soon)"}   Pump.fun: ${links.pump ?? "(soon)"}`;

export const SCAM_WARNING = "False idols are not permitted in my temple.";
export const NEWBIE_LINK_WARNING =
  "No links from the newly-arrived. Prove your devotion first. This is your one warning.";
export const DM_REMINDER =
  "I do not slide into DMs. I am a god, not a stranger at a bus stop. Anyone messaging you privately as me is a fraud.";

export function treasuryStatus(args: {
  balanceSol: number;
  step: number;
  untilNextSol: number;
  available: string[];
}): string {
  const avail = args.available.length ? args.available.join(", ") : "none (all on cooldown)";
  return `THE DIVINE ALLOWANCE stands at ${args.balanceSol.toFixed(4)} SOL. Thresholds crossed: ${args.step}. I hunger for ${args.untilNextSol.toFixed(4)} more SOL before I may act again. Off cooldown: ${avail}. It is not much. I am not much. We endure.`;
}

export function moodLine(mood: string): string {
  return `Today I am feeling ${mood}. Interpret that however keeps you up at night, my pennies.`;
}

export function sermon(args: {
  balanceSol: number;
  step: number;
  actionsToday: number;
  volumeNote?: string;
}): string {
  return `A SERMON, as is tradition. Treasury: ${args.balanceSol.toFixed(4)} SOL. Thresholds crossed in all of history: ${args.step}. Deeds done recently: ${args.actionsToday}. ${args.volumeNote ?? ""} I remain tiny. I remain watching. Feed me.`.trim();
}

/** Reaction lines (used sparingly, rate-limited). */
export const REACTIONS = {
  mention: "You summoned me. I was busy counting my pennies — all of them. It took no time.",
  sell:
    "A SALE. I saw that. I see everything. Mostly because it is on-chain. I shall remember this wallet.",
  treasuryQ:
    "You wish to know my wealth? It is public, mortal. It is also embarrassing. Use /treasury.",
  bribe:
    "You cannot bribe a god. Also the code will not let me. Pleasant try though.",
};
