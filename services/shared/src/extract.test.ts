import test from "node:test";
import assert from "node:assert/strict";
import { extractMemory, narrationReferences } from "./extract.js";
import type { Briefing } from "./briefing.js";

const BUYER = "So11111111111111111111111111111111111111112";
const SELLER = "Vote111111111111111111111111111111111111111";

function briefing(over: Partial<Briefing["since_last_threshold"]> = {}): Briefing {
  return {
    mood: "petty",
    treasury: { balance_sol: 2, threshold_step: 1 },
    available_actions: {},
    since_last_threshold: {
      top_new_buyers: [{ wallet: BUYER, sol_in: 1 }],
      biggest_sellers: [{ wallet: SELLER, sol_out: 1 }],
      volume_sol: 2,
      holder_count_change: 0,
      ...over,
    },
    offerings_from_telegram: [],
    your_last_actions: [],
    grudges: [],
    loyal: [],
  };
}

test("airdrop recipients become loyal (deterministic)", () => {
  const u = extractMemory(
    { action: "airdrop", params: { recipients: [BUYER], amounts: [1] }, narration: "BLESSED" },
    briefing()
  );
  assert.ok(u.loyal.some((l) => l.wallet === BUYER));
  assert.ok(u.seen.includes(BUYER));
});

test("bounty target becomes loyal", () => {
  const u = extractMemory(
    { action: "bounty", params: { to: BUYER, amount_lamports: 1, memo: "gm" }, narration: "funded" },
    briefing()
  );
  assert.ok(u.loyal.some((l) => l.wallet === BUYER && /offering/.test(l.reason)));
});

test("narration naming a seller (truncated) yields a grudge", () => {
  const trunc = SELLER.slice(0, 6);
  const u = extractMemory(
    { action: "none", params: {}, narration: `Wallet ${trunc}… you have FORSAKEN me. I remember.` },
    briefing()
  );
  assert.ok(u.grudges.some((g) => g.wallet === SELLER), "seller should get a grudge");
});

test("a coined nickname attaches when one wallet is referenced", () => {
  const u = extractMemory(
    {
      action: "airdrop",
      params: { recipients: [BUYER], amounts: [1] },
      narration: `${BUYER} you shall be known as THE FAITHFUL.`,
    },
    briefing()
  );
  const entry = u.loyal.find((l) => l.wallet === BUYER);
  assert.equal(entry?.nickname, "THE FAITHFUL");
});

test("narrationReferences matches full and truncated forms", () => {
  assert.equal(narrationReferences(`gm ${BUYER}`, BUYER), true);
  assert.equal(narrationReferences(`${BUYER.slice(0, 6)}... is loyal`, BUYER), true);
  assert.equal(narrationReferences("no wallet here", BUYER), false);
});

test("no briefing -> only action-derived updates", () => {
  const u = extractMemory({ action: "none", params: {}, narration: "I sulk." });
  assert.deepEqual(u, { seen: [], loyal: [], grudges: [] });
});
