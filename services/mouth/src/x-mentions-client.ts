// The X calls behind mention replies: read mentions, post a reply, look up the
// bot's own user id. Its own client, deliberately separate from XPoster, so
// the once-a-day post path is not touched by this feature.

import { ApiResponseError, TwitterApi, type TweetV2 } from "twitter-api-v2";
import type { MouthConfig } from "./config.js";
import type { Logger } from "./log.js";
import { MentionsApiError, type MentionsClient, type MentionsPage, type RawMention } from "./x-mentions.js";

function toRawMention(t: TweetV2): RawMention {
  return {
    id: t.id,
    text: t.text ?? "",
    authorId: t.author_id ?? "",
    createdAt: t.created_at,
    inReplyToUserId: t.in_reply_to_user_id,
    referenced: (t.referenced_tweets ?? []).map((r) => ({ type: r.type, id: r.id })),
    urls: (t.entities?.urls ?? []).map((u) => u.expanded_url || u.unwound_url || u.url).filter(Boolean),
    mentionCount: t.entities?.mentions?.length ?? (t.text?.match(/@\w+/g) ?? []).length,
    cashtagCount: t.entities?.cashtags?.length ?? (t.text?.match(/\$[A-Za-z]\w*/g) ?? []).length,
  };
}

function toApiError(e: unknown): MentionsApiError {
  if (e instanceof ApiResponseError) {
    return new MentionsApiError(e.message, e.code, e.rateLimitError, e.rateLimit?.reset);
  }
  return new MentionsApiError(e instanceof Error ? e.message : String(e), undefined, false);
}

export class XMentionsClient implements MentionsClient {
  private client: TwitterApi | null = null;

  constructor(cfg: MouthConfig, log: Logger) {
    const x = cfg.x;
    const haveKeys = x.apiKey && x.apiSecret && x.accessToken && x.accessSecret;
    if (x.mode !== "off" && haveKeys) {
      this.client = new TwitterApi({
        appKey: x.apiKey,
        appSecret: x.apiSecret,
        accessToken: x.accessToken,
        accessSecret: x.accessSecret,
      });
    } else if (cfg.mentions.enabled) {
      log.warn("mentions: enabled, but X_MODE=off or X credentials are incomplete.");
    }
  }

  get ready(): boolean {
    return this.client !== null;
  }

  async getBotUserId(): Promise<string | null> {
    if (!this.client) return null;
    try {
      const me = await this.client.v2.me();
      return me.data?.id ?? null;
    } catch (e) {
      throw toApiError(e);
    }
  }

  /** One page only, newest first. No author expansion: it could bill as user reads. */
  async fetchMentions(
    userId: string,
    opts: { sinceId?: string; startTime?: string; maxResults: number }
  ): Promise<MentionsPage> {
    if (!this.client) return { mentions: [], newestId: null };
    try {
      const page = await this.client.v2.userMentionTimeline(userId, {
        max_results: opts.maxResults,
        ...(opts.sinceId ? { since_id: opts.sinceId } : {}),
        ...(opts.startTime ? { start_time: opts.startTime } : {}),
        "tweet.fields": ["author_id", "created_at", "in_reply_to_user_id", "referenced_tweets", "entities"],
      });
      const tweets = page.tweets ?? [];
      const meta = page.meta as { newest_id?: string } | undefined;
      return { mentions: tweets.map(toRawMention), newestId: meta?.newest_id ?? null };
    } catch (e) {
      throw toApiError(e);
    }
  }

  async reply(text: string, toTweetId: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.v2.reply(text, toTweetId);
      return res.data?.id ?? null;
    } catch (e) {
      throw toApiError(e);
    }
  }
}
