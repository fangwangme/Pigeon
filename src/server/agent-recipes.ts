export interface ModelOption {
  id: string;
  label: string;
  thinkingLevels?: string[];
}

export interface AgentRecipe {
  kind: string;
  label: string;
  models: ModelOption[];
  defaultModel?: string;
  defaultThinking?: string;
  launchArgs(options?: { modelId?: string; thinking?: string }): string[];
  interruptKeys: string[];
}

export const AGENT_RECIPES: Record<string, AgentRecipe> = {
  claude: {
    kind: "claude",
    label: "Claude Code",
    models: [
      { id: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet", thinkingLevels: ["off", "low", "medium", "high"] },
      { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku", label: "Claude 3.5 Haiku" },
      { id: "claude-3-opus", label: "Claude 3 Opus" },
    ],
    defaultModel: "claude-3-7-sonnet",
    defaultThinking: "medium",
    launchArgs(options) {
      const args: string[] = [];
      if (options?.modelId) {
        args.push("--model", options.modelId);
      }
      return args;
    },
    interruptKeys: ["esc"],
  },
  codex: {
    kind: "codex",
    label: "Codex",
    models: [
      { id: "o3-mini", label: "o3-mini", thinkingLevels: ["low", "medium", "high"] },
      { id: "o1", label: "o1" },
      { id: "gpt-4.5-preview", label: "GPT-4.5 Preview" },
      { id: "gpt-4o", label: "GPT-4o" },
    ],
    defaultModel: "o3-mini",
    defaultThinking: "medium",
    launchArgs(options) {
      const args: string[] = [];
      if (options?.modelId) {
        args.push("-m", options.modelId);
      }
      return args;
    },
    interruptKeys: ["ctrl+c"],
  },
  agy: {
    kind: "agy",
    label: "Antigravity",
    models: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", thinkingLevels: ["off", "low", "medium", "high"] },
      { id: "gemini-3.8-pro", label: "Gemini 3.8 Pro", thinkingLevels: ["low", "medium", "high"] },
      { id: "gemini-3-flash", label: "Gemini 3 Flash" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
    defaultModel: "gemini-3.8-flash",
    defaultThinking: "medium",
    launchArgs(options) {
      const args: string[] = [];
      if (options?.modelId) {
        args.push("--model", options.modelId);
      }
      return args;
    },
    interruptKeys: ["esc"],
  },
  opencode: {
    kind: "opencode",
    label: "OpenCode",
    models: [
      { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "deepseek-chat", label: "DeepSeek-V3" },
    ],
    defaultModel: "claude-3-5-sonnet",
    launchArgs(options) {
      const args: string[] = [];
      if (options?.modelId) {
        args.push("--model", options.modelId);
      }
      return args;
    },
    interruptKeys: ["ctrl+c"],
  },
  pi: {
    kind: "pi",
    label: "pi",
    models: [
      { id: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet", thinkingLevels: ["off", "low", "medium", "high"] },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
    defaultModel: "claude-3-7-sonnet",
    defaultThinking: "low",
    launchArgs(options) {
      const args: string[] = [];
      if (options?.modelId) {
        args.push("--model", options.modelId);
      }
      return args;
    },
    interruptKeys: ["esc"],
  },
  terminal: {
    kind: "terminal",
    label: "Terminal 终端",
    models: [],
    launchArgs() {
      return [];
    },
    interruptKeys: ["ctrl+c"],
  },
};

export function getAgentRecipe(kind: string): AgentRecipe | undefined {
  return AGENT_RECIPES[kind.toLowerCase()];
}

export function listAgentRecipes(): AgentRecipe[] {
  return Object.values(AGENT_RECIPES);
}
