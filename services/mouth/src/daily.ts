// Daily sermon in #general + owner digest DM (docs/06 §2E, §7), at DAILY_HOUR.

import { sendSafe } from "./announce.js";
import type { MouthCtx } from "./deps.js";
import * as P from "./personality.js";

function msUntilNextHour(hour: number, now = new Date()): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

async function runDaily(m: MouthCtx): Promise<void> {
  const s = await m.chain.treasuryStatus().catch(() => null);
  const actions = m.db.lastActions(10);
  const now = Math.floor(Date.now() / 1000);
  const actionsToday = actions.filter((a) => now - a.ts < 86_400).length;

  // Public sermon.
  const sermon = P.sermon({
    balanceSol: s?.balanceSol ?? 0,
    step: s?.step ?? 0,
    actionsToday,
  });
  await sendSafe(m, sermon, { threadId: m.cfg.topics.general });

  // Owner digest (private).
  if (m.cfg.ownerId) {
    const digest = [
      "DAILY DIGEST",
      s ? `treasury ${s.balanceSol.toFixed(4)} SOL, step ${s.step}` : "treasury: (not deployed)",
      `actions (24h): ${actionsToday}`,
      `muted ${m.db.mutedCount(now)}, banned ${m.db.bannedCount()}`,
      `quote: "${sermon.slice(0, 120)}"`,
    ].join("\n");
    try {
      await m.bot.api.sendMessage(m.cfg.ownerId, digest);
    } catch (e) {
      m.log.warn("owner digest DM failed", e);
    }
  }
}

export function startDailySchedule(m: MouthCtx): void {
  const delay = msUntilNextHour(m.cfg.dailyHour);
  m.log.info(`daily sermon/digest scheduled in ${Math.round(delay / 60000)} min`);
  setTimeout(() => {
    void runDaily(m);
    setInterval(() => void runDaily(m), 24 * 3600 * 1000);
  }, delay);
}
