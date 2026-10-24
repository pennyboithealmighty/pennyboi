// Pure logic for the X pre-launch "Prophecy" feed (docs/09): the outbound
// sanitizer, link policy, theme rotation, and day-slot planner. No I/O here so
// it's all unit-testable.

export const PROPHECY_THEMES = [
  "origin",
  "the_law",
  "prophecy",
  "demand",
  "taunt",
  "countdown",
] as const;
export type ProphecyTheme = (typeof PROPHECY_THEMES)[number];

const ALLOWED_DOMAIN = "pennyboi.com";
const DOMAIN_RE = /\b[a-z0-9-]+\.[a-z]{2,}\b/gi; // dotted token with a letter TLD
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/; // address / tx signature shape
const FORBIDDEN_WORDS = /\b(devnet|solscan|pumpfun|telegram|contract)\b/i;
const NUMBER_SOL_RE = /\d[\d.,]*\s*sol\b/i; // "0.1 SOL" — no fake treasury facts
const MENTION_RE = /@\w+/;

export type SanitizeResult = { ok: true } | { ok: false; reason: string };

/** Reject (don't post) if the text breaks any prelaunch rule (docs/09 §3). */
export function rejectProphecy(text: string): SanitizeResult {
  for (const m of text.match(DOMAIN_RE) ?? []) {
    if (m.toLowerCase() !== ALLOWED_DOMAIN) return { ok: false, reason: `disallowed domain/link: ${m}` };
  }
  if (BASE58_RE.test(text)) return { ok: false, reason: "contains a base58 address/signature" };
  const word = text.match(FORBIDDEN_WORDS);
  if (word) return { ok: false, reason: `forbidden word: ${word[0]}` };
  if (/CA:/i.test(text)) return { ok: false, reason: "contains 'CA:'" };
  if (/0x/i.test(text)) return { ok: false, reason: "contains '0x'" };
  if (NUMBER_SOL_RE.test(text)) return { ok: false, reason: "contains a number followed by SOL" };
  if (MENTION_RE.test(text)) return { ok: false, reason: "contains an @ mention" };
  return { ok: true };
}

/** Link policy (docs/09 §4): ~`rate` of posts, never the first of the day,
 *  never more than once per day. */
export function shouldAppendLink(args: {
  isFirstOfDay: boolean;
  linkedToday: boolean;
  rate: number;
  rng?: () => number;
}): boolean {
  if (args.isFirstOfDay || args.linkedToday) return false;
  return (args.rng ?? Math.random)() < args.rate;
}

/** Round-robin theme; `countdown` only when a launch date is set, else prophecy. */
export function themeAt(index: number, hasLaunchDate: boolean): ProphecyTheme {
  const t = PROPHECY_THEMES[index % PROPHECY_THEMES.length]!;
  if (t === "countdown" && !hasLaunchDate) return "prophecy";
  return t;
}

/**
 * Plan today's post times (ms epoch): `postsPerDay` jittered slots within the
 * [hoursStart, hoursEnd] local window, each at least `minGapHours` apart.
 */
export function planDaySlots(args: {
  dayStartMs: number; // local midnight of the day
  postsPerDay: number;
  hoursStart: number;
  hoursEnd: number;
  minGapHours?: number;
  rng?: () => number;
}): number[] {
  const { dayStartMs, postsPerDay, hoursStart, hoursEnd } = args;
  const rng = args.rng ?? Math.random;
  const minGapMs = (args.minGapHours ?? 3) * 3_600_000;
  if (postsPerDay <= 0) return [];

  const winStart = dayStartMs + hoursStart * 3_600_000;
  const winEnd = dayStartMs + hoursEnd * 3_600_000;
  const seg = (winEnd - winStart) / postsPerDay;

  const slots: number[] = [];
  let prev = -Infinity;
  for (let i = 0; i < postsPerDay; i++) {
    const segStart = winStart + i * seg;
    let t = segStart + rng() * seg;
    if (t < prev + minGapMs) t = prev + minGapMs;
    if (t > winEnd) t = winEnd;
    slots.push(Math.round(t));
    prev = t;
  }
  return slots;
}
