# Telegram Blockchain Agent

A Telegram bot that executes real blockchain operations on Base Mainnet using Coinbase AgentKit.

## Features

- 🤖 Real blockchain operations via AgentKit
- 💰 Check wallet balance and details
- 📊 Get token prices from Pyth oracle
- 🔄 Wrap/unwrap ETH to WETH
- 📱 Mobile-friendly Telegram interface
- ⚡ Always-running deployment ready

## Quick Start

### 1. Get a Telegram Bot Token

1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. Choose a name and username (must end in `bot`)
4. Copy the token provided

### 2. Set Up Environment

```bash
cd telegram-bot
npm install
```

Create `.env` file:
```
TELEGRAM_BOT_TOKEN=your_token_here
CDP_API_KEY_ID=your_cdp_api_key_id
CDP_API_KEY_SECRET=your_cdp_api_key_secret
CDP_WALLET_SECRET=your_wallet_secret
NETWORK_ID=base-mainnet
```

### 3. Run Locally

```bash
npm run dev
```

Then open Telegram and find your bot by username.

## Commands

| Command | Action |
|---------|--------|
| `/start` | Welcome message |
| `/wallet` | View wallet address & details |
| `/balance` | Check ETH balance |
| `/price` | Get ETH price |
| `/price btc` | Get BTC price |
| `/price sol` | Get SOL price |
| `/wrap 0.01` | Wrap 0.01 ETH to WETH |
| `/actions` | List all blockchain operations |

## Deploy to Railway (24/7)

Railway keeps your bot running 24/7 for free.

### Steps:

1. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Add telegram bot"
   git push origin main
   ```

2. **Deploy to Railway**
   - Go to https://railway.app
   - Click "New Project"
   - Select "Deploy from GitHub"
   - Choose your repository
   - Railway will auto-detect and deploy

3. **Add Environment Variables**
   - In Railway dashboard, go to Variables
   - Add all variables from `.env`:
     - `TELEGRAM_BOT_TOKEN`
     - `CDP_API_KEY_ID`
     - `CDP_API_KEY_SECRET`
     - `CDP_WALLET_SECRET`
     - `NETWORK_ID`

4. **Done!** Your bot is now running 24/7

## Architecture

```
telegram-bot/
├── src/
│   └── index.ts          # Main bot logic
├── build/                # Compiled output
├── .env                  # Environment variables
├── package.json          # Dependencies
└── railway.json          # Railway deployment config
```

## How It Works

1. User sends a command in Telegram
2. Bot receives the message
3. Bot initializes AgentKit with CDP credentials
4. AgentKit executes the blockchain action
5. Bot returns the real result to the user

All operations execute on **Base Mainnet** with real blockchain data.

## Troubleshooting

### Bot not responding
- Check `TELEGRAM_BOT_TOKEN` is correct
- Verify bot is running: `npm run dev`
- Check logs for errors

### Blockchain operations failing
- Verify CDP credentials are correct
- Check wallet has sufficient funds (for transactions)
- Ensure NETWORK_ID is `base-mainnet`

### Railway deployment issues
- Check Railway logs in dashboard
- Verify all environment variables are set
- Ensure `npm run start` works locally first

## Support

For issues with:
- **AgentKit**: https://docs.cdp.coinbase.com/agentkit
- **Telegram Bot API**: https://core.telegram.org/bots/api
- **Railway**: https://docs.railway.app
