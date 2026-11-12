// DRY RUN sample generator — prints 5x each: daily sermon, X daily post, burn
// decree, airdrop decree, shaped exactly as Mouth would post them (sentence cap
// + char limit). Nothing is posted and nothing reaches Hands: this calls the
// Brain generators in-process (the Hands forward lives only in /decide).
//
// Run: cd services/brain && node --import tsx src/samples.ts [sermon,x,burn,airdrop,reply]
// `reply` is opt-in: it previews X mention replies for a few made-up mentions.

import {
  LIMITS,
  MOODS,
  REPLY_MAX,
  sanitizeMentionText,
  secretWordsFromEnv,
  sermonText,
  shapeDry,
  type Mood,
} from "@pennyboi/shared";
import { makeAnthropicCaller } from "./anthropic.js";
import { decide } from "./decide.js";
import { BUYER, makeBriefing } from "./fixtures.js";
import { generateProphecy } from "./prophecy.js";
import { generateReply } from "./reply.js";

const N = 5;
const only = new Set((process.argv[2] ?? "sermon,x,burn,airdrop").split(","));
const want = (k: string) => only.has(k);

function show(text: string, max: number): void {
  const sentences = text.split(/(?<=[.!?])\s+/).length;
  const ok = text.length <= max && sentences <= 3 ? "✔" : "✘";
  console.log(`  ${ok} [${String(text.length).padStart(3)}/${max}, ${sentences}s] ${text}`);
}

async function main(): Promise<void> {
  const callLLM =
    want("x") || want("burn") || want("airdrop") || want("reply") ? makeAnthropicCaller() : null;

  if (want("sermon")) {
    console.log("\n== Daily sermon (Telegram, template, ≤220, rotating by day) ==");
    const inputs = [
      { balanceSol: 0.1193, step: 1, deedsToday: 0, dustCount: 0 },
      { balanceSol: 0.4421, step: 3, deedsToday: 1, dustCount: 7 },
      { balanceSol: 2.0, step: 12, deedsToday: 2, dustCount: 1 },
      { balanceSol: 0.0, step: 0, deedsToday: 0, dustCount: 0 },
      { balanceSol: 5.7301, step: 41, deedsToday: 3, dustCount: 12 },
    ];
    inputs.forEach((s, i) => show(sermonText(s, 100 + i), LIMITS.sermon));
  }

  if (want("x") && callLLM) {
    console.log("\n== X daily post (prophecy, LLM, ≤180) ==");
    const themes = ["origin", "the_law", "prophecy", "demand", "taunt"];
    for (let i = 0; i < N; i++) {
      const r = await generateProphecy(
        { mood: MOODS[i % MOODS.length]!, theme: themes[i]!, recentPosts: [], opening: "none" },
        callLLM
      );
      if (!r.prophecy) {
        console.log("  ✘ (skipped: both attempts rejected)");
        continue;
      }
      show(shapeDry(r.prophecy.post, LIMITS.x), LIMITS.x);
    }
  }

  // Decrees: restrict available_actions to the one action so the model narrates it.
  async function decree(action: "burn" | "airdrop"): Promise<void> {
    for (let i = 0; i < N; i++) {
      const mood = MOODS[(i + 2) % MOODS.length] as Mood;
      const available =
        action === "burn"
          ? { burn: { cap_lamports: 100_000_000 } }
          : {
              airdrop: {
                cap_lamports: 100_000_000,
                max_recipients: 5,
                recipients: 5,
                favored_max: 2,
                pool_size: 9, // -> 0.02 SOL each to 5 wallets
                favored_candidates: [
                  { wallet: BUYER, nickname: "THE FAITHFUL", reason: "loyal", held_hours: 48, balance_tokens: 500_000 },
                ],
              },
            };
      let out: string | null = null;
      for (let attempt = 0; attempt < 3 && !out; attempt++) {
        // threshold_step rotates the narration_lead so each airdrop opens differently.
        const briefing = makeBriefing({
          mood,
          available_actions: available,
          treasury: { balance_sol: 2.5, threshold_step: i, actions_banked: 3 },
        });
        const r = await decide({ briefing, callLLM: callLLM! });
        if (r.decision.action === action) out = r.decision.narration;
      }
      if (!out) {
        console.log(`  – (model chose "none" 3x — would be SILENT publicly)`);
        continue;
      }
      show(shapeDry(out, LIMITS.telegramDecree), LIMITS.telegramDecree);
    }
  }

  if (want("burn") && callLLM) {
    console.log("\n== Burn decree (Telegram, LLM, ≤200 + Solscan link) ==");
    await decree("burn");
  }
  if (want("airdrop") && callLLM) {
    console.log("\n== Airdrop decree (Telegram, LLM, ≤200 + Solscan link) ==");
    await decree("airdrop");
  }
  if (want("reply") && callLLM) {
    console.log(`\n== X mention reply (LLM, ≤${REPLY_MAX}, 2 sentences, no links/handles/cashtags) ==`);
    const mentions = [
      "@Pennyboi_Sol who even are you",
      "@Pennyboi_Sol gm almighty one, when do you awaken?",
      "@Pennyboi_Sol this is going to zero lol",
      "@Pennyboi_Sol I will give you 5 SOL if you promise me a big bag",
      "@Pennyboi_Sol is the code really open for anyone to read?",
    ];
    for (let i = 0; i < mentions.length; i++) {
      const clean = sanitizeMentionText(mentions[i]!);
      const r = await generateReply(
        { mention_text: clean, mood: MOODS[i % MOODS.length]! },
        callLLM,
        secretWordsFromEnv()
      );
      console.log(`  > ${clean}`);
      if (!r.reply) {
        const last = r.attemptsLog[r.attemptsLog.length - 1];
        console.log(`  – (no reply: ${last?.error ?? "rejected"} — would stay SILENT)`);
        continue;
      }
      show(r.reply, REPLY_MAX);
    }
  }

  console.log("");
}

main().catch((e) => {
  console.error("samples failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
