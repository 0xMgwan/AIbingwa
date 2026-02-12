// ============================================================
// SKILL SYSTEM — Pluggable tools the LLM brain can invoke
// ============================================================

export interface SkillParameter {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
  enum?: string[];
}

export interface Skill {
  name: string;
  description: string;
  category: "wallet" | "trading" | "research" | "social" | "utility" | "defi" | "prediction";
  parameters: SkillParameter[];
  execute: (params: Record<string, any>) => Promise<string>;
}

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
    console.log(`🔧 Skill registered: ${skill.name} (${skill.category})`);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  getByCategory(category: string): Skill[] {
    return this.getAll().filter(s => s.category === category);
  }

  // Convert skills to OpenAI function calling format
  toOpenAITools(): any[] {
    return this.getAll().map(skill => ({
      type: "function",
      function: {
        name: skill.name,
        description: skill.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            skill.parameters.map(p => [
              p.name,
              {
                type: p.type,
                description: p.description,
                ...(p.enum ? { enum: p.enum } : {}),
              },
            ])
          ),
          required: skill.parameters.filter(p => p.required).map(p => p.name),
        },
      },
    }));
  }

  // Get a human-readable skill list for the system prompt
  describeSkills(): string {
    const categories = new Map<string, Skill[]>();
    for (const skill of this.getAll()) {
      if (!categories.has(skill.category)) categories.set(skill.category, []);
      categories.get(skill.category)!.push(skill);
    }

    let desc = "";
    for (const [cat, skills] of categories) {
      desc += `\n## ${cat.toUpperCase()} SKILLS:\n`;
      for (const s of skills) {
        const params = s.parameters.map(p => `${p.name}${p.required ? "" : "?"}: ${p.type}`).join(", ");
        desc += `- ${s.name}(${params}): ${s.description}\n`;
      }
    }
    return desc;
  }
}
