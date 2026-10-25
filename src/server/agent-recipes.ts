import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelOption } from "../types/protocol";

export type { ModelOption };

/**
 * Per-agent launch knowledge. Model lists come from the agent itself where it keeps one on disk
 * (Codex's models cache) or are the agent's own aliases (Claude); nothing names a model version
 * that would go stale. Flags are the ones each CLI's `--help` documents.
 */
export interface AgentRecipe {
  kind: string;
  label: string;
  models(): ModelOption[];
  defaultModel?: string;
  defaultThinking?: string;
  launchArgs(options?: { modelId?: string; thinking?: string }): string[];
  interruptKeys: string[];
}

const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"];

function codexModels(): ModelOption[] {
  const cachePath = join(homedir(), ".codex", "models_cache.json");
  if (!existsSync(cachePath)) return [];
  const data = JSON.parse(readFileSync(cachePath, "utf-8"));
  return (data.models || [])
    .filter((m: any) => m.visibility !== "hide" && typeof m.slug === "string")
    .map((m: any) => ({
      id: m.slug,
      label: m.display_name || m.slug,
      thinkingLevels: (m.supported_reasoning_levels || []).map((l: any) => l.effort).filter((e: unknown) => typeof e === "string"),
    }));
}

export const AGENT_RECIPES: Record<string, AgentRecipe> = {
  claude: {
    kind: "claude",
    label: "Claude Code",
    models: () => [
      { id: "opus", label: "Opus", thinkingLevels: EFFORT_LADDER },
      { id: "sonnet", label: "Sonnet", thinkingLevels: EFFORT_LADDER },
      { id: "haiku", label: "Haiku" },
    ],
    launchArgs(o) {
      return [...(o?.modelId ? ["--model", o.modelId] : []), ...(o?.thinking ? ["--effort", o.thinking] : [])];
    },
    interruptKeys: ["esc"],
  },
  codex: {
    kind: "codex",
    label: "Codex",
    models: codexModels,
    launchArgs(o) {
      return [...(o?.modelId ? ["-m", o.modelId] : []), ...(o?.thinking ? ["-c", `model_reasoning_effort="${o.thinking}"`] : [])];
    },
    interruptKeys: ["esc"],
  },
  agy: {
    kind: "agy",
    label: "Antigravity",
    models: () => [],
    launchArgs(o) {
      return [...(o?.modelId ? ["--model", o.modelId] : []), ...(o?.thinking ? ["--effort", o.thinking] : [])];
    },
    interruptKeys: ["esc"],
  },
  opencode: {
    kind: "opencode",
    label: "OpenCode",
    models: () => [],
    launchArgs: () => [],
    interruptKeys: ["esc"],
  },
  pi: {
    kind: "pi",
    label: "pi",
    models: () => [],
    launchArgs(o) {
      return [...(o?.modelId ? ["--model", o.modelId] : []), ...(o?.thinking ? ["--thinking", o.thinking] : [])];
    },
    interruptKeys: ["esc"],
  },
  terminal: {
    kind: "terminal",
    label: "Terminal 终端",
    models: () => [],
    launchArgs: () => [],
    interruptKeys: ["ctrl+c"],
  },
};

export function getAgentRecipe(kind: string): AgentRecipe | undefined {
  return AGENT_RECIPES[kind.toLowerCase()];
}

export function listAgentRecipes(): AgentRecipe[] {
  return Object.values(AGENT_RECIPES);
}
