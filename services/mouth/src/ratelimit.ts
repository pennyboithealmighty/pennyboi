// Per-topic reaction rate limiter + "quiet hours" (docs/06 §2B, §5 /quiet).
// Pennyboi replies to a given topic at most once per `baseIntervalMs`; while
// quiet mode is active the effective interval is multiplied so he calms down.

export class ReplyRateLimiter {
  private lastReply = new Map<number, number>(); // topicId -> ms
  private quietUntil = 0;
  private quietFactor: number;
  private baseIntervalMs: number;

  constructor(baseIntervalSecs: number, quietFactor = 4) {
    this.baseIntervalMs = baseIntervalSecs * 1000;
    this.quietFactor = quietFactor;
  }

  /** Reduce reply rate until `untilMs`. */
  setQuietUntil(untilMs: number): void {
    this.quietUntil = untilMs;
  }

  isQuiet(now: number): boolean {
    return now < this.quietUntil;
  }

  private interval(now: number): number {
    return this.isQuiet(now) ? this.baseIntervalMs * this.quietFactor : this.baseIntervalMs;
  }

  /** May Pennyboi reply in this topic right now? Records the reply if yes. */
  allow(topicId: number, now: number = Date.now()): boolean {
    const last = this.lastReply.get(topicId) ?? -Infinity;
    if (now - last < this.interval(now)) return false;
    this.lastReply.set(topicId, now);
    return true;
  }
}
