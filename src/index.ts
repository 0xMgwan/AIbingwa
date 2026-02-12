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
import "dotenv/config";

// Session data for tracking user state
interface SessionData {
  messageCount: number;
}

type MyContext = Context & SessionFlavor<SessionData>;

let agentKit: AgentKit | null = null;

async function initializeAgentKit(): Promise<AgentKit> {
  if (agentKit) return agentKit;

  const walletProvider = await CdpSmartWalletProvider.configureWithWallet({
    apiKeyId: process.env.CDP_API_KEY_ID!,
    apiKeySecret: process.env.CDP_API_KEY_SECRET!,
    walletSecret: process.env.CDP_WALLET_SECRET!,
    networkId: (process.env.NETWORK_ID || "base-mainnet") as any,
  });

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

// Format wallet details nicely
function formatWalletDetails(result: any): string {
  if (typeof result === "string") {
    // Parse if it's a string
    try {
      result = JSON.parse(result);
    } catch {
      return result;
    }
  }

  if (result.address) {
    const lines = [
      `💼 Wallet Details`,
      ``,
      `Address: ${result.address}`,
    ];

    if (result.owner) {
      lines.push(`Owner: ${result.owner}`);
    }

    if (result.network_id) {
      lines.push(`Network: ${result.network_id}`);
    }

    if (result.balance !== undefined) {
      const ethBalance = parseFloat(result.balance) / 1e18;
      lines.push(`Balance: ${ethBalance.toFixed(6)} ETH`);
    }

    return lines.join("\n");
  }

  return JSON.stringify(result, null, 2);
}

// Format price data nicely
function formatPrice(result: any): string {
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      return result;
    }
  }

  if (result.price !== undefined) {
    const price = parseFloat(result.price);
    return `📊 Price: $${price.toFixed(2)}`;
  }

  if (result.success && result.price) {
    const price = parseFloat(result.price);
    return `📊 Price: $${price.toFixed(2)}`;
  }

  return JSON.stringify(result, null, 2);
}

// Find and execute an AgentKit action by name
async function executeAction(
  agent: AgentKit,
  actionName: string,
  args: Record<string, any> = {}
): Promise<string> {
  const actions = agent.getActions();
  const action = actions.find((a) => a.name === actionName);
  if (!action) {
    return `Action "${actionName}" not found.`;
  }
  try {
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("Action timeout (30s)")), 30000)
    );

    const result = await Promise.race([
      Promise.resolve(action.invoke(args)),
      timeoutPromise,
    ]);

    // Format based on action type
    if (actionName.includes("wallet_details")) {
      return formatWalletDetails(result);
    } else if (actionName.includes("price")) {
      return formatPrice(result);
    }

    let text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return text;
  } catch (error: any) {
    return `Error executing ${actionName}: ${error.message}`;
  }
}

// Process user message and route to the right action
async function processMessage(
  agent: AgentKit,
  text: string
): Promise<string> {
  const lower = text.toLowerCase().trim();

  // Wallet details
  if (
    lower.includes("wallet") ||
    lower.includes("address") ||
    lower.includes("balance")
  ) {
    return executeAction(agent, "WalletActionProvider_get_wallet_details");
  }

  // ETH balance
  if (lower.includes("eth balance") || lower === "balance") {
    return executeAction(agent, "WalletActionProvider_get_balance");
  }

  // Token price
  if (lower.includes("price")) {
    // Extract token symbol
    const tokens: Record<string, string> = {
      eth: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
      btc: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
      usdc: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
      sol: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    };

    let tokenId = tokens["eth"]; // default
    let tokenName = "ETH";
    for (const [name, id] of Object.entries(tokens)) {
      if (lower.includes(name)) {
        tokenId = id;
        tokenName = name.toUpperCase();
        break;
      }
    }

    return executeAction(agent, "PythActionProvider_fetch_price", {
      priceFeedID: tokenId,
    });
  }

  // Wrap ETH
  if (lower.includes("wrap")) {
    const amountMatch = lower.match(/(\d+\.?\d*)/);
    const amount = amountMatch ? amountMatch[1] : "0.001";
    return executeAction(agent, "WethActionProvider_wrap_eth", {
      amountToWrap: amount,
    });
  }

  // Transfer
  if (lower.includes("transfer") || lower.includes("send")) {
    return "⚠️ To transfer tokens, use this format:\n\n`/transfer <amount> <token> to <address>`\n\nExample: `/transfer 0.01 ETH to 0x1234...`";
  }

  // List actions
  if (
    lower.includes("help") ||
    lower.includes("command") ||
    lower.includes("action") ||
    lower.includes("what can")
  ) {
    const actions = agent.getActions();
    const list = actions.map((a) => `• \`${a.name}\``).join("\n");
    return `🤖 *Available Blockchain Operations:*\n\n${list}\n\n*Quick Commands:*\n/wallet — Wallet details\n/balance — ETH balance\n/price — ETH price\n/price btc — BTC price\n/actions — List all actions`;
  }

  // Default
  return `🤖 *Blockchain Agent*\n\nI can help you with:\n\n• /wallet — View wallet details\n• /balance — Check ETH balance\n• /price — Get token prices\n• /price btc — BTC price\n• /price sol — SOL price\n• /wrap <amount> — Wrap ETH to WETH\n• /actions — List all available actions\n\nJust type a command or ask me anything!`;
}

async function main() {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.error("❌ TELEGRAM_BOT_TOKEN is required in .env");
      console.log("\nTo get a bot token:");
      console.log("1. Open Telegram and search for @BotFather");
      console.log("2. Send /newbot");
      console.log("3. Follow the prompts to name your bot");
      console.log("4. Copy the token and paste it in .env");
      process.exit(1);
    }

    console.log("🔧 Initializing AgentKit...");
    const agent = await initializeAgentKit();
    console.log("✅ AgentKit initialized on Base Mainnet");

    console.log("🤖 Creating Telegram bot...");
    const bot = new Bot<MyContext>(process.env.TELEGRAM_BOT_TOKEN);

    // Session middleware
    bot.use(
      session({
        initial: (): SessionData => ({ messageCount: 0 }),
      })
    );

    // /start command
    bot.command("start", async (ctx) => {
      console.log("📨 Received /start command from", ctx.from?.username);
      try {
        await ctx.reply(
          "🚀 *Welcome to the Blockchain Agent!*\n\n" +
            "I'm your AI-powered blockchain assistant on *Base Mainnet*.\n\n" +
            "Here's what I can do:\n" +
            "• /wallet — View wallet address & details\n" +
            "• /balance — Check ETH balance\n" +
            "• /price — Get ETH price\n" +
            "• /price btc — Get BTC price\n" +
            "• /wrap <amount> — Wrap ETH to WETH\n" +
            "• /actions — List all blockchain operations\n\n" +
            "Just type a command or ask me anything!",
          { parse_mode: "Markdown" }
        );
        console.log("✅ Sent /start response");
      } catch (err) {
        console.error("❌ Error sending /start response:", err);
      }
    });

    // /wallet command
    bot.command("wallet", async (ctx) => {
      console.log("📨 Received /wallet command");
      await ctx.reply("🔍 Fetching wallet details...");
      try {
        const result = await executeAction(
          agent,
          "WalletActionProvider_get_wallet_details"
        );
        await ctx.reply(`💼 Wallet Details:\n\n${result}`);
        console.log("✅ Sent wallet details");
      } catch (err) {
        console.error("❌ Error fetching wallet:", err);
        await ctx.reply("❌ Error fetching wallet details");
      }
    });

    // /balance command
    bot.command("balance", async (ctx) => {
      console.log("📨 Received /balance command");
      await ctx.reply("🔍 Checking balance...");
      try {
        const result = await executeAction(
          agent,
          "WalletActionProvider_get_wallet_details"
        );
        await ctx.reply(`💰 Balance:\n\n${result}`);
        console.log("✅ Sent balance");
      } catch (err) {
        console.error("❌ Error checking balance:", err);
        await ctx.reply("❌ Error checking balance");
      }
    });

    // /price command
    bot.command("price", async (ctx) => {
      const text = ctx.message?.text || "";
      await ctx.reply("📊 Fetching price...");
      const result = await processMessage(agent, text);
      await ctx.reply(result, { parse_mode: "Markdown" });
    });

    // /actions command
    bot.command("actions", async (ctx) => {
      const actions = agent.getActions();
      const list = actions.map((a) => `• \`${a.name}\``).join("\n");
      await ctx.reply(
        `🤖 *Available Blockchain Operations (${actions.length}):*\n\n${list}`,
        { parse_mode: "Markdown" }
      );
    });

    // /wrap command
    bot.command("wrap", async (ctx) => {
      const text = ctx.message?.text || "";
      const amountMatch = text.match(/(\d+\.?\d*)/);
      const amount = amountMatch ? amountMatch[1] : "0.001";
      await ctx.reply(`🔄 Wrapping ${amount} ETH to WETH...`);
      const result = await executeAction(agent, "WethActionProvider_wrap_eth", {
        amountToWrap: amount,
      });
      await ctx.reply(`✅ *Wrap Result:*\n\n${result}`, {
        parse_mode: "Markdown",
      });
    });

    // Handle all other text messages
    bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      await ctx.reply("⏳ Processing...");
      const result = await processMessage(agent, text);
      await ctx.reply(result, { parse_mode: "Markdown" });
    });

    // Error handler
    bot.catch((err) => {
      console.error("Bot error:", err);
    });

    // Start the bot with polling
    console.log("🤖 Telegram bot starting with polling...");
    bot.start();
    console.log("✅ Bot is running! Send /start in Telegram to begin.");
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
}

main().catch(console.error);
