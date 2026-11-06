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
  /** Program started in the new tab (`herdr-adapter.md` §5); none starts the machine's shell. */
  command?: string;
  models(): ModelOption[];
  defaultModel?: string;
  defaultThinking?: string;
  /** `resume` is the value the resume argument takes (`herdr-adapter.md` §5); set only when `resumable`. */
  launchArgs(options?: { modelId?: string; thinking?: string; resume?: string }): string[];
  interruptKeys: string[];
  resumable: boolean;
  /** Prefix for an attachment's path in a prompt (`protocol.md` §4.2). */
  mentionPrefix: string;
  /** The agent's own runtime commands (`herdr-adapter.md` §7); absent when it has none. */
  runtimeModelCommand?: (modelId: string) => string;
  runtimeThinkingCommand?: (level: string) => string;
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
    command: "claude",
    models: () => [
      { id: "opus", label: "Opus", thinkingLevels: EFFORT_LADDER },
      { id: "sonnet", label: "Sonnet", thinkingLevels: EFFORT_LADDER },
      { id: "haiku", label: "Haiku" },
    ],
    launchArgs(o) {
      return [...(o?.resume ? ["--resume", o.resume] : []), ...(o?.modelId ? ["--model", o.modelId] : []), ...(o?.thinking ? ["--effort", o.thinking] : [])];
    },
    interruptKeys: ["esc"],
    resumable: true,
    mentionPrefix: "@",
    runtimeModelCommand: (id) => `/model ${id}`,
  },
  codex: {
    kind: "codex",
    label: "Codex",
    command: "codex",
    models: codexModels,
    launchArgs(o) {
      // Without --no-daemon Codex runs its commands outside Herdr Core.
      return [
        "--no-daemon",
        ...(o?.resume ? ["resume", o.resume] : []),
        ...(o?.modelId ? ["-m", o.modelId] : []),
        ...(o?.thinking ? ["-c", `model_reasoning_effort="${o.thinking}"`] : []),
      ];
    },
    interruptKeys: ["esc"],
    resumable: true,
    mentionPrefix: "",
  },
  agy: {
    kind: "agy",
    label: "Antigravity",
    command: "agy",
    models: () => [],
    launchArgs(o) {
      return [...(o?.modelId ? ["--model", o.modelId] : []), ...(o?.thinking ? ["--effort", o.thinking] : [])];
    },
    interruptKeys: ["esc"],
    resumable: false,
    mentionPrefix: "@",
  },
  opencode: {
    kind: "opencode",
    label: "OpenCode",
    command: "opencode",
    models: () => [],
    launchArgs: (o) => (o?.resume ? ["--session", o.resume] : []),
    interruptKeys: ["esc"],
    resumable: true,
    mentionPrefix: "@",
  },
  pi: {
    kind: "pi",
    label: "pi",
    command: "pi",
    models: () => [],
    launchArgs(o) {
      return [...(o?.resume ? ["--session", o.resume] : []), ...(o?.modelId ? ["--model", o.modelId] : []), ...(o?.thinking ? ["--thinking", o.thinking] : [])];
    },
    interruptKeys: ["esc"],
    resumable: true,
    mentionPrefix: "@",
  },
  terminal: {
    kind: "terminal",
    label: "Terminal 终端",
    models: () => [],
    launchArgs: () => [],
    interruptKeys: ["ctrl+c"],
    resumable: false,
    mentionPrefix: "",
  },
};

export function getAgentRecipe(kind: string): AgentRecipe | undefined {
  return AGENT_RECIPES[kind.toLowerCase()];
}

export function listAgentRecipes(): AgentRecipe[] {
  return Object.values(AGENT_RECIPES);
}
