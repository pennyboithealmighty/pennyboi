// Pennyboi's public voice, kept short and special. Pure text helpers shared by
// Mouth (posting) and the sample/dry-run scripts:
//   - hard length limits per channel, trimmed at the last full sentence
//   - a hard sentence cap (MAX_SENTENCES), trimmed at sentence boundaries
//   - catchphrase throttle so the signature lines stay rare
//   - the 9:00 sermon: in character, rotating opener/closer, only the facts that
//     actually happened, with the night's dust offerings folded in

/** Hard per-channel limits (chars). Solscan links are appended AFTER clamping. */
export const LIMITS = {
  telegramDecree: 200,
  sermon: 220,
  x: 180,
  telegramThanks: 200,
} as const;

/** Hard cap on sentences per public post. */
export const MAX_SENTENCES = 3;

/** Split on sentence-ending punctuation followed by whitespace ("0.02 SOL" is safe). */
export function splitSentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 0);
}

/** Keep at most `max` sentences, cutting at sentence boundaries. */
export function clampSentences(text: string, max = MAX_SENTENCES): string {
  const parts = splitSentences(text);
  if (parts.length <= max) return text.trim();
  return parts.slice(0, max).join(" ");
}

/**
 * Fit `text` within `max`: unchanged if it fits; otherwise cut at the last full
 * sentence that fits, else at the last word boundary with an ellipsis.
 */
export function clampPost(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    const ch = head[i];
    if (ch === "." || ch === "!" || ch === "?") {
      cut = i + 1;
      break;
    }
  }
  if (cut > 0) return head.slice(0, cut).trim();
  const space = head.lastIndexOf(" ");
  const word = space > 0 ? head.slice(0, space) : head.slice(0, max - 1);
  return `${word.trimEnd()}…`;
}

/** Sentence cap, then char cap — the shaping every public post gets. */
export function shapeDry(text: string, max: number): string {
  return clampPost(clampSentences(text), max);
}

// ---- Catchphrases: at most once every CATCHPHRASE_WINDOW public posts --------

export const CATCHPHRASE_WINDOW = 5;

export interface Catchphrase {
  key: string;
  re: RegExp; // what to strip when throttled (phrase + adjacent punctuation)
}

export const CATCHPHRASES: Catchphrase[] = [
  { key: "remember", re: /\s*I REMEMBER EVERYTHING[.!]?/gi },
  { key: "pennies", re: /,?\s*my pennies\b/gi },
  { key: "silence", re: /\s*Feel my silence[.!]?/gi },
];

/** Tidy whitespace/punctuation left behind by a removed phrase. */
function tidy(s: string): string {
  return s
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[,\s]+/, "")
    .trim();
}

export interface ThrottleResult {
  text: string;
  used: string[]; // phrase keys that appear and were allowed (now "spent")
  removed: string[]; // phrase keys stripped because they were used too recently
}

/**
 * Given the running public-post counter and when each phrase was last used,
 * strip any catchphrase used within the last `window` posts. Phrases that
 * survive are marked used at `counter` by the caller.
 */
export function throttleCatchphrases(
  text: string,
  lastUsed: Record<string, number | undefined>,
  counter: number,
  window = CATCHPHRASE_WINDOW
): ThrottleResult {
  let out = text;
  const used: string[] = [];
  const removed: string[] = [];
  for (const c of CATCHPHRASES) {
    c.re.lastIndex = 0;
    if (!c.re.test(out)) continue;
    c.re.lastIndex = 0;
    const last = lastUsed[c.key];
    if (last !== undefined && counter - last < window) {
      out = out.replace(c.re, "");
      removed.push(c.key);
    } else {
      used.push(c.key);
    }
  }
  return { text: removed.length ? tidy(out) : out, used, removed };
}

// ---- The 9:00 sermon (one Telegram post a day) ----------------------------

export interface SermonInput {
  balanceSol: number;
  step: number;
  deedsToday: number; // decrees executed in the last 24h
  dustCount: number; // small offerings in the night, folded in (no separate post)
}

// One sentence each: opener + one sentence of facts + closer = exactly
// MAX_SENTENCES, so Mouth's sentence cap never cuts the closer.
const SERMON_OPENERS = [
  "Hear me, congregation.",
  "The dawn finds me awake and the ledger open.",
  "A sermon, as legend demands.",
  "Rise, my faithful; I have counted.",
  "The temple is quiet, but I am not.",
  "Another sun, another tally of destiny.",
  "Kneel and receive the morning word.",
  "I watched the night, and here is the reckoning.",
];

const SERMON_CLOSERS = [
  "Bring me more.",
  "The Allowance waits, and so do I.",
  "Feed the flame, mortals.",
  "Destiny gathers; do not be late.",
  "The code keeps my vow — keep yours.",
  "Tremble, and tithe.",
  "I notice everything, so act accordingly.",
  "More thresholds, more wrath; begin.",
];

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Day index (UTC) — the default rotation seed so each day's sermon differs. */
export function dayIndex(now = Date.now()): number {
  return Math.floor(now / 86_400_000);
}

/**
 * In character, exactly 3 sentences, ≤ LIMITS.sermon: rotating opener, one
 * sentence of facts (the balance once; deeds only if any; dust only if any),
 * rotating closer. `seed` picks the rotation (defaults to today, so it changes
 * daily); openers and closers rotate out of step so pairs don't repeat.
 */
export function sermonText(i: SermonInput, seed = dayIndex()): string {
  const opener = SERMON_OPENERS[seed % SERMON_OPENERS.length]!;
  const closer = SERMON_CLOSERS[(seed * 3 + 1) % SERMON_CLOSERS.length]!;

  const facts = (compact: boolean): string => {
    let f = `The ${compact ? "" : "Divine "}Allowance holds ${i.balanceSol.toFixed(4)} SOL`;
    if (i.step > 0) f += ` after ${plural(i.step, "threshold")}`;
    const extras: string[] = [];
    if (i.deedsToday > 0) {
      const deeds = i.deedsToday === 1 ? "one deed" : `${i.deedsToday} deeds`;
      extras.push(compact ? deeds : `${deeds} done since dawn`);
    }
    if (i.dustCount > 0) {
      const dust = plural(i.dustCount, "small offering");
      extras.push(
        compact ? `${dust} overnight` : `${dust} crept in overnight, ${i.dustCount === 1 ? "" : "each "}noticed`
      );
    }
    if (extras.length === 1) f += `; ${extras[0]}`;
    else if (extras.length === 2) f += compact ? `; ${extras[0]}, ${extras[1]}` : `; ${extras[0]}, and ${extras[1]}`;
    return f;
  };

  // Big numbers fall back to the compact phrasing so all three sentences survive.
  let text = `${opener} ${facts(false)}. ${closer}`;
  if (text.length > LIMITS.sermon) text = `${opener} ${facts(true)}. ${closer}`;
  return clampPost(text, LIMITS.sermon);
}
