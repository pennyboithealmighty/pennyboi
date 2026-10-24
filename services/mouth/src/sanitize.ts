// Outbound URL allowlist (docs/06 §8): every message Pennyboi sends passes
// through here, so he can never post a link that isn't Solscan, the Pump.fun
// page, the GitHub repo, or the group itself.

const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** True if `text` contains any http(s) URL whose host is not allowed. */
export function hasDisallowedUrl(text: string, allowedHosts: string[]): boolean {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const urls = text.match(URL_RE) ?? [];
  return urls.some((u) => {
    const h = hostOf(u);
    return !h || !allowed.has(h);
  });
}

/** Remove any http(s) URL whose host isn't allowed; collapses leftover spaces. */
export function stripDisallowedUrls(text: string, allowedHosts: string[]): string {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  return text
    .replace(URL_RE, (u) => {
      const h = hostOf(u);
      return h && allowed.has(h) ? u : "[link removed]";
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
