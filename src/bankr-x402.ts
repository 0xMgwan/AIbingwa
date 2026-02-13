import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
import { loadMemory, saveMemory } from "./memory.js";

// ============================================================
// BANKR x402 SDK CLIENT — Micropayment-based Bankr access
// Self-sustaining: tracks costs, revenue, and profitability
// ============================================================

const BANKR_V2_URL = "https://api.bankr.bot/v2/prompt";

interface X402JobResult {
  success: boolean;
  jobId: string;
  status: string;
  response?: string;
  transactions?: any[];
  richData?: any[];
  error?: string;
  cost: number; // USD cost of this request
}

interface RevenueTracker {
  totalSpent: number;       // Total USD spent on API calls
  totalEarned: number;      // Total USD earned from trades
  requestCount: number;     // Total x402 requests made
  lastReset: string;        // ISO date of last reset
  dailySpend: number;       // Today's spend
  dailyBudget: number;      // Max daily spend
  profitThreshold: number;  // Min profit ratio to stay active
}

export class BankrX402Client {
  private fetchWithPay: any;
  private walletAddress: string;
  private revenue: RevenueTracker;
  private costPerRequest = 0.10; // $0.10 USDC per request
  private initialized = false;

  constructor() {
    const privateKey = process.env.X402_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY;
    if (!privateKey) {
      console.log("ℹ️ No X402_PRIVATE_KEY — x402 SDK disabled (using API key mode)");
      this.fetchWithPay = fetch;
      this.walletAddress = "";
      this.revenue = this.loadRevenue();
      return;
    }

    try {
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      this.walletAddress = process.env.X402_WALLET_ADDRESS || account.address;

      const walletClient = createWalletClient({
        account,
        chain: base,
        transport: http(),
      });

      this.fetchWithPay = wrapFetchWithPayment(fetch, walletClient as any);
      this.initialized = true;
      this.revenue = this.loadRevenue();
      console.log(`💰 x402 client initialized (wallet: ${this.walletAddress.slice(0, 8)}...)`);
      console.log(`📊 Revenue tracker: spent $${this.revenue.totalSpent.toFixed(2)} | earned $${this.revenue.totalEarned.toFixed(2)} | requests: ${this.revenue.requestCount}`);
    } catch (err: any) {
      console.warn("⚠️ x402 init failed:", err.message);
      this.fetchWithPay = fetch;
      this.walletAddress = "";
      this.revenue = this.loadRevenue();
    }
  }

  isAvailable(): boolean {
    return this.initialized;
  }

  // ── SEND PROMPT VIA x402 ──────────────────────────────────
  async prompt(promptText: string): Promise<X402JobResult> {
    if (!this.initialized) {
      return { success: false, jobId: "", status: "disabled", error: "x402 not configured", cost: 0 };
    }

    // Check daily budget
    this.resetDailyIfNeeded();
    if (this.revenue.dailySpend >= this.revenue.dailyBudget) {
      return {
        success: false, jobId: "", status: "budget_exceeded",
        error: `Daily budget of $${this.revenue.dailyBudget} exceeded. Spent $${this.revenue.dailySpend.toFixed(2)} today. Waiting for reset.`,
        cost: 0,
      };
    }

    try {
      // Step 1: Submit prompt via x402 (auto-pays USDC)
      const body: any = { prompt: promptText };
      if (this.walletAddress) body.walletAddress = this.walletAddress;

      const submitRes = await this.fetchWithPay(BANKR_V2_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!submitRes.ok) {
        const errText = await submitRes.text();
        return { success: false, jobId: "", status: "failed", error: `x402 API error: ${submitRes.status} ${errText}`, cost: 0 };
      }

      const submitData = await submitRes.json() as any;
      const jobId = submitData.jobId;

      if (!jobId) {
        return { success: false, jobId: "", status: "failed", error: "No job ID returned", cost: 0 };
      }

      // Track cost
      this.trackCost(this.costPerRequest);

      // Step 2: Poll for results (max 90s)
      for (let i = 0; i < 45; i++) {
        await new Promise(r => setTimeout(r, 2000));

        const pollRes = await this.fetchWithPay(`https://api.bankr.bot/v2/job/${jobId}`, {
          headers: { "Content-Type": "application/json" },
        });

        if (!pollRes.ok) continue;
        const pollData = await pollRes.json() as any;

        if (pollData.status === "completed") {
          return {
            success: true,
            jobId,
            status: "completed",
            response: pollData.response || "No response",
            transactions: pollData.transactions || [],
            richData: pollData.richData || [],
            cost: this.costPerRequest,
          };
        }

        if (pollData.status === "failed" || pollData.status === "cancelled") {
          return {
            success: false, jobId, status: pollData.status,
            error: pollData.response || pollData.error || "Job failed",
            cost: this.costPerRequest,
          };
        }
      }

      return { success: false, jobId, status: "timeout", error: "x402 request timed out (90s)", cost: this.costPerRequest };
    } catch (err: any) {
      return { success: false, jobId: "", status: "failed", error: err.message, cost: 0 };
    }
  }

  // ── REVENUE TRACKING ──────────────────────────────────────
  private trackCost(amount: number): void {
    this.revenue.totalSpent += amount;
    this.revenue.dailySpend += amount;
    this.revenue.requestCount++;
    this.saveRevenue();
  }

  trackRevenue(amount: number): void {
    this.revenue.totalEarned += amount;
    this.saveRevenue();
  }

  getRevenueReport(): string {
    const netPnL = this.revenue.totalEarned - this.revenue.totalSpent;
    const roi = this.revenue.totalSpent > 0
      ? ((this.revenue.totalEarned / this.revenue.totalSpent - 1) * 100).toFixed(1)
      : "N/A";
    const sustainable = netPnL > 0;

    return [
      "📊 **Revenue & Cost Report**",
      `💰 Total Earned: $${this.revenue.totalEarned.toFixed(2)}`,
      `💸 Total Spent (API): $${this.revenue.totalSpent.toFixed(2)}`,
      `📈 Net P&L: ${netPnL >= 0 ? "+" : ""}$${netPnL.toFixed(2)}`,
      `📊 ROI: ${roi}%`,
      `🔢 Total Requests: ${this.revenue.requestCount}`,
      `💵 Avg Cost/Request: $${this.revenue.requestCount > 0 ? (this.revenue.totalSpent / this.revenue.requestCount).toFixed(3) : "0"}`,
      `📅 Today's Spend: $${this.revenue.dailySpend.toFixed(2)} / $${this.revenue.dailyBudget.toFixed(2)}`,
      `${sustainable ? "✅ SELF-SUSTAINING" : "🔴 NOT YET SUSTAINABLE"} — ${sustainable ? "Revenue covers costs!" : "Need more profitable trades"}`,
    ].join("\n");
  }

  isSustainable(): boolean {
    return this.revenue.totalEarned > this.revenue.totalSpent;
  }

  setDailyBudget(amount: number): void {
    this.revenue.dailyBudget = amount;
    this.saveRevenue();
  }

  private resetDailyIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.revenue.lastReset !== today) {
      this.revenue.dailySpend = 0;
      this.revenue.lastReset = today;
      this.saveRevenue();
    }
  }

  private loadRevenue(): RevenueTracker {
    try {
      const mem = loadMemory();
      if ((mem as any).revenue) return (mem as any).revenue;
    } catch {}
    return {
      totalSpent: 0,
      totalEarned: 0,
      requestCount: 0,
      lastReset: new Date().toISOString().slice(0, 10),
      dailySpend: 0,
      dailyBudget: 5.00, // $5/day default budget
      profitThreshold: 0.5,
    };
  }

  private saveRevenue(): void {
    try {
      const mem = loadMemory() as any;
      mem.revenue = this.revenue;
      saveMemory(mem);
    } catch {}
  }
}
