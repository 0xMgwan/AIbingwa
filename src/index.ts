import { Bot, Context, session, SessionFlavor } from "grammy";
import {
  AgentKit,
  cdpApiActionProvider,
  cdpSmartWalletActionProvider,
  erc20ActionProvider,
  pythActionProvider,
  CdpSmartWalletProvider,
  walletActionProvider,
  wethActionProvider,
} from "@coinbase/agentkit";
import { createPublicClient, http, formatUnits, parseUnits, isAddress, getAddress } from "viem";
import { base, mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WALLET_DATA_FILE = join(__dirname, "..", "wallet-data.json");

// ============================================================
// TOKEN REGISTRY — aliases, addresses, decimals, Pyth feed IDs
// ============================================================
const TOKEN_REGISTRY: Record<string, {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  pythFeedId?: string;
}> = {
  eth: {
    symbol: "ETH",
    name: "Ethereum",
    address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    decimals: 18,
    pythFeedId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  },
  weth: {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    pythFeedId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  },
  usdc: {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    pythFeedId: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  },
  dai: {
    symbol: "DAI",
    name: "Dai Stablecoin",
    address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    decimals: 18,
    pythFeedId: "0xb0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e6f20c30bc14",
  },
  btc: {
    symbol: "BTC",
    name: "Bitcoin",
    address: "",
    decimals: 8,
    pythFeedId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  },
  sol: {
    symbol: "SOL",
    name: "Solana",
    address: "",
    decimals: 9,
    pythFeedId: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  },
  cbeth: {
    symbol: "cbETH",
    name: "Coinbase Wrapped Staked ETH",
    address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    decimals: 18,
  },
};

// ERC20 ABI for balanceOf
const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ============================================================
// SESSION & CONTEXT
// ============================================================
interface SessionData {
  messageCount: number;
}

type MyContext = Context & SessionFlavor<SessionData>;

let agentKit: AgentKit | null = null;
let cachedWalletAddress: string | null = null;

// Viem clients for on-chain reads and ENS
const baseClient = createPublicClient({ chain: base, transport: http() });
const mainnetClient = createPublicClient({ chain: mainnet, transport: http() });

// ============================================================
// WALLET PERSISTENCE
// ============================================================
interface WalletData {
  ownerAddress: string;
  smartWalletAddress: string;
}

function loadWalletData(): WalletData | null {
  // First check env vars (for Railway/deployment)
  if (process.env.OWNER_ADDRESS && process.env.SMART_WALLET_ADDRESS) {
    console.log("📂 Loading wallet from env vars");
    return {
      ownerAddress: process.env.OWNER_ADDRESS,
      smartWalletAddress: process.env.SMART_WALLET_ADDRESS,
    };
  }
  // Then check file (for local dev)
  try {
    if (existsSync(WALLET_DATA_FILE)) {
      const data = JSON.parse(readFileSync(WALLET_DATA_FILE, "utf-8"));
      console.log("📂 Loading wallet from file:", data.smartWalletAddress);
      return data;
    }
  } catch {}
  return null;
}

function saveWalletData(data: WalletData): void {
  try {
    writeFileSync(WALLET_DATA_FILE, JSON.stringify(data, null, 2));
    console.log("💾 Wallet data saved to", WALLET_DATA_FILE);
    console.log("   Owner:", data.ownerAddress);
    console.log("   Smart Wallet:", data.smartWalletAddress);
    console.log("\n⚠️  Add these to your Railway env vars for persistence:");
    console.log(`   OWNER_ADDRESS=${data.ownerAddress}`);
    console.log(`   SMART_WALLET_ADDRESS=${data.smartWalletAddress}`);
  } catch (err) {
    console.error("Failed to save wallet data:", err);
  }
}

// ============================================================
// AGENTKIT INITIALIZATION
// ============================================================
async function initializeAgentKit(): Promise<AgentKit> {
  if (agentKit) return agentKit;

  const savedWallet = loadWalletData();

  const config: any = {
    apiKeyId: process.env.CDP_API_KEY_ID!,
    apiKeySecret: process.env.CDP_API_KEY_SECRET!,
    walletSecret: process.env.CDP_WALLET_SECRET!,
    networkId: (process.env.NETWORK_ID || "base-mainnet") as any,
  };

  // If we have saved wallet data, pass owner + address to reload the SAME wallet
  if (savedWallet) {
    config.owner = savedWallet.ownerAddress;
    config.address = savedWallet.smartWalletAddress;
    console.log("🔑 Reloading existing wallet:", savedWallet.smartWalletAddress);
  } else {
    console.log("🆕 Creating new wallet (first run)...");
  }

  const walletProvider = await CdpSmartWalletProvider.configureWithWallet(config);

  // Export and save wallet data for next time
  const exported = await walletProvider.exportWallet();
  const walletData: WalletData = {
    ownerAddress: exported.ownerAddress,
    smartWalletAddress: exported.address,
  };

  // Cache the address
  cachedWalletAddress = exported.address;

  // Save if this is a new wallet
  if (!savedWallet) {
    saveWalletData(walletData);
  }

  console.log("✅ Wallet address:", exported.address);

  agentKit = await AgentKit.from({
    walletProvider,
    actionProviders: [
      walletActionProvider(),
      erc20ActionProvider(),
      wethActionProvider(),
      pythActionProvider(),
      cdpApiActionProvider(),
      cdpSmartWalletActionProvider(),
    ],
  });

  return agentKit;
}

// ============================================================
// HELPERS
// ============================================================

// Resolve token alias to registry entry
function resolveToken(input: string): typeof TOKEN_REGISTRY[string] | null {
  const key = input.toLowerCase().trim();
  if (TOKEN_REGISTRY[key]) return TOKEN_REGISTRY[key];
  // Try matching by symbol
  for (const entry of Object.values(TOKEN_REGISTRY)) {
    if (entry.symbol.toLowerCase() === key) return entry;
  }
  // Try matching by address
  if (isAddress(input)) {
    for (const entry of Object.values(TOKEN_REGISTRY)) {
      if (entry.address.toLowerCase() === input.toLowerCase()) return entry;
    }
  }
  return null;
}

// Resolve ENS name to address
async function resolveAddress(input: string): Promise<{ address: string; display: string }> {
  const trimmed = input.trim();
  if (isAddress(trimmed)) {
    return { address: getAddress(trimmed), display: trimmed };
  }
  if (trimmed.endsWith(".eth")) {
    try {
      const resolved = await mainnetClient.getEnsAddress({ name: normalize(trimmed) });
      if (resolved) {
        return { address: resolved, display: `${trimmed} (${resolved.slice(0, 6)}...${resolved.slice(-4)})` };
      }
    } catch {}
    return { address: "", display: trimmed };
  }
  return { address: trimmed, display: trimmed };
}

// Get ERC20 token balance
async function getTokenBalance(tokenAddress: string, walletAddress: string, decimals: number): Promise<string> {
  try {
    const balance = await baseClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress as `0x${string}`],
    });
    return formatUnits(balance, decimals);
  } catch {
    return "0";
  }
}

// Get ETH balance
async function getEthBalance(walletAddress: string): Promise<string> {
  try {
    const balance = await baseClient.getBalance({ address: walletAddress as `0x${string}` });
    return formatUnits(balance, 18);
  } catch {
    return "0";
  }
}

// Execute AgentKit action with timeout
async function executeAction(
  agent: AgentKit,
  actionName: string,
  args: Record<string, any> = {}
): Promise<string> {
  const actions = agent.getActions();
  const action = actions.find((a) => a.name === actionName);
  if (!action) return `Action "${actionName}" not found.`;

  try {
    const timeout = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("Action timeout (30s)")), 30000)
    );
    const result = await Promise.race([
      Promise.resolve(action.invoke(args)),
      timeout,
    ]);
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

// Get wallet address (cached)
async function getWalletAddress(agent: AgentKit): Promise<string> {
  if (cachedWalletAddress) return cachedWalletAddress;
  const result = await executeAction(agent, "WalletActionProvider_get_wallet_details");
  // Try to extract address from result
  const match = result.match(/0x[a-fA-F0-9]{40}/);
  if (match) {
    cachedWalletAddress = match[0];
    return cachedWalletAddress;
  }
  return "";
}

// ============================================================
// PERSONALITY & CONVERSATIONAL RESPONSES
// ============================================================
const GREETINGS = [
  "Yo! What's good? 🔥 Your favorite blockchain assistant is here. What we doing today — checking bags, making moves, or just vibing?",
  "Ayyy, what's up! 👋 AIBINGWA in the building. Need me to check your wallet, swap some tokens, or send some bread? Just say the word.",
  "Hey hey! 🚀 Your on-chain homie is ready. Balances, trades, transfers — whatever you need, I got you. What's the play?",
  "Sup! 💎 Ready to make some moves on Base. Just tell me what you need — I speak both crypto and human lol",
  "What's poppin! 🤝 AIBINGWA at your service. Whether it's checking prices, swapping tokens, or sending USDC — I'm locked in. Let's go!",
];

const CASUAL_RESPONSES: Record<string, string[]> = {
  thanks: [
    "Anytime fam! 🤝 That's what I'm here for.",
    "No worries! Hit me up whenever you need anything else 💪",
    "Got you! Always ready when you are 🔥",
  ],
  good: [
    "Glad to hear it! 😎 Need anything else?",
    "Let's keep the momentum going! What's next? 🚀",
  ],
  who: [
    "I'm AIBINGWA — your personal AI blockchain assistant on Base Mainnet 🧠⛓️\n\nI can check balances, swap tokens, send crypto, fetch prices, and more. Think of me as your on-chain co-pilot. Just tell me what you need!",
  ],
  gm: [
    "GM! ☀️ Another day, another opportunity. What are we doing today?",
    "GM fam! 🌅 Ready to make some moves? Just say the word.",
  ],
};

function getRandomResponse(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isGreeting(text: string): boolean {
  const greetings = ["hey", "hi", "hello", "yo", "sup", "what's up", "whats up", "wassup", "howdy", "hola", "ayo"];
  const lower = text.toLowerCase().trim();
  return greetings.some(g => lower === g || lower.startsWith(g + " ") || lower.startsWith(g + "!") || lower.startsWith(g + ","));
}

function getCasualResponse(text: string): string | null {
  const lower = text.toLowerCase().trim();
  if (lower.match(/^(thanks|thank you|thx|ty|appreciate)/)) return getRandomResponse(CASUAL_RESPONSES.thanks);
  if (lower.match(/^(good|nice|cool|great|awesome|dope|fire|lit)/)) return getRandomResponse(CASUAL_RESPONSES.good);
  if (lower.match(/who are you|what are you|about you/)) return getRandomResponse(CASUAL_RESPONSES.who);
  if (lower.match(/^(gm|good morning)/)) return getRandomResponse(CASUAL_RESPONSES.gm);
  if (lower.match(/^(gn|good night)/)) return "GN! 🌙 Rest up, we go again tomorrow. Your bags are safe with me 💎";
  return null;
}

// ============================================================
// NATURAL LANGUAGE PARSER
// ============================================================
interface ParsedIntent {
  action: "send" | "trade" | "swap" | "balance" | "price" | "wallet" | "wrap" | "unwrap" | "help" | "greet" | "casual" | "research" | "trending" | "lowcap" | "snipe" | "bankr" | "bankr-balance" | "unknown";
  amount?: string;
  fromToken?: string;
  toToken?: string;
  recipient?: string;
  token?: string;
  casualResponse?: string;
  bankrPrompt?: string;
}

function parseNaturalLanguage(text: string): ParsedIntent {
  const lower = text.toLowerCase().trim();

  // Greetings first
  if (isGreeting(lower)) return { action: "greet" };

  // Casual conversation
  const casual = getCasualResponse(lower);
  if (casual) return { action: "casual", casualResponse: casual };

  // Send / Transfer: "send 10 usdc to vitalik.eth" or "transfer 0.1 eth to 0x123..."
  const sendMatch = lower.match(/(?:send|transfer)\s+(\$?[\d.]+)\s+(\w+)\s+(?:to\s+)(.+)/i);
  if (sendMatch) {
    return {
      action: "send",
      amount: sendMatch[1].replace("$", ""),
      token: sendMatch[2],
      recipient: sendMatch[3].trim(),
    };
  }

  // Trade / Swap: "trade 5 usdc for eth" or "swap 0.1 eth to usdc" or "buy $5 of eth"
  const tradeMatch = lower.match(/(?:trade|swap|exchange)\s+(\$?[\d.]+)\s+(\w+)\s+(?:for|to|into)\s+(\w+)/i);
  if (tradeMatch) {
    return {
      action: "trade",
      amount: tradeMatch[1].replace("$", ""),
      fromToken: tradeMatch[2],
      toToken: tradeMatch[3],
    };
  }

  // Buy: "buy 5 usdc worth of eth" or "buy $5 of eth"
  const buyMatch = lower.match(/buy\s+(\$?[\d.]+)\s+(?:of\s+)?(\w+)(?:\s+with\s+(\w+))?/i);
  if (buyMatch) {
    return {
      action: "trade",
      amount: buyMatch[1].replace("$", ""),
      fromToken: buyMatch[3] || "usdc",
      toToken: buyMatch[2],
    };
  }

  // Balance: "check my usdc balance" or "how much eth do i have" or "balance of usdc"
  // Also: "bankr balance" or "what's my bankr balance"
  if (lower.includes("bankr") && (lower.includes("balance") || lower.includes("how much"))) {
    return { action: "bankr-balance" };
  }
  const balanceMatch = lower.match(/(?:balance|how much|check)\s+(?:my\s+)?(?:of\s+)?(\w+)?/i);
  if (lower.includes("balance") || lower.includes("how much")) {
    const tokenMatch = lower.match(/(?:balance|how much)\s+(?:my\s+)?(?:of\s+)?(\w+)/i);
    return {
      action: "balance",
      token: tokenMatch ? tokenMatch[1] : undefined,
    };
  }

  // Price: "price of eth" or "what's the eth price" or "how much is btc"
  if (lower.includes("price") || lower.match(/how much is (\w+)/)) {
    const priceMatch = lower.match(/(?:price|how much is)\s+(?:of\s+)?(\w+)/i);
    return {
      action: "price",
      token: priceMatch ? priceMatch[1] : "eth",
    };
  }

  // Wrap: "wrap 0.1 eth"
  if (lower.includes("wrap") && !lower.includes("unwrap")) {
    const wrapMatch = lower.match(/wrap\s+([\d.]+)/);
    return { action: "wrap", amount: wrapMatch ? wrapMatch[1] : "0.001" };
  }

  // Unwrap: "unwrap 0.1 weth"
  if (lower.includes("unwrap")) {
    const unwrapMatch = lower.match(/unwrap\s+([\d.]+)/);
    return { action: "unwrap", amount: unwrapMatch ? unwrapMatch[1] : "0.001" };
  }

  // Wallet
  if (lower.includes("wallet") || lower.includes("address")) {
    return { action: "wallet" };
  }

  // Bankr: research
  const researchMatch = lower.match(/(?:research|analyze|analysis|analyse)\s+(.+)/i);
  if (researchMatch) {
    return { action: "research", token: researchMatch[1].trim() };
  }

  // Bankr: trending
  if (lower.includes("trending") || lower.includes("what's hot") || lower.includes("whats hot") || lower.match(/top.*tokens/)) {
    return { action: "trending" };
  }

  // Bankr: low cap / gems
  if (lower.includes("low cap") || lower.includes("lowcap") || lower.includes("gem") || lower.includes("under 40k") || lower.match(/small.*cap/) || lower.match(/micro.*cap/)) {
    return { action: "lowcap" };
  }

  // Bankr: snipe / buy via Bankr
  const snipeMatch = lower.match(/(?:snipe|ape|ape into)\s+(\$?[\d.]+)\s+(?:of\s+)?(.+)/i);
  if (snipeMatch) {
    return { action: "snipe", amount: snipeMatch[1], token: snipeMatch[2].trim() };
  }

  // Bankr: sentiment
  if (lower.includes("sentiment") || lower.includes("bullish") || lower.includes("bearish")) {
    const sentToken = lower.match(/(?:sentiment|bullish|bearish)\s+(?:on\s+)?(?:for\s+)?(\w+)/i);
    return { action: "research", token: sentToken ? sentToken[1] : "eth" };
  }

  // Help
  if (lower.includes("help") || lower.includes("command") || lower.includes("what can") || lower.includes("menu")) {
    return { action: "help" };
  }

  return { action: "unknown" };
}

// ============================================================
// RESPONSE FORMATTERS
// ============================================================

function formatBalanceResponse(balances: { symbol: string; balance: string; usdValue?: string }[]): string {
  const lines = ["💰 Wallet Balances\n"];
  for (const b of balances) {
    const bal = parseFloat(b.balance);
    if (bal > 0) {
      lines.push(`  ${b.symbol}: ${bal.toFixed(bal < 0.001 ? 8 : 4)}${b.usdValue ? ` (~$${b.usdValue})` : ""}`);
    } else {
      lines.push(`  ${b.symbol}: 0`);
    }
  }
  return lines.join("\n");
}

function formatPriceResponse(symbol: string, result: any): string {
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { return result; }
  }
  if (result.price !== undefined) {
    const price = parseFloat(result.price);
    return `📊 ${symbol.toUpperCase()} Price: $${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `📊 Could not fetch ${symbol} price`;
}

// ============================================================
// BANKR AGENT API CLIENT
// ============================================================
const BANKR_API_URL = "https://api.bankr.bot";
const BANKR_API_KEY = process.env.BANKR_API_KEY || "";
const MAX_MARKET_CAP = parseInt(process.env.MAX_MARKET_CAP || "40000");

interface BankrJobResult {
  success: boolean;
  jobId: string;
  threadId?: string;
  status: string;
  response?: string;
  error?: string;
}

async function bankrPrompt(prompt: string, threadId?: string): Promise<BankrJobResult> {
  if (!BANKR_API_KEY) {
    return { success: false, jobId: "", status: "failed", error: "Bankr API key not configured. Add BANKR_API_KEY to env vars." };
  }

  try {
    // 1. Submit prompt
    const body: any = { prompt };
    if (threadId) body.threadId = threadId;

    const submitRes = await fetch(`${BANKR_API_URL}/agent/prompt`, {
      method: "POST",
      headers: {
        "X-API-Key": BANKR_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      return { success: false, jobId: "", status: "failed", error: `Bankr API error: ${submitRes.status} ${errText}` };
    }

    const submitData = await submitRes.json() as any;
    const jobId = submitData.jobId;
    const resultThreadId = submitData.threadId;

    if (!jobId) {
      return { success: false, jobId: "", status: "failed", error: "No job ID returned from Bankr" };
    }

    // 2. Poll for results (max 60s)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));

      const pollRes = await fetch(`${BANKR_API_URL}/agent/job/${jobId}`, {
        headers: { "X-API-Key": BANKR_API_KEY },
      });

      if (!pollRes.ok) continue;

      const pollData = await pollRes.json() as any;

      if (pollData.status === "completed") {
        return {
          success: true,
          jobId,
          threadId: resultThreadId,
          status: "completed",
          response: pollData.response || "No response",
        };
      }

      if (pollData.status === "failed" || pollData.status === "cancelled") {
        return {
          success: false,
          jobId,
          threadId: resultThreadId,
          status: pollData.status,
          error: pollData.response || pollData.error || "Job failed",
        };
      }
    }

    return { success: false, jobId, status: "timeout", error: "Bankr took too long to respond. Try again!" };
  } catch (err: any) {
    return { success: false, jobId: "", status: "failed", error: err.message };
  }
}

function isBankrConfigured(): boolean {
  return !!BANKR_API_KEY;
}

// ============================================================
// MAIN BOT
// ============================================================
async function main() {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.error("❌ TELEGRAM_BOT_TOKEN is required in .env");
      process.exit(1);
    }

    console.log("🔧 Initializing AgentKit...");
    const agent = await initializeAgentKit();
    console.log("✅ AgentKit initialized on Base Mainnet");

    const bot = new Bot<MyContext>(process.env.TELEGRAM_BOT_TOKEN);

    bot.use(session({ initial: (): SessionData => ({ messageCount: 0 }) }));

    // ── /start ──────────────────────────────────────────────
    bot.command("start", async (ctx) => {
      const name = ctx.from?.first_name || "fam";
      console.log("📨 /start from", ctx.from?.username);
      await ctx.reply(
        `� *Yo ${name}! Welcome to AIBINGWA* 🔥\n\n` +
        `I'm your personal AI blockchain assistant — think of me as your on-chain homie who never sleeps 😤⛓️\n\n` +
        `I run on *Base Mainnet* and I can:\n\n` +
        `💰 Check your bags (ETH, USDC, WETH, DAI...)\n` +
        `🔄 Swap tokens like a DEX pro\n` +
        `📤 Send crypto to anyone (even ENS names!)\n` +
        `📊 Get real-time prices\n` +
        `🔄 Wrap/unwrap ETH\n\n` +
        `🏦 *Bankr AI Trading:*\n` +
        `🔥 Find trending tokens on Base\n` +
        `💎 Hunt low cap gems (<$40k mcap)\n` +
        `🎯 Snipe tokens instantly\n` +
        `📊 Deep market research & sentiment\n\n` +
        `*Just talk to me like a human:*\n` +
        `• _"Send 10 USDC to vitalik.eth"_\n` +
        `• _"Swap 0.01 ETH for USDC"_\n` +
        `• _"Find low cap gems on Base"_\n` +
        `• _"Research PEPE"_\n\n` +
        `Or use commands: /wallet /balance /price /trade /send /trending /lowcap /snipe /research /actions\n\n` +
        `Let's get it! 🚀`,
        { parse_mode: "Markdown" }
      );
    });

    // ── /wallet ─────────────────────────────────────────────
    bot.command("wallet", async (ctx) => {
      console.log("📨 /wallet");
      await ctx.reply("🔍 Fetching wallet...");
      try {
        const addr = await getWalletAddress(agent);
        const ethBal = await getEthBalance(addr);
        const usdcBal = await getTokenBalance(TOKEN_REGISTRY.usdc.address, addr, 6);
        const wethBal = await getTokenBalance(TOKEN_REGISTRY.weth.address, addr, 18);

        await ctx.reply(
          `💼 Wallet\n\n` +
          `Address: ${addr}\n` +
          `Network: Base Mainnet\n\n` +
          `💰 Balances:\n` +
          `  ETH: ${parseFloat(ethBal).toFixed(6)}\n` +
          `  USDC: ${parseFloat(usdcBal).toFixed(2)}\n` +
          `  WETH: ${parseFloat(wethBal).toFixed(6)}`
        );
      } catch (err) {
        console.error("❌ /wallet error:", err);
        await ctx.reply("❌ Error fetching wallet details");
      }
    });

    // ── /balance ────────────────────────────────────────────
    bot.command("balance", async (ctx) => {
      console.log("📨 /balance");
      await ctx.reply("🔍 Checking balances...");
      try {
        const addr = await getWalletAddress(agent);
        const ethBal = await getEthBalance(addr);
        const usdcBal = await getTokenBalance(TOKEN_REGISTRY.usdc.address, addr, 6);
        const wethBal = await getTokenBalance(TOKEN_REGISTRY.weth.address, addr, 18);
        const daiBal = await getTokenBalance(TOKEN_REGISTRY.dai.address, addr, 18);
        const cbethBal = await getTokenBalance(TOKEN_REGISTRY.cbeth.address, addr, 18);

        const response = formatBalanceResponse([
          { symbol: "ETH", balance: ethBal },
          { symbol: "USDC", balance: usdcBal },
          { symbol: "WETH", balance: wethBal },
          { symbol: "DAI", balance: daiBal },
          { symbol: "cbETH", balance: cbethBal },
        ]);
        await ctx.reply(response);
      } catch (err) {
        console.error("❌ /balance error:", err);
        await ctx.reply("❌ Error checking balances");
      }
    });

    // ── /price ──────────────────────────────────────────────
    bot.command("price", async (ctx) => {
      const text = ctx.message?.text || "";
      const parts = text.split(/\s+/);
      const tokenInput = parts[1] || "eth";
      const token = resolveToken(tokenInput);

      if (!token || !token.pythFeedId) {
        await ctx.reply(`❌ Unknown token: ${tokenInput}\n\nSupported: eth, btc, usdc, sol, dai, weth`);
        return;
      }

      await ctx.reply(`📊 Fetching ${token.symbol} price...`);
      const result = await executeAction(agent, "PythActionProvider_fetch_price", {
        priceFeedID: token.pythFeedId,
      });
      await ctx.reply(formatPriceResponse(token.symbol, result));
    });

    // ── /trade ──────────────────────────────────────────────
    bot.command("trade", async (ctx) => {
      const text = ctx.message?.text || "";
      // /trade 5 usdc eth  OR  /trade 5 usdc for eth
      const parts = text.split(/\s+/).filter(p => p.toLowerCase() !== "for" && p.toLowerCase() !== "to");
      if (parts.length < 4) {
        await ctx.reply(
          "📝 Trade format:\n\n" +
          "/trade <amount> <from> <to>\n\n" +
          "Examples:\n" +
          "  /trade 5 usdc eth\n" +
          "  /trade 0.01 eth usdc\n" +
          "  /trade 100 dai usdc"
        );
        return;
      }

      const amount = parts[1];
      const fromToken = resolveToken(parts[2]);
      const toToken = resolveToken(parts[3]);

      if (!fromToken) { await ctx.reply(`❌ Unknown token: ${parts[2]}`); return; }
      if (!toToken) { await ctx.reply(`❌ Unknown token: ${parts[3]}`); return; }

      await ctx.reply(`🔄 Swapping ${amount} ${fromToken.symbol} → ${toToken.symbol}...`);
      try {
        const result = await executeAction(agent, "CdpSmartWalletActionProvider_swap", {
          fromToken: fromToken.address,
          toToken: toToken.address,
          fromAmount: amount,
        });

        try {
          const parsed = JSON.parse(result);
          if (parsed.success === false) {
            await ctx.reply(`Swap didn't go through 😅\n\n${parsed.error || 'Unknown error'}\n\nMake sure you have enough ${fromToken.symbol}!`);
            return;
          }
          if (parsed.success === true) {
            const txHash = parsed.transactionHash || '';
            const toAmount = parsed.toAmount || 'N/A';
            const shortHash = txHash ? `${txHash.slice(0, 6)}...${txHash.slice(-4)}` : 'pending';
            await ctx.reply(
              `✅ *Boom! Swap Complete!* 🎉\n\n` +
              `📤 Sent: ${amount} ${fromToken.symbol}\n` +
              `📥 Received: ${toAmount} ${toToken.symbol}\n\n` +
              `🔗 Tx: \`${shortHash}\`\n\n` +
              `You're a legend! 💪`,
              { parse_mode: "Markdown" }
            );
            return;
          }
        } catch {}
        await ctx.reply(`✅ Swap completed!\n\n${result}`);
      } catch (err: any) {
        await ctx.reply(`Swap failed 😬\n\n${err.message}\n\nTry again or check /balance`);
      }
    });

    // ── /send ───────────────────────────────────────────────
    bot.command("send", async (ctx) => {
      const text = ctx.message?.text || "";
      // /send 10 usdc to vitalik.eth
      const sendMatch = text.match(/\/send\s+(\$?[\d.]+)\s+(\w+)\s+(?:to\s+)?(.+)/i);
      if (!sendMatch) {
        await ctx.reply(
          "📝 Send format:\n\n" +
          "/send <amount> <token> to <address>\n\n" +
          "Examples:\n" +
          "  /send 10 usdc to vitalik.eth\n" +
          "  /send 0.01 eth to 0x1234...abcd\n" +
          "  /send 50 dai to friend.eth"
        );
        return;
      }

      const amount = sendMatch[1].replace("$", "");
      const token = resolveToken(sendMatch[2]);
      const recipientInput = sendMatch[3].trim();

      if (!token) { await ctx.reply(`❌ Unknown token: ${sendMatch[2]}`); return; }

      await ctx.reply(`🔍 Resolving recipient...`);
      const { address: recipientAddr, display } = await resolveAddress(recipientInput);
      if (!recipientAddr) {
        await ctx.reply(`❌ Could not resolve address: ${recipientInput}`);
        return;
      }

      await ctx.reply(`📤 Sending ${amount} ${token.symbol} to ${display}...`);
      try {
        let result: string;
        if (token.symbol === "ETH") {
          result = await executeAction(agent, "WalletActionProvider_native_transfer", {
            to: recipientAddr,
            value: amount,
          });
        } else {
          result = await executeAction(agent, "ERC20ActionProvider_transfer", {
            tokenAddress: token.address,
            destinationAddress: recipientAddr,
            amount: amount,
          });
        }
        
        // Extract transaction hash from result
        const txMatch = result.match(/0x[a-fA-F0-9]{64}/);
        const txHash = txMatch ? txMatch[0] : '';
        const shortHash = txHash ? `${txHash.slice(0, 6)}...${txHash.slice(-4)}` : 'pending';
        
        await ctx.reply(
          `✅ *Transfer Complete!* 🎉\n\n` +
          `📤 Sent: ${amount} ${token.symbol}\n` +
          `📥 To: ${display}\n\n` +
          `🔗 Tx: \`${shortHash}\`\n\n` +
          `Funds are on the way! 💸`,
          { parse_mode: "Markdown" }
        );
      } catch (err: any) {
        const msg = err.message || String(err);
        if (msg.includes('insufficient')) {
          await ctx.reply(`Not enough ${token.symbol} 💸\n\nCheck your balance with /balance`);
        } else {
          await ctx.reply(`Send failed 😬\n\n${msg}\n\nTry again or check /balance`);
        }
      }
    });

    // ── /wrap ───────────────────────────────────────────────
    bot.command("wrap", async (ctx) => {
      const text = ctx.message?.text || "";
      const match = text.match(/([\d.]+)/);
      const amount = match ? match[1] : "0.001";
      await ctx.reply(`🔄 Wrapping ${amount} ETH to WETH...`);
      const result = await executeAction(agent, "WethActionProvider_wrap_eth", { amountToWrap: amount });
      await ctx.reply(`✅ Wrap Result:\n\n${result}`);
    });

    // ── /unwrap ─────────────────────────────────────────────
    bot.command("unwrap", async (ctx) => {
      const text = ctx.message?.text || "";
      const match = text.match(/([\d.]+)/);
      const amount = match ? match[1] : "0.001";
      await ctx.reply(`🔄 Unwrapping ${amount} WETH to ETH...`);
      const result = await executeAction(agent, "WethActionProvider_unwrap_eth", { amountToUnwrap: amount });
      await ctx.reply(`✅ Unwrap Result:\n\n${result}`);
    });

    // ── BANKR COMMANDS ──────────────────────────────────────

    // /research <token> — Market research via Bankr
    bot.command("research", async (ctx) => {
      const text = ctx.message?.text || "";
      const token = text.replace(/^\/research\s*/i, "").trim();
      if (!token) {
        await ctx.reply("📝 Usage: /research <token>\n\nExamples:\n  /research PEPE\n  /research BNKR\n  /research ETH");
        return;
      }
      if (!isBankrConfigured()) {
        await ctx.reply("⚠️ Bankr API not configured yet. Add BANKR_API_KEY to env vars.");
        return;
      }
      await ctx.reply(`🔍 Researching ${token.toUpperCase()}... this may take a moment`);
      const result = await bankrPrompt(`Give me a detailed analysis of ${token}: current price, market cap, 24h volume, 24h change, and brief sentiment. Keep it concise.`);
      if (result.success) {
        await ctx.reply(`📊 *${token.toUpperCase()} Research*\n\n${result.response}`, { parse_mode: "Markdown" });
      } else {
        await ctx.reply(`Couldn't get research data 😅\n\n${result.error}`);
      }
    });

    // /trending — Trending tokens on Base via Bankr
    bot.command("trending", async (ctx) => {
      if (!isBankrConfigured()) {
        await ctx.reply("⚠️ Bankr API not configured yet. Add BANKR_API_KEY to env vars.");
        return;
      }
      await ctx.reply("🔥 Finding trending tokens on Base... hang tight");
      const result = await bankrPrompt("What tokens are trending on Base right now? Show me the top 10 with their prices and 24h changes.");
      if (result.success) {
        await ctx.reply(`🔥 *Trending on Base*\n\n${result.response}`, { parse_mode: "Markdown" });
      } else {
        await ctx.reply(`Couldn't fetch trending tokens 😅\n\n${result.error}`);
      }
    });

    // /lowcap — Find low market cap tokens (under MAX_MARKET_CAP)
    bot.command("lowcap", async (ctx) => {
      if (!isBankrConfigured()) {
        await ctx.reply("⚠️ Bankr API not configured yet. Add BANKR_API_KEY to env vars.");
        return;
      }
      const capStr = (MAX_MARKET_CAP / 1000).toFixed(0);
      await ctx.reply(`🔎 Hunting for gems under $${capStr}k market cap on Base... 🎯`);
      const result = await bankrPrompt(
        `Find me trending or new tokens on Base with a market cap under $${MAX_MARKET_CAP}. ` +
        `Show token name, symbol, price, market cap, 24h volume, and 24h change. ` +
        `Focus on tokens with good volume and momentum. List up to 10 tokens.`
      );
      if (result.success) {
        await ctx.reply(
          `💎 *Low Cap Gems (Under $${capStr}k)*\n\n${result.response}\n\n` +
          `Use /snipe <token> to buy!`,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.reply(`Couldn't find low cap tokens 😅\n\n${result.error}`);
      }
    });

    // /snipe <amount> <token> — Buy a token via Bankr
    bot.command("snipe", async (ctx) => {
      const text = ctx.message?.text || "";
      const match = text.match(/\/snipe\s+(\$?[\d.]+)\s+(.+)/i);
      if (!match) {
        await ctx.reply(
          "🎯 *Snipe Format:*\n\n" +
          "/snipe <amount> <token>\n\n" +
          "Examples:\n" +
          "  /snipe $5 PEPE\n" +
          "  /snipe $10 BNKR\n" +
          "  /snipe 0.01 ETH worth of DEGEN",
          { parse_mode: "Markdown" }
        );
        return;
      }
      if (!isBankrConfigured()) {
        await ctx.reply("⚠️ Bankr API not configured yet. Add BANKR_API_KEY to env vars.");
        return;
      }
      const amount = match[1];
      const token = match[2].trim().toUpperCase();
      await ctx.reply(`🎯 Sniping ${amount} of ${token} on Base... 🔫`);
      const result = await bankrPrompt(`Buy ${amount} of ${token} on Base`);
      if (result.success) {
        await ctx.reply(
          `✅ *Snipe Complete!* 🎯\n\n${result.response}`,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.reply(`Snipe failed 😬\n\n${result.error}\n\nMake sure your Bankr wallet has funds!`);
      }
    });

    // /bankr-balance — Check Bankr wallet balance
    bot.command("bankr-balance", async (ctx) => {
      if (!isBankrConfigured()) {
        await ctx.reply("⚠️ Bankr API not configured yet. Add BANKR_API_KEY to env vars.");
        return;
      }
      await ctx.reply("🏦 Checking Bankr wallet balance...");
      const result = await bankrPrompt("Show me my account info and wallet balance. Include all tokens and their USD values.");
      if (result.success) {
        await ctx.reply(`🏦 *Bankr Wallet*\n\n${result.response}`, { parse_mode: "Markdown" });
      } else {
        await ctx.reply(`Couldn't fetch Bankr balance 😅\n\n${result.error}`);
      }
    });

    // /bankr <prompt> — Raw Bankr prompt for anything
    bot.command("bankr", async (ctx) => {
      const text = ctx.message?.text || "";
      const prompt = text.replace(/^\/bankr\s*/i, "").trim();
      if (!prompt) {
        await ctx.reply(
          "🏦 *Bankr AI — Direct Prompt*\n\n" +
          "Send any trading/DeFi command:\n\n" +
          "  /bankr What tokens are trending on Base?\n" +
          "  /bankr Buy $5 of PEPE on Base\n" +
          "  /bankr Show my portfolio\n" +
          "  /bankr Technical analysis on ETH\n" +
          "  /bankr Set stop loss for ETH at $2500",
          { parse_mode: "Markdown" }
        );
        return;
      }
      if (!isBankrConfigured()) {
        await ctx.reply("⚠️ Bankr API not configured yet. Add BANKR_API_KEY to env vars.");
        return;
      }
      await ctx.reply("🏦 Processing with Bankr AI...");
      const result = await bankrPrompt(prompt);
      if (result.success) {
        await ctx.reply(`🏦 *Bankr*\n\n${result.response}`, { parse_mode: "Markdown" });
      } else {
        await ctx.reply(`Bankr request failed 😅\n\n${result.error}`);
      }
    });

    // ── /actions ────────────────────────────────────────────
    bot.command("actions", async (ctx) => {
      await ctx.reply(
        "🤖 *AIBINGWA Capabilities:*\n\n" +
        "*Wallet*\n" +
        "💼 /wallet — View address & balances\n" +
        "💰 /balance — All token balances\n\n" +
        "*Trading (AgentKit)*\n" +
        "🔄 /trade 5 usdc eth — Swap tokens\n" +
        "🔄 /wrap 0.01 — Wrap ETH to WETH\n" +
        "🔄 /unwrap 0.01 — Unwrap WETH to ETH\n\n" +
        "*Trading (Bankr AI)* 🏦\n" +
        "🎯 /snipe $5 PEPE — Buy tokens\n" +
        "🔍 /research ETH — Market research\n" +
        "� /trending — Trending tokens on Base\n" +
        "💎 /lowcap — Low cap gems (<$40k mcap)\n" +
        "🏦 /bankr <prompt> — Any Bankr command\n\n" +
        "*Transfers*\n" +
        "� /send 10 usdc to vitalik.eth\n\n" +
        "*Prices*\n" +
        "📊 /price eth — Token prices\n\n" +
        "*Natural Language*\n" +
        'Just type naturally like:\n' +
        '• "Send 10 USDC to vitalik.eth"\n' +
        '• "Swap 0.01 ETH for USDC"\n' +
        '• "Find low cap gems on Base"\n' +
        '• "Research PEPE"',
        { parse_mode: "Markdown" }
      );
    });

    // ── NATURAL LANGUAGE HANDLER ────────────────────────────
    bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      console.log("📨 Message:", text);
      const intent = parseNaturalLanguage(text);

      switch (intent.action) {
        case "send": {
          if (!intent.amount || !intent.token || !intent.recipient) {
            await ctx.reply("📝 Try: \"Send 10 USDC to vitalik.eth\"");
            return;
          }
          const token = resolveToken(intent.token);
          if (!token) { await ctx.reply(`Hmm, I don't know that token 🤔 Try: eth, usdc, weth, dai, btc, sol, cbeth`); return; }

          await ctx.reply(`🔍 Resolving recipient...`);
          const { address: addr, display } = await resolveAddress(intent.recipient);
          if (!addr) { await ctx.reply(`Sorry, I couldn't find that address 🤷‍♂️ Try again or check the address!`); return; }

          await ctx.reply(`📤 Sending ${intent.amount} ${token.symbol} to ${display}...`);
          try {
            let result: string;
            if (token.symbol === "ETH") {
              result = await executeAction(agent, "WalletActionProvider_native_transfer", {
                to: addr, value: intent.amount,
              });
            } else {
              result = await executeAction(agent, "ERC20ActionProvider_transfer", {
                tokenAddress: token.address, destinationAddress: addr, amount: intent.amount,
              });
            }
            // Extract transaction hash from result
            const txMatch = result.match(/0x[a-fA-F0-9]{64}/);
            const txHash = txMatch ? txMatch[0] : '';
            const shortHash = txHash ? `${txHash.slice(0, 6)}...${txHash.slice(-4)}` : 'pending';
            
            await ctx.reply(
              `✅ *Transfer Complete!* 🎉\n\n` +
              `📤 Sent: ${intent.amount} ${token.symbol}\n` +
              `📥 To: ${display}\n\n` +
              `🔗 Tx: \`${shortHash}\`\n\n` +
              `Funds are on the way! 💸`,
              { parse_mode: "Markdown" }
            );
          } catch (err: any) {
            const msg = err.message || String(err);
            if (msg.includes('insufficient')) {
              await ctx.reply(`Not enough ${token.symbol} in your wallet 💸\n\nCheck your balance with /balance`);
            } else {
              await ctx.reply(`Send failed 😬\n\n${msg}\n\nTry again or check your balance!`);
            }
          }
          break;
        }

        case "trade": {
          if (!intent.amount || !intent.fromToken || !intent.toToken) {
            await ctx.reply("📝 Try: \"Trade 5 USDC for ETH\" or use /trade 5 usdc eth");
            return;
          }
          const from = resolveToken(intent.fromToken);
          const to = resolveToken(intent.toToken);
          if (!from) { 
            await ctx.reply(`Hmm, I don't know that token 🤔 Try: eth, usdc, weth, dai, btc, sol, cbeth`);
            return;
          }
          if (!to) { 
            await ctx.reply(`Hmm, I don't know that token 🤔 Try: eth, usdc, weth, dai, btc, sol, cbeth`);
            return;
          }

          await ctx.reply(`🔄 Swapping ${intent.amount} ${from.symbol} → ${to.symbol}...`);
          try {
            const result = await executeAction(agent, "CdpSmartWalletActionProvider_swap", {
              fromToken: from.address,
              toToken: to.address,
              fromAmount: intent.amount,
            });
            
            try {
              const parsed = JSON.parse(result);
              if (parsed.success === false) {
                await ctx.reply(`Swap didn't go through 😅\n\n${parsed.error || 'Unknown error'}\n\nMake sure you have enough ${from.symbol}!`);
                return;
              }
              if (parsed.success === true) {
                const txHash = parsed.transactionHash || '';
                const toAmount = parsed.toAmount || 'N/A';
                const shortHash = txHash ? `${txHash.slice(0, 6)}...${txHash.slice(-4)}` : 'pending';
                await ctx.reply(
                  `✅ *Boom! Swap Complete!* 🎉\n\n` +
                  `📤 Sent: ${intent.amount} ${from.symbol}\n` +
                  `📥 Received: ${toAmount} ${to.symbol}\n\n` +
                  `🔗 Tx: \`${shortHash}\`\n\n` +
                  `You're a legend! 💪`,
                  { parse_mode: "Markdown" }
                );
                return;
              }
            } catch {}
            await ctx.reply(`✅ Swap completed!\n\n${result}`);
          } catch (err: any) {
            const msg = err.message || String(err);
            if (msg.includes('undefined')) {
              await ctx.reply(`Swap failed 😬\n\nLooks like there's an issue with that pair. Try a different token combo!`);
            } else if (msg.includes('insufficient')) {
              await ctx.reply(`Not enough ${from.symbol} in your wallet 💸\n\nCheck your balance with /balance`);
            } else if (msg.includes('timeout')) {
              await ctx.reply(`Swap is taking too long ⏱️\n\nTry again in a moment!`);
            } else {
              await ctx.reply(`Swap failed: ${msg}\n\nTry again or check your balance!`);
            }
          }
          break;
        }

        case "balance": {
          await ctx.reply("🔍 Checking balances...");
          try {
            const walletAddr = await getWalletAddress(agent);
            if (intent.token) {
              const token = resolveToken(intent.token);
              if (token && token.address && token.symbol !== "ETH") {
                const bal = await getTokenBalance(token.address, walletAddr, token.decimals);
                await ctx.reply(`💰 ${token.symbol} Balance: ${parseFloat(bal).toFixed(token.decimals <= 6 ? 2 : 6)}`);
              } else {
                const bal = await getEthBalance(walletAddr);
                await ctx.reply(`💰 ETH Balance: ${parseFloat(bal).toFixed(6)}`);
              }
            } else {
              const ethBal = await getEthBalance(walletAddr);
              const usdcBal = await getTokenBalance(TOKEN_REGISTRY.usdc.address, walletAddr, 6);
              const wethBal = await getTokenBalance(TOKEN_REGISTRY.weth.address, walletAddr, 18);
              await ctx.reply(formatBalanceResponse([
                { symbol: "ETH", balance: ethBal },
                { symbol: "USDC", balance: usdcBal },
                { symbol: "WETH", balance: wethBal },
              ]));
            }
          } catch (err: any) {
            await ctx.reply(`❌ Error: ${err.message}`);
          }
          break;
        }

        case "price": {
          const token = resolveToken(intent.token || "eth");
          if (!token || !token.pythFeedId) {
            await ctx.reply(`❌ Unknown token: ${intent.token}`);
            return;
          }
          await ctx.reply(`📊 Fetching ${token.symbol} price...`);
          const result = await executeAction(agent, "PythActionProvider_fetch_price", {
            priceFeedID: token.pythFeedId,
          });
          await ctx.reply(formatPriceResponse(token.symbol, result));
          break;
        }

        case "wallet": {
          await ctx.reply("🔍 Fetching wallet...");
          const addr = await getWalletAddress(agent);
          const ethBal = await getEthBalance(addr);
          await ctx.reply(`💼 Wallet\n\nAddress: ${addr}\nETH: ${parseFloat(ethBal).toFixed(6)}`);
          break;
        }

        case "wrap": {
          await ctx.reply(`🔄 Wrapping ${intent.amount} ETH...`);
          const result = await executeAction(agent, "WethActionProvider_wrap_eth", { amountToWrap: intent.amount });
          await ctx.reply(`✅ ${result}`);
          break;
        }

        case "unwrap": {
          await ctx.reply(`🔄 Unwrapping ${intent.amount} WETH...`);
          const result = await executeAction(agent, "WethActionProvider_unwrap_eth", { amountToUnwrap: intent.amount });
          await ctx.reply(`✅ ${result}`);
          break;
        }

        case "research": {
          if (!isBankrConfigured()) {
            await ctx.reply("⚠️ Bankr API not configured yet. Add BANKR_API_KEY to env vars.");
            break;
          }
          const rToken = intent.token || "eth";
          await ctx.reply(`🔍 Researching ${rToken.toUpperCase()}... this may take a moment`);
          const rResult = await bankrPrompt(`Give me a detailed analysis of ${rToken}: current price, market cap, 24h volume, 24h change, and brief sentiment. Keep it concise.`);
          if (rResult.success) {
            await ctx.reply(`📊 *${rToken.toUpperCase()} Research*\n\n${rResult.response}`, { parse_mode: "Markdown" });
          } else {
            await ctx.reply(`Couldn't get research data 😅\n\n${rResult.error}`);
          }
          break;
        }

        case "trending": {
          if (!isBankrConfigured()) {
            await ctx.reply("⚠️ Bankr API not configured yet. Add BANKR_API_KEY to env vars.");
            break;
          }
          await ctx.reply("🔥 Finding trending tokens on Base... hang tight");
          const tResult = await bankrPrompt("What tokens are trending on Base right now? Show me the top 10 with their prices and 24h changes.");
          if (tResult.success) {
            await ctx.reply(`🔥 *Trending on Base*\n\n${tResult.response}`, { parse_mode: "Markdown" });
          } else {
            await ctx.reply(`Couldn't fetch trending tokens 😅\n\n${tResult.error}`);
          }
          break;
        }

        case "lowcap": {
          if (!isBankrConfigured()) {
            await ctx.reply("⚠️ Bankr API not configured yet. Add BANKR_API_KEY to env vars.");
            break;
          }
          const capStr = (MAX_MARKET_CAP / 1000).toFixed(0);
          await ctx.reply(`🔎 Hunting for gems under $${capStr}k market cap on Base... 🎯`);
          const lcResult = await bankrPrompt(
            `Find me trending or new tokens on Base with a market cap under $${MAX_MARKET_CAP}. ` +
            `Show token name, symbol, price, market cap, 24h volume, and 24h change. ` +
            `Focus on tokens with good volume and momentum. List up to 10 tokens.`
          );
          if (lcResult.success) {
            await ctx.reply(
              `💎 *Low Cap Gems (Under $${capStr}k)*\n\n${lcResult.response}\n\nUse /snipe <amount> <token> to buy!`,
              { parse_mode: "Markdown" }
            );
          } else {
            await ctx.reply(`Couldn't find low cap tokens 😅\n\n${lcResult.error}`);
          }
          break;
        }

        case "snipe": {
          if (!isBankrConfigured()) {
            await ctx.reply("⚠️ Bankr API not configured yet. Add BANKR_API_KEY to env vars.");
            break;
          }
          if (!intent.amount || !intent.token) {
            await ctx.reply("🎯 Try: \"snipe $5 PEPE\" or /snipe $5 PEPE");
            break;
          }
          await ctx.reply(`🎯 Sniping ${intent.amount} of ${intent.token.toUpperCase()} on Base... 🔫`);
          const sResult = await bankrPrompt(`Buy ${intent.amount} of ${intent.token} on Base`);
          if (sResult.success) {
            await ctx.reply(`✅ *Snipe Complete!* 🎯\n\n${sResult.response}`, { parse_mode: "Markdown" });
          } else {
            await ctx.reply(`Snipe failed 😬\n\n${sResult.error}\n\nMake sure your Bankr wallet has funds!`);
          }
          break;
        }

        case "bankr-balance": {
          if (!isBankrConfigured()) {
            await ctx.reply("⚠️ Bankr API not configured yet. Add BANKR_API_KEY to env vars.");
            break;
          }
          await ctx.reply("🏦 Checking Bankr wallet balance...");
          const bbResult = await bankrPrompt("Show me my account info and wallet balance. Include all tokens and their USD values.");
          if (bbResult.success) {
            await ctx.reply(`🏦 *Bankr Wallet*\n\n${bbResult.response}`, { parse_mode: "Markdown" });
          } else {
            await ctx.reply(`Couldn't fetch Bankr balance 😅\n\n${bbResult.error}`);
          }
          break;
        }

        case "greet": {
          await ctx.reply(getRandomResponse(GREETINGS));
          break;
        }

        case "casual": {
          await ctx.reply(intent.casualResponse || "What's good? 🤝");
          break;
        }

        case "help": {
          await ctx.reply(
            "� *I got you! Here's what I can do:*\n\n" +
            "Just talk to me naturally or use commands:\n\n" +
            `• _"Send 10 USDC to vitalik.eth"_\n` +
            `• _"Swap 0.01 ETH for USDC"_\n` +
            `• _"What's my balance?"_\n` +
            `• _"Price of BTC"_\n\n` +
            "Commands: /wallet /balance /price /trade /send /wrap /unwrap /actions",
            { parse_mode: "Markdown" }
          );
          break;
        }

        default: {
          await ctx.reply(
            "Hmm, I didn't quite catch that 🤔\n\n" +
            "Try something like:\n" +
            '• "Check my balance"\n' +
            '• "Price of ETH"\n' +
            '• "Send 10 USDC to vitalik.eth"\n' +
            '• "Trade 5 USDC for ETH"\n\n' +
            "Or hit /actions to see everything I can do!"
          );
        }
      }
    });

    // Error handler
    bot.catch((err) => console.error("Bot error:", err));

    // Start
    console.log("🤖 Starting bot...");
    bot.start();
    console.log("✅ AIBINGWA bot is running! Send /start in Telegram.");
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
}

main().catch(console.error);
