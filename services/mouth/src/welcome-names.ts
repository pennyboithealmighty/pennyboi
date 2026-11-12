// Unique welcomes (TG_UNIQUE_WELCOME_ENABLED): a new member's display name and
// username are untrusted. safeDisplayName returns a plain name that is safe to
// show the Brain and to post, or null when the name is suspicious — in which
// case the member is greeted without it. Pure. (Brain re-checks the names it
// is sent with its own, simpler filter.)

import { looksLikeInjection, mentionsSecret, rejectReply } from "@pennyboi/shared";

export const NAME_MAX = 32;
const NAME_MAX_WORDS = 4;

const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;
const LINKISH_RE = /https?:\/\/|\bwww\.|\bt\.me\b|\b[a-z0-9-]+\.[a-z]{2,}\b/i;
const ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|\b0x[0-9a-fA-F]{6,}\b/;

// Names that claim authority or pose as a service. Scammers join as "Admin",
// "Support" or "Pennyboi Official"; none of them is ever greeted by that name.
// The unmistakable words match anywhere, even glued to other text
// ("PennyboiSupport", "official_help"); the short ones only as whole words.
const AUTHORITY_ANYWHERE_RE =
  /admin|support|official|moderator|helpdesk|pennyboi|almighty|telegram|metamask|binance|coinbase|airdrop|giveaway/i;
const AUTHORITY_WORD_RE =
  /\b(mod|mods|owner|staff|team|dev|devs|developer|founder|ceo|help desk|service|security|verif\w*|customer|agent|manager|recover\w*|bot|claim\w*|wallet|phantom)\b/i;

function claimsAuthority(s: string): boolean {
  // Separators and digits are how these names dodge a word match.
  const probe = s.replace(/[_\-.\d]+/g, " ");
  return AUTHORITY_ANYWHERE_RE.test(probe.replace(/\s+/g, "")) || AUTHORITY_WORD_RE.test(probe);
}

/**
 * A display name reduced to letters, digits, spaces and . ' - only, or null if
 * it carries a link, a handle, a symbol tag, an address, an instruction, an
 * authority claim or a secret word, or is too long or not really a name.
 */
export function safeDisplayName(raw: string | null | undefined, secretWords: string[] = []): string | null {
  const s = String(raw ?? "").replace(ZERO_WIDTH_RE, "").replace(CONTROL_RE, " ").trim();
  if (!s) return null;
  if (LINKISH_RE.test(s) || ADDRESS_RE.test(s)) return null;
  if (/[@$#]/.test(s)) return null;
  if (looksLikeInjection(s) || claimsAuthority(s)) return null;
  if (mentionsSecret(s, secretWords)) return null;

  const clean = s.replace(/[^\p{L}\p{N} .'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (clean.length < 2 || clean.length > NAME_MAX) return null;
  if (!/\p{L}/u.test(clean)) return null;
  if (clean.split(" ").length > NAME_MAX_WORDS) return null;
  // A name the outbound guard would reject can never be posted, so drop it now.
  if (!rejectReply(`Welcome, ${clean}`, { secretWords }).ok) return null;
  return clean;
}

/**
 * The name to greet a member by. A suspicious display name means no name at
 * all: the username is not tried instead. The username is used only when there
 * is no display name, and only if it is already plain.
 */
export function safeMemberName(
  member: { firstName?: string; username?: string },
  secretWords: string[] = []
): string | null {
  if (member.firstName && member.firstName.trim() !== "") return safeDisplayName(member.firstName, secretWords);
  const fromUsername = safeDisplayName(member.username, secretWords);
  return fromUsername !== null && fromUsername === member.username ? fromUsername : null;
}

/** "Ana", "Ana and Bo", "Ana, Bo and Cy", "Ana, Bo, Cy and 4 others". Null when nobody is named. */
export function joinNames(names: string[], total: number, show = 3): string | null {
  const shown = names.slice(0, show);
  if (shown.length === 0) return null;
  const others = total - shown.length;
  if (others > 0) return `${shown.join(", ")} and ${others} other${others === 1 ? "" : "s"}`;
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}
