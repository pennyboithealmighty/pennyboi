// X (Twitter) poster via the official v2 API. Disabled unless X_ENABLED and all
// four OAuth 1.0a user credentials are present.

import { TwitterApi } from "twitter-api-v2";
import type { MouthConfig } from "./config.js";
import type { Logger } from "./log.js";

export class XPoster {
  private client: TwitterApi | null = null;
  private enabled: boolean;

  constructor(private cfg: MouthConfig, private log: Logger) {
    const x = cfg.x;
    const haveKeys =
      x.apiKey && x.apiSecret && x.accessToken && x.accessSecret;
    this.enabled = x.enabled && Boolean(haveKeys);
    if (this.enabled) {
      this.client = new TwitterApi({
        appKey: x.apiKey,
        appSecret: x.apiSecret,
        accessToken: x.accessToken,
        accessSecret: x.accessSecret,
      });
    } else if (x.enabled) {
      this.log.warn("X_ENABLED but credentials incomplete — X posting disabled.");
    }
  }

  async post(text: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.v2.tweet(text.slice(0, 280));
      this.log.info("posted to X");
    } catch (e) {
      this.log.error("X post failed", e);
    }
  }
}
