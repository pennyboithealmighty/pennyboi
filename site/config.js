// Pennyboi site config — the ONE file edited at launch. Every link, badge, and
// live panel on the site reads from here. Served as a plain global (no build).
window.PENNYBOI_CONFIG = {
  // Chain
  PROGRAM_ID: "GC7kdK4aEX9YsYSpiZ4VFJDw6Q8MtAPQgqjEjpSnVrac",
  RPC_URL: "https://api.devnet.solana.com",
  NETWORK: "devnet", // "devnet" | "mainnet"

  // Offerings (docs/12). FEE_RECEIVER is the vault's Fees PDA — SOL only, never
  // tokens. OFFERING_PAGE_PUBLIC stays false on devnet: the page works for
  // testing but the "Make an Offering" button is hidden and the page is noindex.
  FEE_RECEIVER: "BE9JGfN1sYc4HnHFiEaUKPCntvjz8Hkv7Jk2yehNfiBa",
  OFFERING_PAGE_PUBLIC: false,

  // Public read-only API (Mouth /public/*). Set to the Cloudflare Tunnel URL
  // once it's up; empty => the home-page live panels show "the oracle is silent".
  API_BASE: "https://api.pennyboi.com",

  // Links — each hidden on the site when null.
  PUMPFUN_URL: null,
  CONTRACT_ADDRESS: null, // the mint; shown only once set. "Any other address is a false idol."
  TELEGRAM_URL: "https://t.me/pennyboialmighty",
  X_URL: "https://x.com/Pennyboi_Sol",
  GITHUB_URL: "https://github.com/pennyboithealmighty/pennyboi",

  // Countdown. ISO date (e.g. "2026-11-01T00:00:00Z") or null.
  LAUNCH_DATE: null,
};
