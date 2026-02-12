import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "data");
const MEMORY_FILE = join(DATA_DIR, "memory.json");
const TRADES_FILE = join(DATA_DIR, "trades.json");

// Ensure data directory exists
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// TYPES
// ============================================================
export interface TradeEntry {
  id: string;
  token: string;
  symbol: string;
  action: "buy" | "sell";
  amount: string;
  price?: string;
  marketCap?: string;
  timestamp: number;
  reason: string;
  bankrResponse?: string;
  pnl?: string;
  status: "open" | "closed" | "failed";
  exitPrice?: string;
  exitTimestamp?: number;
}

export interface TokenMemory {
  symbol: string;
  address?: string;
  lastResearched: number;
  researchSummary: string;
  score: number; // 0-100
  marketCap?: string;
  volume24h?: string;
  sentiment?: string;
  timesTraded: number;
  totalPnl: number;
  lastPrice?: string;
  tags: string[]; // e.g. ["trending", "lowcap", "meme", "risky"]
}

export interface AgentMemory {
  tokens: Record<string, TokenMemory>;
  trades: TradeEntry[];
  learnings: string[];
  lastScanTime: number;
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  settings: {
    maxMarketCap: number;
    maxBuyAmount: string;
    takeProfitPct: number;
    stopLossPct: number;
    scanIntervalMin: number;
    autoTradeEnabled: boolean;
    maxOpenPositions: number;
  };
}

// ============================================================
// DEFAULT MEMORY
// ============================================================
const DEFAULT_MEMORY: AgentMemory = {
  tokens: {},
  trades: [],
  learnings: [],
  lastScanTime: 0,
  totalTrades: 0,
  winRate: 0,
  totalPnl: 0,
  settings: {
    maxMarketCap: parseInt(process.env.MAX_MARKET_CAP || "40000"),
    maxBuyAmount: process.env.MAX_BUY_AMOUNT || "5",
    takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "100"), // 2x = 100% gain
    stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "30"),
    scanIntervalMin: parseInt(process.env.SCAN_INTERVAL_MIN || "30"),
    autoTradeEnabled: process.env.AUTO_TRADE === "true",
    maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || "5"),
  },
};

// ============================================================
// LOAD / SAVE
// ============================================================
export function loadMemory(): AgentMemory {
  try {
    if (existsSync(MEMORY_FILE)) {
      const data = JSON.parse(readFileSync(MEMORY_FILE, "utf-8"));
      return { ...DEFAULT_MEMORY, ...data, settings: { ...DEFAULT_MEMORY.settings, ...data.settings } };
    }
  } catch (err) {
    console.error("⚠️ Failed to load memory:", err);
  }
  return { ...DEFAULT_MEMORY };
}

export function saveMemory(memory: AgentMemory): void {
  try {
    writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (err) {
    console.error("⚠️ Failed to save memory:", err);
  }
}

// ============================================================
// TRADE LOGGING
// ============================================================
export function logTrade(memory: AgentMemory, trade: TradeEntry): AgentMemory {
  memory.trades.push(trade);
  memory.totalTrades++;

  // Update token memory
  if (!memory.tokens[trade.symbol]) {
    memory.tokens[trade.symbol] = {
      symbol: trade.symbol,
      lastResearched: 0,
      researchSummary: "",
      score: 50,
      timesTraded: 0,
      totalPnl: 0,
      tags: [],
    };
  }
  memory.tokens[trade.symbol].timesTraded++;

  saveMemory(memory);
  return memory;
}

export function closeTrade(memory: AgentMemory, tradeId: string, exitPrice: string, pnl: string): AgentMemory {
  const trade = memory.trades.find(t => t.id === tradeId);
  if (trade) {
    trade.status = "closed";
    trade.exitPrice = exitPrice;
    trade.exitTimestamp = Date.now();
    trade.pnl = pnl;

    const pnlNum = parseFloat(pnl);
    memory.totalPnl += pnlNum;

    // Update token memory
    if (memory.tokens[trade.symbol]) {
      memory.tokens[trade.symbol].totalPnl += pnlNum;
    }

    // Recalculate win rate
    const closedTrades = memory.trades.filter(t => t.status === "closed");
    const wins = closedTrades.filter(t => parseFloat(t.pnl || "0") > 0);
    memory.winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;

    // Add learning
    if (pnlNum > 0) {
      memory.learnings.push(`✅ ${trade.symbol}: +${pnl}% — ${trade.reason}`);
    } else {
      memory.learnings.push(`❌ ${trade.symbol}: ${pnl}% — ${trade.reason}`);
    }

    // Keep learnings manageable (last 100)
    if (memory.learnings.length > 100) {
      memory.learnings = memory.learnings.slice(-100);
    }
  }

  saveMemory(memory);
  return memory;
}

// ============================================================
// TOKEN MEMORY
// ============================================================
export function updateTokenMemory(
  memory: AgentMemory,
  symbol: string,
  data: Partial<TokenMemory>
): AgentMemory {
  if (!memory.tokens[symbol]) {
    memory.tokens[symbol] = {
      symbol,
      lastResearched: 0,
      researchSummary: "",
      score: 50,
      timesTraded: 0,
      totalPnl: 0,
      tags: [],
    };
  }
  Object.assign(memory.tokens[symbol], data);
  saveMemory(memory);
  return memory;
}

export function getOpenPositions(memory: AgentMemory): TradeEntry[] {
  return memory.trades.filter(t => t.status === "open");
}

export function getTradeHistory(memory: AgentMemory, limit = 20): TradeEntry[] {
  return memory.trades.slice(-limit);
}

export function getPerformanceSummary(memory: AgentMemory): string {
  const open = getOpenPositions(memory);
  const closed = memory.trades.filter(t => t.status === "closed");
  const wins = closed.filter(t => parseFloat(t.pnl || "0") > 0);
  const losses = closed.filter(t => parseFloat(t.pnl || "0") <= 0);

  return (
    `📊 *Trading Performance*\n\n` +
    `Total Trades: ${memory.totalTrades}\n` +
    `Open Positions: ${open.length}\n` +
    `Closed: ${closed.length} (${wins.length}W / ${losses.length}L)\n` +
    `Win Rate: ${memory.winRate.toFixed(1)}%\n` +
    `Total P&L: ${memory.totalPnl > 0 ? "+" : ""}${memory.totalPnl.toFixed(2)}%\n\n` +
    `*Settings:*\n` +
    `Max Market Cap: $${(memory.settings.maxMarketCap / 1000).toFixed(0)}k\n` +
    `Buy Amount: $${memory.settings.maxBuyAmount}\n` +
    `Take Profit: ${memory.settings.takeProfitPct}%\n` +
    `Stop Loss: ${memory.settings.stopLossPct}%\n` +
    `Auto-Trade: ${memory.settings.autoTradeEnabled ? "ON 🟢" : "OFF 🔴"}\n` +
    `Scan Interval: ${memory.settings.scanIntervalMin}min`
  );
}
