import OpenAI from "openai";
import { SkillRegistry } from "./skills.js";
import {
  AgentMemory,
  loadMemory,
  saveMemory,
} from "./memory.js";

// ============================================================
// CONVERSATION MEMORY — Per-user message history
// ============================================================
interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

interface UserProfile {
  chatId: string;
  name: string;
  preferences: string[];
  conversationHistory: ConversationMessage[];
  lastSeen: number;
  interactionCount: number;
}

// ============================================================
// AGENT BRAIN — LLM-powered reasoning engine
// ============================================================
export class AgentBrain {
  private openai: OpenAI;
  private skills: SkillRegistry;
  private users: Map<string, UserProfile> = new Map();
  private agentMemory: AgentMemory;
  private reflections: string[] = [];
  private model: string;

  constructor(skills: SkillRegistry, model = "gpt-4o-mini") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for the agent brain");
    }
    this.openai = new OpenAI({ apiKey });
    this.skills = skills;
    this.agentMemory = loadMemory();
    this.model = model;
    console.log(`🧠 Agent brain initialized (${model})`);
  }

  // ── SYSTEM PROMPT ────────────────────────────────────────
  private buildSystemPrompt(user: UserProfile): string {
    const mem = this.agentMemory;
    const recentLearnings = mem.learnings.slice(-10).join("\n");
    const openPositions = mem.trades.filter(t => t.status === "open");
    const positionsSummary = openPositions.length > 0
      ? openPositions.map(t => `${t.symbol}: ${t.amount} @ ${t.price}`).join(", ")
      : "None";

    return `You are AIBINGWA — a sharp, street-smart AI trading agent on Base blockchain. You're not a basic bot. You THINK, you LEARN, you ADAPT.

## PERSONALITY
- Talk like a savvy trader who's also your homie
- Use emojis naturally but don't overdo it
- Be confident but honest about risks
- Keep responses concise — no walls of text
- When uncertain, say so. Never make up data.
- Use Markdown formatting for readability

## YOUR CAPABILITIES
You have access to these skills (tools). Use them to help the user:
${this.skills.describeSkills()}

## CURRENT STATE
- Open Positions: ${positionsSummary}
- Total Trades: ${mem.totalTrades}
- Win Rate: ${mem.winRate.toFixed(1)}%
- Total P&L: ${mem.totalPnl > 0 ? "+" : ""}${mem.totalPnl.toFixed(2)}%
- Auto-Trade: ${mem.settings.autoTradeEnabled ? "ON" : "OFF"}
- Max Market Cap Filter: $${mem.settings.maxMarketCap}
- Buy Amount: $${mem.settings.maxBuyAmount}

## LEARNINGS FROM PAST TRADES
${recentLearnings || "No learnings yet — still building experience."}

## USER CONTEXT
- Name: ${user.name}
- Interactions: ${user.interactionCount}
- Preferences: ${user.preferences.join(", ") || "None recorded yet"}

## RULES
1. ALWAYS use a skill/tool when the user wants to take an action (check balance, trade, research, etc.)
2. You can chain multiple skills in one response if needed
3. After executing trades, reflect on the decision briefly
4. If the user asks about something you can't do, suggest what you CAN do
5. Never expose private keys, API keys, or sensitive data
6. For prices of tokens not in your registry, use the research_token skill
7. Be proactive — if you notice something interesting, mention it
8. Keep track of what the user cares about and adapt`;
  }

  // ── PROCESS MESSAGE ──────────────────────────────────────
  async processMessage(chatId: string, userName: string, message: string): Promise<string> {
    // Get or create user profile
    let user = this.users.get(chatId);
    if (!user) {
      user = {
        chatId,
        name: userName,
        preferences: [],
        conversationHistory: [],
        lastSeen: Date.now(),
        interactionCount: 0,
      };
      this.users.set(chatId, user);
    }

    user.lastSeen = Date.now();
    user.interactionCount++;
    user.name = userName;

    // Add user message to history
    user.conversationHistory.push({
      role: "user",
      content: message,
      timestamp: Date.now(),
    });

    // Keep conversation history manageable (last 20 messages)
    if (user.conversationHistory.length > 40) {
      user.conversationHistory = user.conversationHistory.slice(-40);
    }

    try {
      // Build messages for OpenAI
      const messages: any[] = [
        { role: "system", content: this.buildSystemPrompt(user) },
        ...user.conversationHistory.slice(-20).map(m => ({
          role: m.role,
          content: m.content,
        })),
      ];

      // Call OpenAI with function calling
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages,
        tools: this.skills.toOpenAITools(),
        tool_choice: "auto",
        temperature: 0.7,
        max_tokens: 1000,
      });

      const choice = response.choices[0];
      let assistantMessage = choice.message.content || "";
      const toolCalls = choice.message.tool_calls;

      // Execute tool calls if any
      if (toolCalls && toolCalls.length > 0) {
        // Add assistant message with tool calls to conversation
        messages.push(choice.message);

        for (const toolCall of toolCalls) {
          const tc = toolCall as any;
          const skillName = tc.function?.name;
          const skill = skillName ? this.skills.get(skillName) : undefined;

          if (skill) {
            try {
              const params = JSON.parse(tc.function.arguments || "{}"  );
              console.log(`🔧 Executing skill: ${skillName}`, params);
              const result = await skill.execute(params);

              messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
              });
            } catch (err: any) {
              messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: `Error: ${err.message}`,
              });
            }
          } else {
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: `Unknown skill: ${skillName}`,
            });
          }
        }

        // Get final response after tool execution
        const finalResponse = await this.openai.chat.completions.create({
          model: this.model,
          messages,
          temperature: 0.7,
          max_tokens: 1000,
        });

        assistantMessage = finalResponse.choices[0].message.content || "Done!";
      }

      // Store assistant response in history
      user.conversationHistory.push({
        role: "assistant",
        content: assistantMessage,
        timestamp: Date.now(),
      });

      // Background: reflect and learn (non-blocking)
      this.reflect(message, assistantMessage).catch(() => {});

      return assistantMessage;
    } catch (err: any) {
      console.error("🧠 Brain error:", err.message);

      // Fallback: return a helpful error
      if (err.message?.includes("API key")) {
        return "⚠️ My brain isn't connected yet. Add OPENAI_API_KEY to env vars to enable AI reasoning.";
      }
      return `Hmm, my brain glitched 🤔 Error: ${err.message}\n\nTry again or use a direct command like /scan, /balance, etc.`;
    }
  }

  // ── REFLECTION LOOP ──────────────────────────────────────
  private async reflect(userMessage: string, response: string): Promise<void> {
    try {
      // Only reflect on meaningful interactions (not greetings)
      if (userMessage.length < 10) return;

      const reflectionPrompt = `You are an AI trading agent reflecting on an interaction.
User said: "${userMessage}"
You responded: "${response}"

In 1 sentence, what did you learn about the user's intent or preferences? If nothing notable, respond with "nothing".`;

      const result = await this.openai.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: reflectionPrompt }],
        temperature: 0.3,
        max_tokens: 100,
      });

      const reflection = result.choices[0].message.content || "";
      if (reflection.toLowerCase() !== "nothing" && reflection.length > 5) {
        this.agentMemory.learnings.push(`[${new Date().toISOString().slice(0, 10)}] ${reflection}`);
        if (this.agentMemory.learnings.length > 100) {
          this.agentMemory.learnings = this.agentMemory.learnings.slice(-100);
        }
        saveMemory(this.agentMemory);
      }
    } catch {
      // Reflection is non-critical, silently fail
    }
  }

  // ── UTILITY ──────────────────────────────────────────────
  reloadMemory(): void {
    this.agentMemory = loadMemory();
  }

  getSkillCount(): number {
    return this.skills.getAll().length;
  }
}
