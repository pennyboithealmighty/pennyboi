// Polling fallback: used when no Helius key is configured. Periodically asks the
// tracker to re-read chain state so threshold crossings are still noticed.

import type { ThresholdTracker } from "./tracker.js";
import type { Logger } from "./log.js";

export function startPoller(
  tracker: ThresholdTracker,
  intervalSecs: number,
  log: Logger
): NodeJS.Timeout {
  log.info(`polling fallback every ${intervalSecs}s`);
  return setInterval(() => void tracker.check(), Math.max(5, intervalSecs) * 1000);
}
