// X (Twitter) poster via the official v2 API. Active unless X_MODE=off and when
// all four OAuth 1.0a user credentials are present. POST /2/tweets (write)
// requires at least the Basic tier on the X API. Rate-limit errors are caught
// and logged, never crash.

import { TwitterApi } from "twitter-api-v2";
import type { MouthConfig } from "./config.js";
import type { Logger } from "./log.js";

export class XPoster {
  private client: TwitterApi | null = null;

  constructor(private cfg: MouthConfig, private log: Logger) {
    const x = cfg.x;
    const haveKeys = x.apiKey && x.apiSecret && x.accessToken && x.accessSecret;
    if (x.mode !== "off" && haveKeys) {
      this.client = new TwitterApi({
        appKey: x.apiKey,
        appSecret: x.apiSecret,
        accessToken: x.accessToken,
        accessSecret: x.accessSecret,
      });
    } else if (x.mode !== "off") {
      this.log.warn(`X_MODE=${x.mode} but credentials incomplete — X posting disabled.`);
    }
  }

  get ready(): boolean {
    return this.client !== null;
  }

  /** Post a tweet; returns the tweet id, or null if disabled/failed. */
  async post(text: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.v2.tweet(text.slice(0, 280));
      this.log.info(`posted to X (${res.data.id})`);
      return res.data.id;
    } catch (e) {
      this.log.error("X post failed", e);
      return null;
    }
  }
}
