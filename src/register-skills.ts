import { SkillRegistry, Skill } from "./skills.js";
import { AgentKit } from "@coinbase/agentkit";
import { getPerformanceSummary, getOpenPositions, getTradeHistory, loadMemory } from "./memory.js";

// ============================================================
// REGISTER ALL SKILLS — Called once at startup
// ============================================================

type BankrPromptFn = (prompt: string, threadId?: string) => Promise<{
  success: boolean;
  jobId: string;
  threadId?: string;
  status: string;
  response?: string;
  error?: string;
}>;

type ExecuteActionFn = (agent: AgentKit, actionName: string, args?: Record<string, any>) => Promise<string>;
type GetWalletAddressFn = (agent: AgentKit) => Promise<string>;
type GetEthBalanceFn = (addr: string) => Promise<string>;
type GetTokenBalanceFn = (tokenAddr: string, walletAddr: string, decimals: number) => Promise<string>;
type ResolveAddressFn = (input: string) => Promise<{ address: string; display: string }>;
type GetPriceFn = (symbol: string) => Promise<string>;

interface SkillDeps {
  agent: AgentKit;
  bankrPrompt: BankrPromptFn;
  executeAction: ExecuteActionFn;
  getWalletAddress: GetWalletAddressFn;
  getEthBalance: GetEthBalanceFn;
  getTokenBalance: GetTokenBalanceFn;
  resolveAddress: ResolveAddressFn;
  getPrice: GetPriceFn;
  tokenRegistry: Record<string, { symbol: string; name: string; address: string; decimals: number; pythFeedId?: string }>;
  isBankrConfigured: () => boolean;
  trader: { scanMarket: () => Promise<string>; toggleAutoTrade: (on: boolean) => string; updateSettings: (u: any) => string; getMemory: () => any };
}

export function registerAllSkills(registry: SkillRegistry, deps: SkillDeps): void {
  const {
    agent, bankrPrompt, executeAction, getWalletAddress,
    getEthBalance, getTokenBalance, resolveAddress, getPrice,
    tokenRegistry, isBankrConfigured, trader,
  } = deps;

  // ── WALLET SKILLS ────────────────────────────────────────
  registry.register({
    name: "get_wallet_address",
    description: "Get the user's wallet address on Base",
    category: "wallet",
    parameters: [],
    execute: async () => {
      const addr = await getWalletAddress(agent);
      return addr || "Could not retrieve wallet address";
    },
  });

  registry.register({
    name: "get_eth_balance",
    description: "Get the ETH balance of the wallet",
    category: "wallet",
    parameters: [],
    execute: async () => {
      const addr = await getWalletAddress(agent);
      if (!addr) return "Wallet not initialized";
      const bal = await getEthBalance(addr);
      return `ETH Balance: ${parseFloat(bal).toFixed(6)} ETH`;
    },
  });

  registry.register({
    name: "get_token_balance",
    description: "Get the balance of a specific token (USDC, WETH, DAI, PEPE, DEGEN, etc.)",
    category: "wallet",
    parameters: [
      { name: "token", type: "string", description: "Token symbol (e.g., usdc, weth, dai, pepe)", required: true },
    ],
    execute: async (params) => {
      const key = params.token.toLowerCase();
      const entry = tokenRegistry[key] || Object.values(tokenRegistry).find(t => t.symbol.toLowerCase() === key);
      if (!entry) return `Unknown token: ${params.token}. Known tokens: ${Object.values(tokenRegistry).map(t => t.symbol).join(", ")}`;
      if (!entry.address) return `${entry.symbol} is not an on-chain token on Base`;
      const addr = await getWalletAddress(agent);
      if (!addr) return "Wallet not initialized";
      const bal = await getTokenBalance(entry.address, addr, entry.decimals);
      return `${entry.symbol} Balance: ${parseFloat(bal).toFixed(6)} ${entry.symbol}`;
    },
  });

  registry.register({
    name: "get_all_balances",
    description: "Get balances of all tokens in the wallet (ETH, USDC, WETH, DAI, etc.)",
    category: "wallet",
    parameters: [],
    execute: async () => {
      const addr = await getWalletAddress(agent);
      if (!addr) return "Wallet not initialized";
      const ethBal = await getEthBalance(addr);
      let result = `Wallet: ${addr}\n\nETH: ${parseFloat(ethBal).toFixed(6)}`;
      for (const entry of Object.values(tokenRegistry)) {
        if (entry.address && entry.address !== "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE") {
          const bal = await getTokenBalance(entry.address, addr, entry.decimals);
          if (parseFloat(bal) > 0) {
            result += `\n${entry.symbol}: ${parseFloat(bal).toFixed(6)}`;
          }
        }
      }
      return result;
    },
  });

  registry.register({
    name: "get_bankr_balance",
    description: "Check the Bankr managed wallet balance (separate from AgentKit wallet)",
    category: "wallet",
    parameters: [],
    execute: async () => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt("Show me my account info and wallet balance. Include all tokens and their USD values.");
      return result.success ? result.response || "No data" : `Error: ${result.error}`;
    },
  });

  // ── TRADING SKILLS ───────────────────────────────────────
  registry.register({
    name: "swap_tokens",
    description: "Swap/trade one token for another on Base via AgentKit (e.g., swap 5 USDC for ETH)",
    category: "trading",
    parameters: [
      { name: "amount", type: "string", description: "Amount to swap", required: true },
      { name: "from_token", type: "string", description: "Token to sell (e.g., usdc, eth)", required: true },
      { name: "to_token", type: "string", description: "Token to buy (e.g., eth, usdc)", required: true },
    ],
    execute: async (params) => {
      const from = tokenRegistry[params.from_token.toLowerCase()];
      const to = tokenRegistry[params.to_token.toLowerCase()];
      if (!from) return `Unknown from token: ${params.from_token}`;
      if (!to) return `Unknown to token: ${params.to_token}`;
      const result = await executeAction(agent, "CdpApiActionProvider_trade", {
        fromAssetId: from.address || from.symbol.toLowerCase(),
        toAssetId: to.address || to.symbol.toLowerCase(),
        amount: params.amount,
      });
      return result;
    },
  });

  registry.register({
    name: "send_tokens",
    description: "Send tokens to an address or ENS name (e.g., send 10 USDC to vitalik.eth)",
    category: "trading",
    parameters: [
      { name: "amount", type: "string", description: "Amount to send", required: true },
      { name: "token", type: "string", description: "Token symbol (e.g., usdc, eth)", required: true },
      { name: "recipient", type: "string", description: "Recipient address or ENS name", required: true },
    ],
    execute: async (params) => {
      const token = tokenRegistry[params.token.toLowerCase()];
      if (!token) return `Unknown token: ${params.token}`;
      const { address: toAddr, display } = await resolveAddress(params.recipient);
      if (!toAddr) return `Could not resolve address: ${params.recipient}`;
      const isEth = token.symbol === "ETH";
      const actionName = isEth ? "CdpSmartWalletActionProvider_send_eth" : "CdpSmartWalletActionProvider_send_token";
      const args: any = isEth
        ? { to: toAddr, value: params.amount }
        : { to: toAddr, value: params.amount, contractAddress: token.address };
      const result = await executeAction(agent, actionName, args);
      return `Sent ${params.amount} ${token.symbol} to ${display}\n\n${result}`;
    },
  });

  registry.register({
    name: "snipe_token",
    description: "Buy a token on Base via Bankr AI (for any token, especially memecoins and low-cap tokens)",
    category: "trading",
    parameters: [
      { name: "amount", type: "string", description: "Dollar amount to spend (e.g., 5)", required: true },
      { name: "token", type: "string", description: "Token symbol to buy (e.g., PEPE, DEGEN)", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`Buy $${params.amount} of ${params.token} on Base`);
      return result.success ? `Bought $${params.amount} of ${params.token}\n\n${result.response}` : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "sell_token",
    description: "Sell a token on Base via Bankr AI",
    category: "trading",
    parameters: [
      { name: "token", type: "string", description: "Token symbol to sell", required: true },
      { name: "percentage", type: "string", description: "Percentage to sell (e.g., 50 for half, 100 for all)", required: false },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const pct = params.percentage || "100";
      const result = await bankrPrompt(`Sell ${pct}% of my ${params.token} on Base`);
      return result.success ? result.response || "Done" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "wrap_eth",
    description: "Wrap ETH into WETH",
    category: "trading",
    parameters: [
      { name: "amount", type: "string", description: "Amount of ETH to wrap", required: true },
    ],
    execute: async (params) => executeAction(agent, "WethActionProvider_wrap_eth", { amountToWrap: params.amount }),
  });

  registry.register({
    name: "unwrap_eth",
    description: "Unwrap WETH back to ETH",
    category: "trading",
    parameters: [
      { name: "amount", type: "string", description: "Amount of WETH to unwrap", required: true },
    ],
    execute: async (params) => executeAction(agent, "WethActionProvider_unwrap_eth", { amountToUnwrap: params.amount }),
  });

  // ── RESEARCH SKILLS ──────────────────────────────────────
  registry.register({
    name: "get_token_price",
    description: "Get the current price of a token (ETH, BTC, SOL, USDC, DAI via Pyth oracle)",
    category: "research",
    parameters: [
      { name: "token", type: "string", description: "Token symbol", required: true },
    ],
    execute: async (params) => getPrice(params.token),
  });

  registry.register({
    name: "research_token",
    description: "Get detailed research and analysis on any token — price, market cap, volume, sentiment, risk assessment",
    category: "research",
    parameters: [
      { name: "token", type: "string", description: "Token name or symbol to research", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(
        `Give me a comprehensive analysis of ${params.token}: current price, market cap, 24h volume, 24h change, holder info, liquidity, and risk assessment. Be concise.`
      );
      return result.success ? result.response || "No data" : `Research failed: ${result.error}`;
    },
  });

  registry.register({
    name: "get_trending_tokens",
    description: "Find trending tokens on Base blockchain right now",
    category: "research",
    parameters: [],
    execute: async () => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt("What tokens are trending on Base right now? Show me the top 10 with their prices and 24h changes.");
      return result.success ? result.response || "No data" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "find_lowcap_gems",
    description: "Find low market cap tokens (under $40k) on Base — potential gems",
    category: "research",
    parameters: [
      { name: "max_mcap", type: "number", description: "Maximum market cap in dollars (default 40000)", required: false },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const maxCap = params.max_mcap || 40000;
      const result = await bankrPrompt(
        `Find me trending or new tokens on Base with a market cap under $${maxCap}. Show token name, symbol, price, market cap, 24h volume, and 24h change. Focus on tokens with good volume and momentum. List up to 10 tokens.`
      );
      return result.success ? result.response || "No data" : `Failed: ${result.error}`;
    },
  });

  // ── AUTONOMOUS TRADING SKILLS ────────────────────────────
  registry.register({
    name: "scan_market",
    description: "Run a full market scan to find and score low-cap trading opportunities on Base",
    category: "trading",
    parameters: [],
    execute: async () => trader.scanMarket(),
  });

  registry.register({
    name: "toggle_autotrade",
    description: "Enable or disable autonomous auto-trading",
    category: "trading",
    parameters: [
      { name: "enabled", type: "boolean", description: "true to enable, false to disable", required: true },
    ],
    execute: async (params) => trader.toggleAutoTrade(params.enabled),
  });

  registry.register({
    name: "update_trading_settings",
    description: "Update trading parameters like max market cap, buy amount, take profit %, stop loss %, scan interval",
    category: "trading",
    parameters: [
      { name: "max_market_cap", type: "number", description: "Max market cap filter in dollars", required: false },
      { name: "buy_amount", type: "string", description: "Dollar amount per trade", required: false },
      { name: "take_profit_pct", type: "number", description: "Take profit percentage (e.g., 100 for 2x)", required: false },
      { name: "stop_loss_pct", type: "number", description: "Stop loss percentage (e.g., 30)", required: false },
      { name: "scan_interval_min", type: "number", description: "Minutes between auto-scans", required: false },
      { name: "max_open_positions", type: "number", description: "Maximum concurrent open positions", required: false },
    ],
    execute: async (params) => {
      const updates: any = {};
      if (params.max_market_cap) updates.maxMarketCap = params.max_market_cap;
      if (params.buy_amount) updates.maxBuyAmount = params.buy_amount;
      if (params.take_profit_pct) updates.takeProfitPct = params.take_profit_pct;
      if (params.stop_loss_pct) updates.stopLossPct = params.stop_loss_pct;
      if (params.scan_interval_min) updates.scanIntervalMin = params.scan_interval_min;
      if (params.max_open_positions) updates.maxOpenPositions = params.max_open_positions;
      return trader.updateSettings(updates);
    },
  });

  // ── PORTFOLIO SKILLS ─────────────────────────────────────
  registry.register({
    name: "get_trading_performance",
    description: "Show trading performance stats: win rate, P&L, total trades, settings",
    category: "utility",
    parameters: [],
    execute: async () => getPerformanceSummary(loadMemory()),
  });

  registry.register({
    name: "get_open_positions",
    description: "Show all currently open trading positions",
    category: "utility",
    parameters: [],
    execute: async () => {
      const mem = loadMemory();
      const open = getOpenPositions(mem);
      if (open.length === 0) return "No open positions";
      return open.map(t => `${t.symbol}: ${t.amount} @ ${t.price} (${t.reason.slice(0, 50)})`).join("\n");
    },
  });

  registry.register({
    name: "get_trade_history",
    description: "Show recent trade history with P&L",
    category: "utility",
    parameters: [
      { name: "limit", type: "number", description: "Number of trades to show (default 10)", required: false },
    ],
    execute: async (params) => {
      const trades = getTradeHistory(loadMemory(), params.limit || 10);
      if (trades.length === 0) return "No trades yet";
      return trades.map(t => {
        const pnl = t.pnl ? ` | P&L: ${t.pnl}%` : "";
        return `${t.symbol}: ${t.action} ${t.amount} — ${t.status}${pnl}`;
      }).join("\n");
    },
  });

  // ── PREDICTION MARKET SKILLS ─────────────────────────────
  registry.register({
    name: "polymarket_query",
    description: "Query Polymarket prediction markets — find markets, check odds, place bets",
    category: "prediction",
    parameters: [
      { name: "query", type: "string", description: "What to ask about Polymarket (e.g., 'top markets', 'odds on ETH hitting 5k')", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`Polymarket: ${params.query}`);
      return result.success ? result.response || "No data" : `Failed: ${result.error}`;
    },
  });

  // ── GENERAL BANKR SKILL ──────────────────────────────────
  registry.register({
    name: "bankr_prompt",
    description: "Send any custom prompt to Bankr AI for DeFi, trading, or blockchain queries that other skills don't cover",
    category: "defi",
    parameters: [
      { name: "prompt", type: "string", description: "The prompt to send to Bankr AI", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(params.prompt);
      return result.success ? result.response || "No data" : `Failed: ${result.error}`;
    },
  });

  console.log(`✅ Registered ${registry.getAll().length} skills`);
}
