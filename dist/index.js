// src/index.ts
import { Bot, session } from "grammy";
import {
  AgentKit,
  cdpApiActionProvider,
  cdpSmartWalletActionProvider,
  erc20ActionProvider,
  pythActionProvider,
  CdpSmartWalletProvider,
  walletActionProvider,
  wethActionProvider
} from "@coinbase/agentkit";
import "dotenv/config";
var agentKit = null;
async function initializeAgentKit() {
  if (agentKit) return agentKit;
  const walletProvider = await CdpSmartWalletProvider.configureWithWallet({
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
    walletSecret: process.env.CDP_WALLET_SECRET,
    networkId: process.env.NETWORK_ID || "base-mainnet"
  });
  agentKit = await AgentKit.from({
    walletProvider,
    actionProviders: [
      walletActionProvider(),
      erc20ActionProvider(),
      wethActionProvider(),
      pythActionProvider(),
      cdpApiActionProvider(),
      cdpSmartWalletActionProvider()
    ]
  });
  return agentKit;
}
async function executeAction(agent, actionName, args = {}) {
  const actions = agent.getActions();
  const action = actions.find((a) => a.name === actionName);
  if (!action) {
    return `Action "${actionName}" not found.`;
  }
  try {
    const result = await action.invoke(args);
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch (error) {
    return `Error executing ${actionName}: ${error.message}`;
  }
}
async function processMessage(agent, text) {
  const lower = text.toLowerCase().trim();
  if (lower.includes("wallet") || lower.includes("address") || lower.includes("balance")) {
    return executeAction(agent, "WalletActionProvider_get_wallet_details");
  }
  if (lower.includes("eth balance") || lower === "balance") {
    return executeAction(agent, "WalletActionProvider_get_balance");
  }
  if (lower.includes("price")) {
    const tokens = {
      eth: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
      btc: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
      usdc: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
      sol: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
    };
    let tokenId = tokens["eth"];
    let tokenName = "ETH";
    for (const [name, id] of Object.entries(tokens)) {
      if (lower.includes(name)) {
        tokenId = id;
        tokenName = name.toUpperCase();
        break;
      }
    }
    return executeAction(agent, "PythActionProvider_fetch_price", {
      priceFeedID: tokenId
    });
  }
  if (lower.includes("wrap")) {
    const amountMatch = lower.match(/(\d+\.?\d*)/);
    const amount = amountMatch ? amountMatch[1] : "0.001";
    return executeAction(agent, "WethActionProvider_wrap_eth", {
      amountToWrap: amount
    });
  }
  if (lower.includes("transfer") || lower.includes("send")) {
    return "\u26A0\uFE0F To transfer tokens, use this format:\n\n`/transfer <amount> <token> to <address>`\n\nExample: `/transfer 0.01 ETH to 0x1234...`";
  }
  if (lower.includes("help") || lower.includes("command") || lower.includes("action") || lower.includes("what can")) {
    const actions = agent.getActions();
    const list = actions.map((a) => `\u2022 \`${a.name}\``).join("\n");
    return `\u{1F916} *Available Blockchain Operations:*

${list}

*Quick Commands:*
/wallet \u2014 Wallet details
/balance \u2014 ETH balance
/price \u2014 ETH price
/price btc \u2014 BTC price
/actions \u2014 List all actions`;
  }
  return `\u{1F916} *Blockchain Agent*

I can help you with:

\u2022 /wallet \u2014 View wallet details
\u2022 /balance \u2014 Check ETH balance
\u2022 /price \u2014 Get token prices
\u2022 /price btc \u2014 BTC price
\u2022 /price sol \u2014 SOL price
\u2022 /wrap <amount> \u2014 Wrap ETH to WETH
\u2022 /actions \u2014 List all available actions

Just type a command or ask me anything!`;
}
async function main() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("\u274C TELEGRAM_BOT_TOKEN is required in .env");
    console.log("\nTo get a bot token:");
    console.log("1. Open Telegram and search for @BotFather");
    console.log("2. Send /newbot");
    console.log("3. Follow the prompts to name your bot");
    console.log("4. Copy the token and paste it in .env");
    process.exit(1);
  }
  console.log("\u{1F527} Initializing AgentKit...");
  const agent = await initializeAgentKit();
  console.log("\u2705 AgentKit initialized on Base Mainnet");
  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
  bot.use(
    session({
      initial: () => ({ messageCount: 0 })
    })
  );
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "\u{1F680} *Welcome to the Blockchain Agent!*\n\nI'm your AI-powered blockchain assistant on *Base Mainnet*.\n\nHere's what I can do:\n\u2022 /wallet \u2014 View wallet address & details\n\u2022 /balance \u2014 Check ETH balance\n\u2022 /price \u2014 Get ETH price\n\u2022 /price btc \u2014 Get BTC price\n\u2022 /wrap <amount> \u2014 Wrap ETH to WETH\n\u2022 /actions \u2014 List all blockchain operations\n\nJust type a command or ask me anything!",
      { parse_mode: "Markdown" }
    );
  });
  bot.command("wallet", async (ctx) => {
    await ctx.reply("\u{1F50D} Fetching wallet details...");
    const result = await executeAction(
      agent,
      "WalletActionProvider_get_wallet_details"
    );
    await ctx.reply(`\u{1F4BC} *Wallet Details:*

${result}`, {
      parse_mode: "Markdown"
    });
  });
  bot.command("balance", async (ctx) => {
    await ctx.reply("\u{1F50D} Checking balance...");
    const result = await executeAction(
      agent,
      "WalletActionProvider_get_wallet_details"
    );
    await ctx.reply(`\u{1F4B0} *Balance:*

${result}`, {
      parse_mode: "Markdown"
    });
  });
  bot.command("price", async (ctx) => {
    const text = ctx.message?.text || "";
    await ctx.reply("\u{1F4CA} Fetching price...");
    const result = await processMessage(agent, text);
    await ctx.reply(result, { parse_mode: "Markdown" });
  });
  bot.command("actions", async (ctx) => {
    const actions = agent.getActions();
    const list = actions.map((a) => `\u2022 \`${a.name}\``).join("\n");
    await ctx.reply(
      `\u{1F916} *Available Blockchain Operations (${actions.length}):*

${list}`,
      { parse_mode: "Markdown" }
    );
  });
  bot.command("wrap", async (ctx) => {
    const text = ctx.message?.text || "";
    const amountMatch = text.match(/(\d+\.?\d*)/);
    const amount = amountMatch ? amountMatch[1] : "0.001";
    await ctx.reply(`\u{1F504} Wrapping ${amount} ETH to WETH...`);
    const result = await executeAction(agent, "WethActionProvider_wrap_eth", {
      amountToWrap: amount
    });
    await ctx.reply(`\u2705 *Wrap Result:*

${result}`, {
      parse_mode: "Markdown"
    });
  });
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    await ctx.reply("\u23F3 Processing...");
    const result = await processMessage(agent, text);
    await ctx.reply(result, { parse_mode: "Markdown" });
  });
  bot.catch((err) => {
    console.error("Bot error:", err);
  });
  console.log("\u{1F916} Telegram bot starting...");
  await bot.start({
    onStart: () => {
      console.log("\u2705 Bot is running! Send /start in Telegram to begin.");
    }
  });
}
main().catch(console.error);
//# sourceMappingURL=index.js.map