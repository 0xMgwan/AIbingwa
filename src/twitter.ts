import { Scraper } from "agent-twitter-client";

// ============================================================
// TWITTER CLIENT — Autonomous agent tweeting & engagement
// ============================================================

export class TwitterClient {
  private scraper: Scraper | null = null;
  private initialized = false;

  constructor() {
    const consumerKey = process.env.X_CONSUMER_KEY;
    const consumerSecret = process.env.X_CONSUMER_SECRET;
    const accessToken = process.env.X_ACCESS_TOKEN;
    const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;

    if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
      console.log("ℹ️ No X credentials — Twitter integration disabled");
      return;
    }

    try {
      this.scraper = new Scraper({
        auth: {
          username: process.env.X_USERNAME || "",
          password: process.env.X_PASSWORD || "",
          email: process.env.X_EMAIL || "",
        },
      });
      this.initialized = true;
      console.log("🐦 Twitter client initialized");
    } catch (err: any) {
      console.warn("⚠️ Twitter init failed:", err.message);
    }
  }

  isAvailable(): boolean {
    return this.initialized && !!this.scraper;
  }

  async tweet(text: string): Promise<{ success: boolean; tweetId?: string; error?: string }> {
    if (!this.scraper) {
      return { success: false, error: "Twitter client not initialized" };
    }

    try {
      // Validate tweet length (280 chars max)
      if (text.length > 280) {
        return { success: false, error: `Tweet too long (${text.length}/280 chars)` };
      }

      const result = await this.scraper.sendTweet(text);
      console.log(`🐦 Tweet posted: ${text.slice(0, 50)}...`);
      return { success: true, tweetId: result };
    } catch (err: any) {
      console.error("❌ Tweet failed:", err.message);
      return { success: false, error: err.message };
    }
  }

  async tweetWithImage(text: string, imagePath: string): Promise<{ success: boolean; tweetId?: string; error?: string }> {
    if (!this.scraper) {
      return { success: false, error: "Twitter client not initialized" };
    }

    try {
      if (text.length > 280) {
        return { success: false, error: `Tweet too long (${text.length}/280 chars)` };
      }

      // Note: agent-twitter-client may not support image uploads directly
      // This is a placeholder for future enhancement
      const result = await this.scraper.sendTweet(text);
      console.log(`🐦 Tweet with image posted: ${text.slice(0, 50)}...`);
      return { success: true, tweetId: result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async replyToTweet(tweetId: string, text: string): Promise<{ success: boolean; replyId?: string; error?: string }> {
    if (!this.scraper) {
      return { success: false, error: "Twitter client not initialized" };
    }

    try {
      if (text.length > 280) {
        return { success: false, error: `Reply too long (${text.length}/280 chars)` };
      }

      const result = await this.scraper.sendTweet(text, tweetId);
      console.log(`🐦 Reply posted to ${tweetId}`);
      return { success: true, replyId: result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async quoteTweet(tweetId: string, text: string): Promise<{ success: boolean; quoteId?: string; error?: string }> {
    if (!this.scraper) {
      return { success: false, error: "Twitter client not initialized" };
    }

    try {
      if (text.length > 280) {
        return { success: false, error: `Quote too long (${text.length}/280 chars)` };
      }

      // Quote tweet as reply with link
      const tweetUrl = `https://twitter.com/i/web/status/${tweetId}`;
      const fullText = `${text}\n\n${tweetUrl}`;

      if (fullText.length > 280) {
        return { success: false, error: "Quote text + link exceeds 280 chars" };
      }

      const result = await this.scraper.sendTweet(fullText);
      console.log(`🐦 Quote tweet posted`);
      return { success: true, quoteId: result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async likeTweet(tweetId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.scraper) {
      return { success: false, error: "Twitter client not initialized" };
    }

    try {
      await this.scraper.likeTweet(tweetId);
      console.log(`❤️ Liked tweet ${tweetId}`);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async retweetTweet(tweetId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.scraper) {
      return { success: false, error: "Twitter client not initialized" };
    }

    try {
      await this.scraper.retweetTweet(tweetId);
      console.log(`🔄 Retweeted ${tweetId}`);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getTweet(tweetId: string): Promise<any> {
    if (!this.scraper) {
      return null;
    }

    try {
      const tweet = await this.scraper.getTweet(tweetId);
      return tweet;
    } catch (err: any) {
      console.error("Failed to fetch tweet:", err.message);
      return null;
    }
  }

  async searchTweets(query: string, maxResults: number = 10): Promise<any[]> {
    if (!this.scraper) {
      return [];
    }

    try {
      const tweets: any[] = [];
      let count = 0;

      for await (const tweet of this.scraper.searchTweets(query, maxResults)) {
        tweets.push(tweet);
        count++;
        if (count >= maxResults) break;
      }

      return tweets;
    } catch (err: any) {
      console.error("Search failed:", err.message);
      return [];
    }
  }
}
