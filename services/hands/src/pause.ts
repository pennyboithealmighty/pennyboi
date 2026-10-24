// Kill switch. Initialized from ACTIONS_PAUSED; flipped at runtime by the
// owner's Telegram /pause and /resume (Mouth calls the /pause, /resume HTTP
// endpoints). When paused, Hands submits nothing on-chain.

import { envBool } from "@pennyboi/shared";

let paused = envBool("ACTIONS_PAUSED", false);

export function isPaused(): boolean {
  return paused;
}
export function setPaused(v: boolean): void {
  paused = v;
}
