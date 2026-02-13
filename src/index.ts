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

// Import from aibingwa-agent package
import {
  AgentBingwa,
  SkillRegistry,
  loadMemory,
  getPerformanceSummary,
  getOpenPositions,
  getTradeHistory,
} from "aibingwa-agent";

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
  pepe: {
    symbol: "PEPE",
    name: "Pepe",
    address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
    decimals: 18,
  },
  degen: {
    symbol: "DEGEN",
    name: "Degen",
    address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
    decimals: 18,
  },
  bnkr: {
    symbol: "BNKR",
    name: "Bankr",
    address: "",
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
  if (process.env.OWNER_ADDRESS && process.env.SMART_WALLET_ADDRESS) {
    console.log("📂 Loading wallet from env vars");
    return {
      ownerAddress: process.env.OWNER_ADDRESS,
      smartWalletAddress: process.env.SMART_WALLET_ADDRESS,
    };
  }
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

  if (savedWallet) {
    config.owner = savedWallet.ownerAddress;
    config.address = savedWallet.smartWalletAddress;
    console.log("🔑 Reloading existing wallet:", savedWallet.smartWalletAddress);
  } else {
    console.log("🆕 Creating new wallet (first run)...");
  }

  const walletProvider = await CdpSmartWalletProvider.configureWithWallet(config);

  const exported = await walletProvider.exportWallet();
  const walletData: WalletData = {
    ownerAddress: exported.ownerAddress,
    smartWalletAddress: exported.address,
  };

  cachedWalletAddress = exported.address;

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

function resolveToken(input: string): typeof TOKEN_REGISTRY[string] | null {
  const key = input.toLowerCase().trim();
  if (TOKEN_REGISTRY[key]) return TOKEN_REGISTRY[key];
  for (const entry of Object.values(TOKEN_REGISTRY)) {
    if (entry.symbol.toLowerCase() === key) return entry;
  }
  if (isAddress(input)) {
    for (const entry of Object.values(TOKEN_REGISTRY)) {
      if (entry.address.toLowerCase() === input.toLowerCase()) return entry;
    }
  }
  return null;
}

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

async function getEthBalance(walletAddress: string): Promise<string> {
  try {
    const balance = await baseClient.getBalance({ address: walletAddress as `0x${string}` });
    return formatUnits(balance, 18);
  } catch {
    return "0";
  }
}

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

async function getWalletAddress(agent: AgentKit): Promise<string> {
  if (cachedWalletAddress) return cachedWalletAddress;
  const result = await executeAction(agent, "WalletActionProvider_get_wallet_details");
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

  if (isGreeting(lower)) return { action: "greet" };

  const casual = getCasualResponse(lower);
  if (casual) return { action: "casual", casualResponse: casual };

  const sendMatch = lower.match(/(?:send|transfer)\s+(\$?[\d.]+)\s+(\w+)\s+(?:to\s+)(.+)/i);
  if (sendMatch) {
    return {
      action: "send",
      amount: sendMatch[1].replace("$", ""),
      token: sendMatch[2],
      recipient: sendMatch[3].trim(),
    };
  }

  const tradeMatch = lower.match(/(?:trade|swap|exchange)\s+(\$?[\d.]+)\s+(\w+)\s+(?:for|to|into)\s+(\w+)/i);
  if (tradeMatch) {
    return {
      action: "trade",
      amount: tradeMatch[1].replace("$", ""),
      fromToken: tradeMatch[2],
      toToken: tradeMatch[3],
    };
  }

  const buyMatch = lower.match(/buy\s+(\$?[\d.]+)\s+(?:of\s+)?(\w+)(?:\s+with\s+(\w+))?/i);
  if (buyMatch) {
    return {
      action: "trade",
      amount: buyMatch[1].replace("$", ""),
      fromToken: buyMatch[3] || "usdc",
      toToken: buyMatch[2],
    };
  }

  if (lower.includes("bankr") && (lower.includes("balance") || lower.includes("how much"))) {
    return { action: "bankr-balance" };
  }

  const balanceMatch = lower.match(/(?:balance|how much|check)\s+(?:my\s+)?(?:of\s+)?(\w+)?/i);
  if (balanceMatch) {
    return { action: "balance", token: balanceMatch[1] || "eth" };
  }

  const priceMatch = lower.match(/(?:price|cost|worth)\s+(?:of\s+)?(\w+)/i);
  if (priceMatch) {
    return { action: "price", token: priceMatch[1] };
  }

  if (lower.match(/wallet|address|my account/)) return { action: "wallet" };
  if (lower.match(/wrap\s+(\d+)/)) {
    const m = lower.match(/wrap\s+(\d+)/);
    return { action: "wrap", amount: m?.[1] || "1" };
  }
  if (lower.match(/unwrap\s+(\d+)/)) {
    const m = lower.match(/unwrap\s+(\d+)/);
    return { action: "unwrap", amount: m?.[1] || "1" };
  }

  if (lower.match(/help|what can you do|actions|commands/)) return { action: "help" };

  return { action: "unknown" };
}

// ============================================================
// FORMATTING HELPERS
// ============================================================
function formatBalanceResponse(balances: Array<{ symbol: string; balance: string }>): string {
  const lines = ["💼 **Your Balances**\n"];
  for (const b of balances) {
    const bal = parseFloat(b.balance).toFixed(6);
    lines.push(`${b.symbol}: ${bal}`);
  }
  return lines.join("\n");
}

function formatPriceResponse(symbol: string, priceData: string): string {
  return `📊 **${symbol} Price**\n\n${priceData}`;
}

// ============================================================
// MAIN BOT
// ============================================================
async function main() {
  try {
    // Initialize AgentKit
    const agent = await initializeAgentKit();

    // Create Telegram bot
    const bot = new Bot<MyContext>(process.env.TELEGRAM_BOT_TOKEN!);

    // Session middleware
    bot.use(session({ initial: () => ({ messageCount: 0 }) }));

    // Initialize AIBINGWA agent
    const aibingwa = new AgentBingwa({
      openaiApiKey: process.env.OPENAI_API_KEY,
      bankrApiKey: process.env.BANKR_API_KEY,
      x402PrivateKey: process.env.X402_PRIVATE_KEY,
      dataDir: join(__dirname, "..", "data"),
      onNotify: async (msg: string) => {
        if (process.env.OWNER_CHAT_ID) {
          try {
            await bot.api.sendMessage(process.env.OWNER_CHAT_ID, msg, { parse_mode: "Markdown" });
          } catch (err) {
            console.error("Failed to send notification:", err);
          }
        }
      },
    });

    // Register custom skills for this bot
    aibingwa.skills.register({
      name: "get_wallet_balance",
      description: "Get the balance of a specific token in the wallet",
      category: "wallet",
      parameters: [
        { name: "token", type: "string", description: "Token symbol (eth, usdc, weth, etc)", required: true },
      ],
      execute: async (params: any) => {
        const token = resolveToken(params.token);
        if (!token) return `Unknown token: ${params.token}`;
        const walletAddr = await getWalletAddress(agent);
        if (token.symbol === "ETH") {
          const bal = await getEthBalance(walletAddr);
          return `${token.symbol}: ${parseFloat(bal).toFixed(6)}`;
        }
        const bal = await getTokenBalance(token.address, walletAddr, token.decimals);
        return `${token.symbol}: ${parseFloat(bal).toFixed(6)}`;
      },
    });

    aibingwa.skills.register({
      name: "swap_tokens",
      description: "Swap one token for another using AgentKit",
      category: "trading",
      parameters: [
        { name: "fromToken", type: "string", description: "Source token symbol", required: true },
        { name: "toToken", type: "string", description: "Destination token symbol", required: true },
        { name: "amount", type: "string", description: "Amount to swap", required: true },
      ],
      execute: async (params: any) => {
        const from = resolveToken(params.fromToken);
        const to = resolveToken(params.toToken);
        if (!from || !to) return "Invalid token symbols";
        const result = await executeAction(agent, "CdpSmartWalletActionProvider_swap", {
          fromToken: from.address,
          toToken: to.address,
          fromAmount: params.amount,
        });
        return result;
      },
    });

    // Commands
    bot.command("start", async (ctx) => {
      await ctx.reply(getRandomResponse(GREETINGS));
    });

    bot.command("help", async (ctx) => {
      const help = `🤖 **AIBINGWA Bot Commands**\n\n` +
        `*Wallet & Balance:*\n` +
        `• /balance — Check your balances\n` +
        `• /wallet — Show wallet address\n\n` +
        `*Trading:*\n` +
        `• "Swap 5 USDC for ETH"\n` +
        `• "Buy $10 of DEGEN"\n\n` +
        `*Transfers:*\n` +
        `• "Send 10 USDC to vitalik.eth"\n\n` +
        `*Prices:*\n` +
        `• "Price of ETH"\n\n` +
        `*AI Agent:*\n` +
        `• Just chat naturally — I'll figure it out! 🧠`;
      await ctx.reply(help, { parse_mode: "Markdown" });
    });

    bot.command("balance", async (ctx) => {
      await ctx.reply("🔍 Checking balances...");
      try {
        const walletAddr = await getWalletAddress(agent);
        const ethBal = await getEthBalance(walletAddr);
        const usdcBal = await getTokenBalance(TOKEN_REGISTRY.usdc.address, walletAddr, 6);
        const wethBal = await getTokenBalance(TOKEN_REGISTRY.weth.address, walletAddr, 18);
        await ctx.reply(formatBalanceResponse([
          { symbol: "ETH", balance: ethBal },
          { symbol: "USDC", balance: usdcBal },
          { symbol: "WETH", balance: wethBal },
        ]));
      } catch (err: any) {
        await ctx.reply(`❌ Error: ${err.message}`);
      }
    });

    // Message handler
    bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      const intent = parseNaturalLanguage(text);

      switch (intent.action) {
        case "send": {
          if (!intent.amount || !intent.token || !intent.recipient) {
            await ctx.reply("📝 Try: \"Send 10 USDC to vitalik.eth\"");
            return;
          }
          const token = resolveToken(intent.token);
          if (!token) {
            await ctx.reply(`Unknown token: ${intent.token}`);
            return;
          }
          const addr = await resolveAddress(intent.recipient);
          if (!addr.address) {
            await ctx.reply(`Can't resolve address: ${intent.recipient}`);
            return;
          }
          await ctx.reply(`📤 Sending ${intent.amount} ${token.symbol} to ${addr.display}...`);
          try {
            const result = await executeAction(agent, "WalletActionProvider_send_funds", {
              amount: intent.amount,
              to: addr.address,
              assetId: token.address || "eth",
            });
            await ctx.reply(`✅ Sent!\n\n${result}`);
          } catch (err: any) {
            const msg: string = err.message || String(err);
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
          if (!from || !to) {
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
            await ctx.reply(`✅ Swap completed!\n\n${result}`);
          } catch (err: any) {
            await ctx.reply(`Swap failed: ${err.message}\n\nTry again or check your balance!`);
          }
          break;
        }

        case "balance": {
          await ctx.reply("🔍 Checking balances...");
          try {
            const walletAddr = await getWalletAddress(agent);
            const ethBal = await getEthBalance(walletAddr);
            const usdcBal = await getTokenBalance(TOKEN_REGISTRY.usdc.address, walletAddr, 6);
            const wethBal = await getTokenBalance(TOKEN_REGISTRY.weth.address, walletAddr, 18);
            await ctx.reply(formatBalanceResponse([
              { symbol: "ETH", balance: ethBal },
              { symbol: "USDC", balance: usdcBal },
              { symbol: "WETH", balance: wethBal },
            ]));
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
          const result = await executeAction(agent, "PythActionProvider_fetch_price", { priceFeedID: token.pythFeedId });
          await ctx.reply(formatPriceResponse(token.symbol, result));
          break;
        }

        case "wallet": {
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

        case "greet": {
          await ctx.reply(getRandomResponse(GREETINGS));
          break;
        }

        case "casual": {
          await ctx.reply(intent.casualResponse || "What's good? 🤝");
          break;
        }

        default: {
          await ctx.reply(
            "Hmm, I didn't quite catch that 🤔\n\n" +
            "Try something like:\n" +
            '• "Check my balance"\n' +
            '• "Price of ETH"\n' +
            '• "Send 10 USDC to vitalik.eth"\n\n' +
            "Or hit /help to see everything I can do!"
          );
        }
      }
    });

    bot.catch((err) => console.error("Bot error:", err));

    console.log("🤖 Starting bot...");
    bot.start();
    console.log("✅ AIBINGWA bot is running! Send /start in Telegram.");
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
}

main().catch(console.error);
