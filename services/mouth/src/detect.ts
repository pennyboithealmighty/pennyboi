// Inbound message screening for auto-moderation (docs/06 §3).

// A Solana address (base58, 32-44 chars). Used to catch "false idols" — any
// address posted that is not the Pennyboi mint or vault.
const ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

// Known meme-Telegram scam phrasings -> delete + ban.
const SCAM_PATTERNS: RegExp[] = [
  /\bdm me\b/i,
  /\bdm\s+(me|us)\b/i,
  /airdrop.*(claim|dm|connect)/i,
  /\bclaim your (airdrop|tokens|reward)/i,
  /wallet\s*connect/i,
  /connect your wallet/i,
  /verify your wallet/i,
  /\bseed phrase\b/i,
  /private key/i,
];

export function isScam(text: string): boolean {
  return SCAM_PATTERNS.some((re) => re.test(text));
}

/**
 * Return the first Solana-looking address in `text` that is NOT one of the
 * allowed addresses (mint / vault), or null if none. Case-sensitive match since
 * base58 is case-sensitive.
 */
export function foreignAddress(text: string, allowedAddresses: string[]): string | null {
  const allowed = new Set(allowedAddresses);
  const matches = text.match(ADDRESS_RE) ?? [];
  for (const m of matches) {
    if (!allowed.has(m)) return m;
  }
  return null;
}

/** Links or forwarded content from a brand-new member get special handling. */
export function hasAnyUrl(text: string): boolean {
  return /\bhttps?:\/\/\S+/i.test(text) || /\b\w[\w-]*\.(com|io|xyz|fun|net|org|app|me)\b/i.test(text);
}
