import { SkillRegistry, Skill } from "./skills.js";
import { AgentKit } from "@coinbase/agentkit";
import { getPerformanceSummary, getOpenPositions, getTradeHistory, loadMemory } from "./memory.js";
import { BankrX402Client } from "./bankr-x402.js";
import { TwitterClient } from "./twitter.js";

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
  transactions?: any[];
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
  x402Client?: BankrX402Client;
  twitterClient?: TwitterClient;
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

  registry.register({
    name: "polymarket_bet",
    description: "Place a bet on a Polymarket prediction market outcome",
    category: "prediction",
    parameters: [
      { name: "market", type: "string", description: "The market/question to bet on", required: true },
      { name: "outcome", type: "string", description: "The outcome to bet on (e.g., 'Yes', 'No')", required: true },
      { name: "amount", type: "string", description: "Dollar amount to bet", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`Bet $${params.amount} on ${params.outcome} for "${params.market}" on Polymarket`);
      return result.success ? result.response || "Bet placed" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "polymarket_positions",
    description: "View your current Polymarket positions and P&L",
    category: "prediction",
    parameters: [],
    execute: async () => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt("Show my Polymarket positions and P&L");
      return result.success ? result.response || "No positions" : `Failed: ${result.error}`;
    },
  });

  // ══════════════════════════════════════════════════════════
  // OPENCLAW SKILLS — Leverage, Automation, NFTs, Token Deploy
  // ══════════════════════════════════════════════════════════

  // ── LEVERAGE TRADING (via Avantis on Base) ────────────────
  registry.register({
    name: "leverage_open",
    description: "Open a leveraged position (long or short) on crypto, forex, or commodities via Avantis. Up to 50x crypto, 100x forex/commodities.",
    category: "leverage",
    parameters: [
      { name: "direction", type: "string", description: "long or short", required: true },
      { name: "asset", type: "string", description: "Asset to trade (e.g., ETH, BTC, SOL, Gold, EUR/USD)", required: true },
      { name: "leverage", type: "string", description: "Leverage multiplier (e.g., 5, 10, 20)", required: true },
      { name: "amount", type: "string", description: "Collateral amount in dollars (e.g., 50)", required: true },
      { name: "stop_loss", type: "string", description: "Stop loss price or percentage (e.g., '$3000' or '10%')", required: false },
      { name: "take_profit", type: "string", description: "Take profit price or percentage (e.g., '$4000' or '20%')", required: false },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      let prompt = `Open a ${params.leverage}x ${params.direction} on ${params.asset} with $${params.amount}`;
      if (params.stop_loss) prompt += ` with stop loss at ${params.stop_loss}`;
      if (params.take_profit) prompt += ` and take profit at ${params.take_profit}`;
      const result = await bankrPrompt(prompt);
      return result.success ? result.response || "Position opened" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "leverage_close",
    description: "Close a leveraged position on Avantis",
    category: "leverage",
    parameters: [
      { name: "asset", type: "string", description: "Asset to close (e.g., ETH, BTC)", required: true },
      { name: "percentage", type: "string", description: "Percentage to close (default 100 for full close)", required: false },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const pct = params.percentage || "100";
      const result = await bankrPrompt(`Close ${pct}% of my ${params.asset} position on Avantis`);
      return result.success ? result.response || "Position closed" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "leverage_positions",
    description: "View all open leveraged positions on Avantis with P&L",
    category: "leverage",
    parameters: [],
    execute: async () => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt("Show my Avantis positions with P&L, entry price, liquidation price, and current value");
      return result.success ? result.response || "No positions" : `Failed: ${result.error}`;
    },
  });

  // ── AUTOMATION SKILLS (DCA, Limit Orders, Stop Loss) ──────
  registry.register({
    name: "set_limit_order",
    description: "Set a limit order to buy or sell a token at a target price",
    category: "automation",
    parameters: [
      { name: "action", type: "string", description: "buy or sell", required: true },
      { name: "token", type: "string", description: "Token symbol (e.g., ETH, PEPE)", required: true },
      { name: "price", type: "string", description: "Target price to execute at (e.g., '$3000')", required: true },
      { name: "amount", type: "string", description: "Amount or dollar value (e.g., '$100' or '0.5 ETH')", required: false },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      let prompt = `Set a limit order to ${params.action} ${params.token} at ${params.price}`;
      if (params.amount) prompt += ` for ${params.amount}`;
      const result = await bankrPrompt(prompt);
      return result.success ? result.response || "Limit order set" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "set_stop_loss_order",
    description: "Set a stop loss order to automatically sell a token if price drops to a level",
    category: "automation",
    parameters: [
      { name: "token", type: "string", description: "Token symbol (e.g., ETH, PEPE)", required: true },
      { name: "price_or_pct", type: "string", description: "Stop price or percentage drop (e.g., '$2500' or '20%')", required: true },
      { name: "amount", type: "string", description: "Amount to sell (e.g., '50%' or 'all')", required: false },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const amt = params.amount || "all";
      const result = await bankrPrompt(`Set stop loss for ${amt} of my ${params.token} at ${params.price_or_pct}`);
      return result.success ? result.response || "Stop loss set" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "setup_dca",
    description: "Set up Dollar Cost Averaging — automatically buy a token at regular intervals (hourly, daily, weekly, monthly)",
    category: "automation",
    parameters: [
      { name: "token", type: "string", description: "Token to DCA into (e.g., ETH, BTC, SOL)", required: true },
      { name: "amount", type: "string", description: "Dollar amount per purchase (e.g., '50')", required: true },
      { name: "interval", type: "string", description: "Frequency: hourly, daily, weekly, monthly", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`DCA $${params.amount} into ${params.token} every ${params.interval}`);
      return result.success ? result.response || "DCA set up" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "setup_twap",
    description: "Set up TWAP (Time-Weighted Average Price) — spread a large order over time to reduce slippage",
    category: "automation",
    parameters: [
      { name: "action", type: "string", description: "buy or sell", required: true },
      { name: "token", type: "string", description: "Token symbol", required: true },
      { name: "amount", type: "string", description: "Total dollar amount (e.g., '1000')", required: true },
      { name: "duration", type: "string", description: "Time to spread over (e.g., '4 hours', '24 hours')", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`TWAP: ${params.action} $${params.amount} of ${params.token} over ${params.duration}`);
      return result.success ? result.response || "TWAP set up" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "view_automations",
    description: "View all active automations — limit orders, stop losses, DCA, TWAP, scheduled commands",
    category: "automation",
    parameters: [],
    execute: async () => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt("Show all my active automations, limit orders, stop losses, DCA schedules, and TWAP orders");
      return result.success ? result.response || "No active automations" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "cancel_automation",
    description: "Cancel an active automation (limit order, stop loss, DCA, etc.)",
    category: "automation",
    parameters: [
      { name: "description", type: "string", description: "Describe which automation to cancel (e.g., 'my ETH DCA', 'stop loss on PEPE')", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`Cancel my automation: ${params.description}`);
      return result.success ? result.response || "Cancelled" : `Failed: ${result.error}`;
    },
  });

  // ── NFT SKILLS ────────────────────────────────────────────
  registry.register({
    name: "nft_browse",
    description: "Browse NFT collections — check floor prices, listings, and trending collections",
    category: "nft",
    parameters: [
      { name: "query", type: "string", description: "Collection name or search query (e.g., 'Pudgy Penguins floor price', 'trending NFTs on Base')", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`NFT: ${params.query}`);
      return result.success ? result.response || "No data" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "nft_buy",
    description: "Buy an NFT from a collection (cheapest listing or specific token ID)",
    category: "nft",
    parameters: [
      { name: "collection", type: "string", description: "Collection name (e.g., 'Pudgy Penguins', 'Based Punks')", required: true },
      { name: "token_id", type: "string", description: "Specific token ID to buy (leave empty for cheapest)", required: false },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const prompt = params.token_id
        ? `Buy ${params.collection} #${params.token_id}`
        : `Buy the cheapest ${params.collection}`;
      const result = await bankrPrompt(prompt);
      return result.success ? result.response || "NFT purchased" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "nft_portfolio",
    description: "View your NFT portfolio — all NFTs you own across chains",
    category: "nft",
    parameters: [],
    execute: async () => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt("Show my NFTs across all chains with floor prices and total value");
      return result.success ? result.response || "No NFTs" : `Failed: ${result.error}`;
    },
  });

  // ── TOKEN DEPLOYMENT SKILLS ───────────────────────────────
  registry.register({
    name: "deploy_token_base",
    description: "Deploy a new ERC-20 token on Base via Clanker with custom name, symbol, and metadata. Requires x402 wallet for on-chain execution.",
    category: "token_deploy",
    parameters: [
      { name: "name", type: "string", description: "Token name (e.g., 'MoonCoin')", required: true },
      { name: "symbol", type: "string", description: "Token symbol (e.g., 'MOON')", required: true },
      { name: "description", type: "string", description: "Brief description of the token", required: false },
    ],
    execute: async (params) => {
      let prompt = `Deploy a token called ${params.name} with symbol ${params.symbol} on Base`;
      if (params.description) prompt += `. Description: ${params.description}`;

      // Try x402 first (can actually execute on-chain transactions)
      if (deps.x402Client && deps.x402Client.isAvailable()) {
        console.log(`🚀 Deploying token via x402: ${params.name} (${params.symbol})`);
        const result = await deps.x402Client.prompt(prompt);
        if (result.success) {
          return result.response || "Token deployment submitted via x402";
        }
        console.log(`⚠️ x402 deploy failed: ${result.error}, trying API key mode...`);
      }

      // Fallback to API key mode
      if (!isBankrConfigured()) return "Token deployment requires x402 wallet (X402_PRIVATE_KEY) or Bankr API key. x402 is recommended for on-chain actions.";
      const result = await bankrPrompt(prompt);
      if (result.success) {
        const hasTx = result.transactions && result.transactions.length > 0;
        return (result.response || "Token deployment submitted") + (hasTx ? `\n\n📋 ${result.transactions!.length} transaction(s) returned — check Bankr dashboard to confirm.` : "\n\n⚠️ No transactions returned. Token deployment may need to be done via Bankr's Telegram bot or x402 SDK directly.");
      }
      return `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "deploy_token_solana",
    description: "Launch a new SPL token on Solana via Raydium LaunchLab with bonding curve",
    category: "token_deploy",
    parameters: [
      { name: "name", type: "string", description: "Token name", required: true },
      { name: "symbol", type: "string", description: "Token symbol", required: true },
      { name: "fee_recipient", type: "string", description: "Optional fee recipient address or social handle", required: false },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      let prompt = `Launch a token called ${params.name} with symbol ${params.symbol} on Solana`;
      if (params.fee_recipient) prompt += ` and give fees to ${params.fee_recipient}`;
      const result = await bankrPrompt(prompt);
      return result.success ? result.response || "Token launched" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "claim_token_fees",
    description: "Claim creator fees from a deployed token (Base via Clanker or Solana via LaunchLab)",
    category: "token_deploy",
    parameters: [
      { name: "token", type: "string", description: "Token name or symbol to claim fees for", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`Claim my fees for ${params.token}`);
      return result.success ? result.response || "Fees claimed" : `Failed: ${result.error}`;
    },
  });

  // ── CROSS-CHAIN SKILLS ────────────────────────────────────
  registry.register({
    name: "bridge_tokens",
    description: "Bridge tokens between chains (Base, Ethereum, Polygon, Solana, Unichain). Move funds cross-chain.",
    category: "cross_chain",
    parameters: [
      { name: "amount", type: "string", description: "Amount to bridge (e.g., '100')", required: true },
      { name: "token", type: "string", description: "Token to bridge (e.g., 'USDC', 'ETH')", required: true },
      { name: "from_chain", type: "string", description: "Source chain (e.g., 'Polygon', 'Ethereum')", required: true },
      { name: "to_chain", type: "string", description: "Destination chain (e.g., 'Base', 'Solana')", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`Bridge ${params.amount} ${params.token} from ${params.from_chain} to ${params.to_chain}`);
      return result.success ? result.response || "Bridge initiated" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "multi_chain_portfolio",
    description: "View portfolio across ALL chains — Base, Ethereum, Polygon, Solana with USD values",
    category: "cross_chain",
    parameters: [],
    execute: async () => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt("Show my complete portfolio across all chains with USD values and total");
      return result.success ? result.response || "No data" : `Failed: ${result.error}`;
    },
  });

  // ── TECHNICAL ANALYSIS & MARKET INTELLIGENCE ──────────────
  registry.register({
    name: "technical_analysis",
    description: "Run technical analysis on a token — RSI, MACD, support/resistance, trend, chart patterns",
    category: "research",
    parameters: [
      { name: "token", type: "string", description: "Token to analyze (e.g., ETH, BTC, SOL)", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`Do a full technical analysis on ${params.token}: RSI, MACD, support/resistance levels, trend direction, and trading recommendation. Be concise.`);
      return result.success ? result.response || "No data" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "compare_tokens",
    description: "Compare two or more tokens side-by-side — price, market cap, volume, performance",
    category: "research",
    parameters: [
      { name: "tokens", type: "string", description: "Tokens to compare separated by 'vs' (e.g., 'ETH vs SOL', 'PEPE vs DEGEN vs BRETT')", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`Compare ${params.tokens}: price, market cap, 24h volume, 24h change, and which is the better trade right now`);
      return result.success ? result.response || "No data" : `Failed: ${result.error}`;
    },
  });

  registry.register({
    name: "social_sentiment",
    description: "Check social sentiment and buzz for a token — Twitter, Farcaster, community activity",
    category: "research",
    parameters: [
      { name: "token", type: "string", description: "Token to check sentiment for", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`What's the social sentiment for ${params.token}? Check Twitter buzz, community activity, and overall market mood. Is it bullish or bearish?`);
      return result.success ? result.response || "No data" : `Failed: ${result.error}`;
    },
  });

  // ── TRANSFER SKILLS (Enhanced) ────────────────────────────
  registry.register({
    name: "send_to_social",
    description: "Send tokens to a social handle — Twitter username, Farcaster, Telegram handle, or ENS name",
    category: "transfer",
    parameters: [
      { name: "amount", type: "string", description: "Amount to send (e.g., '10')", required: true },
      { name: "token", type: "string", description: "Token to send (e.g., 'USDC', 'ETH')", required: true },
      { name: "recipient", type: "string", description: "Social handle, ENS, or address (e.g., '@vitalik', 'vitalik.eth')", required: true },
    ],
    execute: async (params) => {
      if (!isBankrConfigured()) return "Bankr API not configured";
      const result = await bankrPrompt(`Send ${params.amount} ${params.token} to ${params.recipient}`);
      return result.success ? result.response || "Sent" : `Failed: ${result.error}`;
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

  // ══════════════════════════════════════════════════════════
  // TWITTER SKILLS — Autonomous posting & engagement
  // ══════════════════════════════════════════════════════════

  if (deps.twitterClient && deps.twitterClient.isAvailable()) {
    registry.register({
      name: "tweet",
      description: "Post a tweet to X (Twitter). Max 280 characters.",
      category: "utility",
      parameters: [
        { name: "text", type: "string", description: "Tweet text (max 280 chars)", required: true },
      ],
      execute: async (params) => {
        const result = await deps.twitterClient!.tweet(params.text);
        return result.success ? `✅ Tweet posted: ${params.text}` : `❌ Tweet failed: ${result.error}`;
      },
    });

    registry.register({
      name: "tweet_trade_alert",
      description: "Post a trade alert tweet with entry, target, and stop loss",
      category: "utility",
      parameters: [
        { name: "token", type: "string", description: "Token symbol (e.g., PEPE)", required: true },
        { name: "entry", type: "string", description: "Entry price", required: true },
        { name: "target", type: "string", description: "Take profit target", required: true },
        { name: "stop_loss", type: "string", description: "Stop loss level", required: true },
      ],
      execute: async (params) => {
        const text = `🚀 TRADE ALERT: $${params.token}\n📍 Entry: ${params.entry}\n🎯 Target: ${params.target}\n🛑 SL: ${params.stop_loss}\n#DeFi #Trading`;
        const result = await deps.twitterClient!.tweet(text);
        return result.success ? `✅ Trade alert posted` : `❌ Failed: ${result.error}`;
      },
    });

    registry.register({
      name: "tweet_daily_report",
      description: "Post daily P&L and sustainability report to Twitter",
      category: "utility",
      parameters: [
        { name: "pnl", type: "string", description: "Daily P&L (e.g., +$12.50)", required: true },
        { name: "win_rate", type: "string", description: "Win rate percentage (e.g., 65%)", required: true },
        { name: "status", type: "string", description: "Status (e.g., 'Self-sustaining' or 'Growing')", required: true },
      ],
      execute: async (params) => {
        const text = `📊 Daily Report\n💰 P&L: ${params.pnl}\n📈 Win Rate: ${params.win_rate}\n🎯 Status: ${params.status}\n#AI #Trading #Autonomous`;
        const result = await deps.twitterClient!.tweet(text);
        return result.success ? `✅ Daily report posted` : `❌ Failed: ${result.error}`;
      },
    });

    registry.register({
      name: "tweet_gem_find",
      description: "Post a gem discovery tweet with token details",
      category: "utility",
      parameters: [
        { name: "token", type: "string", description: "Token symbol", required: true },
        { name: "mcap", type: "string", description: "Market cap", required: true },
        { name: "volume", type: "string", description: "24h volume", required: true },
        { name: "score", type: "string", description: "Viability score (0-100)", required: true },
      ],
      execute: async (params) => {
        const text = `💎 GEM FOUND: $${params.token}\n📊 MCap: ${params.mcap}\n💧 Vol: ${params.volume}\n⭐ Score: ${params.score}/100\n#LowCap #DeFi`;
        const result = await deps.twitterClient!.tweet(text);
        return result.success ? `✅ Gem post shared` : `❌ Failed: ${result.error}`;
      },
    });
  }

  // ══════════════════════════════════════════════════════════
  // SELF-SUSTAINING AGENT SKILLS — Revenue & Cost Tracking
  // ══════════════════════════════════════════════════════════

  if (deps.x402Client && deps.x402Client.isAvailable()) {
    registry.register({
      name: "x402_prompt",
      description: "Send a prompt via Bankr x402 SDK (micropayment-based, $0.10/request). Use when API key mode fails or for direct SDK access.",
      category: "defi",
      parameters: [
        { name: "prompt", type: "string", description: "The prompt to send via x402", required: true },
      ],
      execute: async (params) => {
        const result = await deps.x402Client!.prompt(params.prompt);
        return result.success ? result.response || "No data" : `Failed: ${result.error}`;
      },
    });
  }

  if (deps.x402Client) {
    registry.register({
      name: "revenue_report",
      description: "Show the agent's revenue vs cost report — total earned, total spent on API calls, net P&L, sustainability status",
      category: "utility",
      parameters: [],
      execute: async () => deps.x402Client!.getRevenueReport(),
    });

    registry.register({
      name: "set_daily_budget",
      description: "Set the agent's daily API spending budget in dollars. Agent stops making x402 requests when budget is exceeded.",
      category: "utility",
      parameters: [
        { name: "amount", type: "number", description: "Daily budget in dollars (e.g., 5 for $5/day)", required: true },
      ],
      execute: async (params) => {
        deps.x402Client!.setDailyBudget(params.amount);
        return `✅ Daily budget set to $${params.amount}. Agent will pause x402 requests when this limit is reached.`;
      },
    });

    registry.register({
      name: "track_trade_revenue",
      description: "Record revenue earned from a trade (profit). Used to track if the agent is self-sustaining.",
      category: "utility",
      parameters: [
        { name: "amount", type: "number", description: "Dollar amount of profit earned", required: true },
        { name: "source", type: "string", description: "Source of revenue (e.g., 'PEPE trade', 'Polymarket win')", required: true },
      ],
      execute: async (params) => {
        deps.x402Client!.trackRevenue(params.amount);
        return `✅ Recorded $${params.amount} revenue from: ${params.source}. ${deps.x402Client!.isSustainable() ? "🟢 Agent is self-sustaining!" : "🔴 Not yet sustainable — keep trading!"}`;
      },
    });
  }

  console.log(`✅ Registered ${registry.getAll().length} skills`);
}
