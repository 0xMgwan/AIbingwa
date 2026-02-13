import { TwitterApi } from "twitter-api-v2";

// ============================================================
// TWITTER CLIENT — Official X API v2 with OAuth 1.0a
// ============================================================

export class TwitterClient {
  private client: TwitterApi | null = null;
  private initialized = false;

  constructor() {
    const appKey = process.env.X_CONSUMER_KEY;
    const appSecret = process.env.X_CONSUMER_SECRET;
    const accessToken = process.env.X_ACCESS_TOKEN;
    const accessSecret = process.env.X_ACCESS_TOKEN_SECRET;

    if (!appKey || !appSecret || !accessToken || !accessSecret) {
      console.log("ℹ️ No X credentials — Twitter integration disabled");
      return;
    }

    try {
      this.client = new TwitterApi({
        appKey,
        appSecret,
        accessToken,
        accessSecret,
      });
      this.initialized = true;
      console.log("🐦 Twitter client initialized (X API v2)");
    } catch (err: any) {
      console.warn("⚠️ Twitter init failed:", err.message);
    }
  }

  isAvailable(): boolean {
    return this.initialized && !!this.client;
  }

  async tweet(text: string): Promise<{ success: boolean; tweetId?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: "Twitter client not initialized" };
    }

    try {
      if (text.length > 280) {
        return { success: false, error: `Tweet too long (${text.length}/280 chars)` };
      }

      const result = await this.client.v2.tweet(text);
      console.log(`🐦 Tweet posted (${result.data.id}): ${text.slice(0, 50)}...`);
      return { success: true, tweetId: result.data.id };
    } catch (err: any) {
      console.error("❌ Tweet failed:", err.message);
      return { success: false, error: err.message };
    }
  }

  async replyToTweet(tweetId: string, text: string): Promise<{ success: boolean; replyId?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: "Twitter client not initialized" };
    }

    try {
      if (text.length > 280) {
        return { success: false, error: `Reply too long (${text.length}/280 chars)` };
      }

      const result = await this.client.v2.reply(text, tweetId);
      console.log(`🐦 Reply posted to ${tweetId}`);
      return { success: true, replyId: result.data.id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async quoteTweet(tweetUrl: string, text: string): Promise<{ success: boolean; quoteId?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: "Twitter client not initialized" };
    }

    try {
      if (text.length > 280) {
        return { success: false, error: `Quote too long (${text.length}/280 chars)` };
      }

      const result = await this.client.v2.tweet({
        text,
        quote_tweet_id: tweetUrl,
      });
      console.log(`🐦 Quote tweet posted`);
      return { success: true, quoteId: result.data.id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async likeTweet(tweetId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: "Twitter client not initialized" };
    }

    try {
      const me = await this.client.v2.me();
      await this.client.v2.like(me.data.id, tweetId);
      console.log(`❤️ Liked tweet ${tweetId}`);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async retweet(tweetId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: "Twitter client not initialized" };
    }

    try {
      const me = await this.client.v2.me();
      await this.client.v2.retweet(me.data.id, tweetId);
      console.log(`🔄 Retweeted ${tweetId}`);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getMe(): Promise<{ success: boolean; username?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: "Twitter client not initialized" };
    }

    try {
      const me = await this.client.v2.me();
      return { success: true, username: me.data.username };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
