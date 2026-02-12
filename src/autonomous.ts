import {
  AgentMemory,
  TradeEntry,
  loadMemory,
  saveMemory,
  logTrade,
  closeTrade,
  updateTokenMemory,
  getOpenPositions,
} from "./memory.js";

// ============================================================
// TYPES
// ============================================================
type BankrPromptFn = (prompt: string, threadId?: string) => Promise<{
  success: boolean;
  jobId: string;
  threadId?: string;
  status: string;
  response?: string;
  error?: string;
}>;

type TelegramNotifyFn = (message: string) => Promise<void>;

interface TokenCandidate {
  name: string;
  symbol: string;
  price: string;
  marketCap: number;
  volume24h: string;
  change24h: string;
  score: number;
  reason: string;
}

// ============================================================
// AUTONOMOUS TRADING ENGINE
// ============================================================
export class AutonomousTrader {
  private memory: AgentMemory;
  private bankrPrompt: BankrPromptFn;
  private notify: TelegramNotifyFn;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private isScanning = false;
  private isMonitoring = false;

  constructor(bankrPrompt: BankrPromptFn, notify: TelegramNotifyFn) {
    this.memory = loadMemory();
    this.bankrPrompt = bankrPrompt;
    this.notify = notify;
  }

  // ── START / STOP ─────────────────────────────────────────
  start(): void {
    const scanMs = this.memory.settings.scanIntervalMin * 60 * 1000;
    const monitorMs = 5 * 60 * 1000; // Check positions every 5 min

    console.log(`🤖 Autonomous trader started (scan every ${this.memory.settings.scanIntervalMin}min)`);
    console.log(`   Auto-trade: ${this.memory.settings.autoTradeEnabled ? "ON" : "OFF"}`);
    console.log(`   Max mcap: $${this.memory.settings.maxMarketCap}`);
    console.log(`   Buy amount: $${this.memory.settings.maxBuyAmount}`);

    // No auto-scan on startup — use /scan manually or wait for the periodic timer
    // Periodic market scan (first scan after the interval, not immediately)
    this.scanTimer = setInterval(() => {
      this.scanMarket().catch(err => console.error("Scan error:", err));
    }, scanMs);

    // Periodic position monitoring
    this.monitorTimer = setInterval(() => {
      this.monitorPositions().catch(err => console.error("Monitor error:", err));
    }, monitorMs);
  }

  stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    console.log("🛑 Autonomous trader stopped");
  }

  getMemory(): AgentMemory {
    return this.memory;
  }

  reloadMemory(): void {
    this.memory = loadMemory();
  }

  // ── MARKET SCANNING ──────────────────────────────────────
  async scanMarket(): Promise<string> {
    if (this.isScanning) return "Scan already in progress...";
    this.isScanning = true;

    try {
      console.log("🔍 Autonomous scan: searching for low-cap gems...");
      const maxCap = this.memory.settings.maxMarketCap;
      const capStr = (maxCap / 1000).toFixed(0);

      // Step 1: Ask Bankr for trending low-cap tokens
      const scanResult = await this.bankrPrompt(
        `Find me new and trending tokens on Base with a market cap under $${maxCap}. ` +
        `For each token, provide: name, symbol/ticker, current price, market cap, 24h volume, and 24h price change. ` +
        `Focus on tokens with real volume (>$500 24h), not dead tokens. ` +
        `List up to 10 tokens, sorted by volume. Format as a numbered list.`
      );

      if (!scanResult.success) {
        console.log("⚠️ Scan failed:", scanResult.error);
        this.isScanning = false;
        return `Scan failed: ${scanResult.error}`;
      }

      const scanResponse = scanResult.response || "";
      this.memory.lastScanTime = Date.now();
      saveMemory(this.memory);

      // Step 2: Research top candidates
      const candidates = await this.researchCandidates(scanResponse);

      if (candidates.length === 0) {
        console.log("📭 No viable candidates found this scan");
        this.isScanning = false;
        return "No viable candidates found under $" + capStr + "k mcap";
      }

      // Step 3: Score and filter
      const viable = candidates.filter(c => c.score >= 60);

      // Step 4: Build report
      let report = `🔍 *Market Scan Complete*\n\n`;
      report += `Found ${candidates.length} tokens under $${capStr}k mcap\n`;
      report += `${viable.length} scored 60+ (viable)\n\n`;

      for (const c of candidates.slice(0, 5)) {
        const emoji = c.score >= 70 ? "🟢" : c.score >= 50 ? "🟡" : "🔴";
        report += `${emoji} *${c.symbol}* — Score: ${c.score}/100\n`;
        report += `   Price: ${c.price} | MCap: $${c.marketCap.toLocaleString()}\n`;
        report += `   Vol: ${c.volume24h} | 24h: ${c.change24h}\n`;
        report += `   ${c.reason}\n\n`;
      }

      // Step 5: Auto-trade if enabled
      if (this.memory.settings.autoTradeEnabled && viable.length > 0) {
        const openPositions = getOpenPositions(this.memory);
        const slotsAvailable = this.memory.settings.maxOpenPositions - openPositions.length;

        if (slotsAvailable > 0) {
          const toBuy = viable.slice(0, slotsAvailable);
          report += `\n🎯 *Auto-buying ${toBuy.length} token(s):*\n`;

          for (const token of toBuy) {
            const buyResult = await this.executeBuy(token);
            report += `${buyResult}\n`;
          }
        } else {
          report += `\n⚠️ Max open positions (${this.memory.settings.maxOpenPositions}) reached. Skipping buys.`;
        }
      } else if (!this.memory.settings.autoTradeEnabled && viable.length > 0) {
        report += `\n💡 Auto-trade is OFF. Use /autotrade on to enable.\n`;
        report += `Or manually: /snipe $${this.memory.settings.maxBuyAmount} <token>`;
      }

      // Notify via Telegram
      await this.notify(report);
      this.isScanning = false;
      return report;
    } catch (err: any) {
      console.error("❌ Scan error:", err.message);
      this.isScanning = false;
      return `Scan error: ${err.message}`;
    }
  }

  // ── RESEARCH CANDIDATES ──────────────────────────────────
  private async researchCandidates(scanResponse: string): Promise<TokenCandidate[]> {
    const researchResult = await this.bankrPrompt(
      `Based on this token list, score each token from 0-100 on investment potential. ` +
      `Consider: volume relative to market cap, price momentum, holder distribution, liquidity depth, and risk. ` +
      `For each token, respond in this exact format (one per line):\n` +
      `SCORE|symbol|price|marketcap_number|volume24h|change24h|reason\n\n` +
      `Token list:\n${scanResponse}\n\n` +
      `Rules:\n` +
      `- Score 80+: Strong buy signal (high volume, good momentum, decent liquidity)\n` +
      `- Score 60-79: Moderate opportunity (some positive signals)\n` +
      `- Score 40-59: Risky (low liquidity or mixed signals)\n` +
      `- Score <40: Avoid (rug risk, dead volume, or declining)\n` +
      `- Be conservative. Most tokens should score below 60.`
    );

    if (!researchResult.success) return [];

    const candidates: TokenCandidate[] = [];
    const lines = (researchResult.response || "").split("\n");

    for (const line of lines) {
      const parts = line.split("|").map(s => s.trim());
      if (parts.length >= 7) {
        const score = parseInt(parts[0]);
        if (!isNaN(score)) {
          const mcap = parseFloat(parts[3].replace(/[$,k]/gi, ""));
          const marketCap = parts[3].toLowerCase().includes("k") ? mcap * 1000 : mcap;

          candidates.push({
            name: parts[1],
            symbol: parts[1],
            price: parts[2],
            marketCap: marketCap,
            volume24h: parts[4],
            change24h: parts[5],
            score,
            reason: parts[6],
          });

          // Update token memory
          this.memory = updateTokenMemory(this.memory, parts[1], {
            lastResearched: Date.now(),
            researchSummary: parts[6],
            score,
            marketCap: parts[3],
            volume24h: parts[4],
            lastPrice: parts[2],
          });
        }
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  // ── EXECUTE BUY ──────────────────────────────────────────
  private async executeBuy(token: TokenCandidate): Promise<string> {
    const amount = this.memory.settings.maxBuyAmount;

    try {
      const result = await this.bankrPrompt(
        `Buy $${amount} of ${token.symbol} on Base`
      );

      const tradeId = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const trade: TradeEntry = {
        id: tradeId,
        token: token.name,
        symbol: token.symbol,
        action: "buy",
        amount: `$${amount}`,
        price: token.price,
        marketCap: token.marketCap.toString(),
        timestamp: Date.now(),
        reason: `Score ${token.score}/100: ${token.reason}`,
        bankrResponse: result.response,
        status: result.success ? "open" : "failed",
      };

      this.memory = logTrade(this.memory, trade);

      if (result.success) {
        return `✅ Bought $${amount} of ${token.symbol} (score: ${token.score})`;
      } else {
        return `❌ Failed to buy ${token.symbol}: ${result.error}`;
      }
    } catch (err: any) {
      return `❌ Error buying ${token.symbol}: ${err.message}`;
    }
  }

  // ── MONITOR POSITIONS ────────────────────────────────────
  async monitorPositions(): Promise<void> {
    if (this.isMonitoring) return;
    this.isMonitoring = true;

    try {
      const openPositions = getOpenPositions(this.memory);
      if (openPositions.length === 0) {
        this.isMonitoring = false;
        return;
      }

      console.log(`📊 Monitoring ${openPositions.length} open position(s)...`);

      for (const trade of openPositions) {
        try {
          // Check current price via Bankr
          const priceResult = await this.bankrPrompt(
            `What is the current price of ${trade.symbol} on Base? Just give me the price number.`
          );

          if (!priceResult.success) continue;

          const currentPrice = priceResult.response || "";
          const entryPrice = parseFloat(trade.price || "0");
          const priceMatch = currentPrice.match(/\$?([\d.]+)/);
          const current = priceMatch ? parseFloat(priceMatch[1]) : 0;

          if (entryPrice === 0 || current === 0) continue;

          const pnlPct = ((current - entryPrice) / entryPrice) * 100;

          // Take profit
          if (pnlPct >= this.memory.settings.takeProfitPct) {
            const sellResult = await this.bankrPrompt(
              `Sell 50% of my ${trade.symbol} position on Base`
            );

            if (sellResult.success) {
              this.memory = closeTrade(this.memory, trade.id, current.toString(), pnlPct.toFixed(2));
              await this.notify(
                `🎉 *Take Profit Hit!*\n\n` +
                `${trade.symbol}: +${pnlPct.toFixed(1)}%\n` +
                `Entry: ${trade.price} → Exit: $${current}\n` +
                `Sold 50% of position 💰`
              );
            }
          }

          // Stop loss
          if (pnlPct <= -this.memory.settings.stopLossPct) {
            const sellResult = await this.bankrPrompt(
              `Sell all of my ${trade.symbol} on Base`
            );

            if (sellResult.success) {
              this.memory = closeTrade(this.memory, trade.id, current.toString(), pnlPct.toFixed(2));
              await this.notify(
                `🛑 *Stop Loss Triggered!*\n\n` +
                `${trade.symbol}: ${pnlPct.toFixed(1)}%\n` +
                `Entry: ${trade.price} → Exit: $${current}\n` +
                `Sold all to limit losses 🛡️`
              );
            }
          }
        } catch (err: any) {
          console.error(`⚠️ Error monitoring ${trade.symbol}:`, err.message);
        }

        // Rate limit between position checks
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (err: any) {
      console.error("❌ Monitor error:", err.message);
    }

    this.isMonitoring = false;
  }

  // ── MANUAL ACTIONS ───────────────────────────────────────
  async manualResearch(token: string): Promise<string> {
    const result = await this.bankrPrompt(
      `Give me a comprehensive analysis of ${token} on Base:\n` +
      `1. Current price and market cap\n` +
      `2. 24h volume and price change\n` +
      `3. Holder distribution (top holders %)\n` +
      `4. Liquidity depth\n` +
      `5. Social sentiment\n` +
      `6. Risk assessment (1-10)\n` +
      `7. Overall investment score (0-100)\n` +
      `Be honest and conservative in your assessment.`
    );

    if (result.success) {
      this.memory = updateTokenMemory(this.memory, token.toUpperCase(), {
        lastResearched: Date.now(),
        researchSummary: result.response || "",
      });
    }

    return result.success ? result.response || "No data" : `Research failed: ${result.error}`;
  }

  // ── SETTINGS ─────────────────────────────────────────────
  updateSettings(updates: Partial<AgentMemory["settings"]>): string {
    Object.assign(this.memory.settings, updates);
    saveMemory(this.memory);

    // Restart scan timer if interval changed
    if (updates.scanIntervalMin && this.scanTimer) {
      clearInterval(this.scanTimer);
      const scanMs = this.memory.settings.scanIntervalMin * 60 * 1000;
      this.scanTimer = setInterval(() => this.scanMarket(), scanMs);
    }

    return "Settings updated ✅";
  }

  toggleAutoTrade(enabled: boolean): string {
    this.memory.settings.autoTradeEnabled = enabled;
    saveMemory(this.memory);
    return enabled
      ? "🟢 Auto-trade ENABLED. I'll buy tokens that score 60+ automatically."
      : "🔴 Auto-trade DISABLED. I'll still scan and alert you, but won't buy.";
  }
}
