import type { ModelOption } from "../types/protocol";

export type { ModelOption };

/** One step of answering a question menu: keys pressed, or text pasted and submitted with Enter. */
export type AnswerStep = { keys: string[] } | { text: string };

/** A question's answer: picked option numbers (1-based) and, when given, the user's own text. */
export interface QuestionAnswer {
  multiSelect: boolean;
  picks: number[];
  other?: string;
}

/** `herdr-adapter.md` §7.2 claude row and §8.2: the steps that answer one Claude question. */
export function claudeQuestionSteps(q: QuestionAnswer): AnswerStep[] {
  const digits = q.picks.map(String);
  if (!q.multiSelect) return q.other !== undefined ? [{ text: q.other }] : [{ keys: digits }];
  if (q.other === undefined) return [{ keys: [...digits, "right"] }];
  return [...(digits.length ? [{ keys: digits }] : []), { text: q.other }, { keys: ["enter", "down", "enter"] }];
}

/**
 * Per-agent launch knowledge. Model lists live in the model catalog (`model-catalog.ts`,
 * `herdr-adapter.md` §7.1). Flags are the ones each CLI's `--help` documents.
 */
export interface AgentRecipe {
  kind: string;
  label: string;
  /** Program started in the new tab (`herdr-adapter.md` §5); none starts the machine's shell. */
  command?: string;
  defaultModel?: string;
  defaultThinking?: string;
  /** `resume` is the value the resume argument takes (`herdr-adapter.md` §5); set only when `resumable`. */
  launchArgs(options?: { modelId?: string; thinking?: string; resume?: string; firstMessage?: string }): string[];
  /** True when the CLI takes the first message via its own flag in `argv` instead of Herdr's positional `task` (`herdr-adapter.md` §5). */
  promptInArgv?: true;
  interruptKeys: string[];
  resumable: boolean;
  /** False when the agent takes no model at launch (`herdr-adapter.md` §5). */
  launchModel?: false;
  /** Prefix for an attachment's path in a prompt (`protocol.md` §4.2). */
  mentionPrefix: string;
  /** Separator between prompt text and attachment paths (defaults to "\n\n"). */
  attachmentSeparator?: string;
  /**
   * `herdr-adapter.md` §7.2: the steps that answer a transcript question, given each question's
   * answer; absent when the keys were never checked.
   */
  questionSteps?: (questions: QuestionAnswer[]) => AnswerStep[];
}

const AGENT_RECIPES: Record<string, AgentRecipe> = {
  claude: {
    kind: "claude",
    label: "Claude Code",
    command: "claude",
    launchArgs(o) {
      return [...(o?.resume ? ["--resume", o.resume] : []), ...(o?.modelId ? ["--model", o.modelId] : []), ...(o?.thinking ? ["--effort", o.thinking] : [])];
    },
    interruptKeys: ["esc"],
    resumable: true,
    mentionPrefix: "@",
    questionSteps(questions) {
      const steps = questions.flatMap(claudeQuestionSteps);
      return questions.length === 1 && !questions[0].multiSelect ? steps : [...steps, { keys: ["1"] }];
    },
  },
  codex: {
    kind: "codex",
    label: "Codex",
    command: "codex",
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
    // herdr-adapter.md §7, checked against Codex 0.167: both apply to this session only.
  },
  agy: {
    kind: "agy",
    label: "Antigravity",
    command: "agy",
    launchArgs(o) {
      return [
        ...(o?.resume ? ["--conversation", o.resume] : []),
        ...(o?.modelId ? ["--model", o.modelId] : []),
        ...(o?.thinking ? ["--effort", o.thinking] : []),
        ...(o?.firstMessage ? ["-i", o.firstMessage] : []),
      ];
    },
    promptInArgv: true,
    interruptKeys: ["esc"],
    resumable: true,
    mentionPrefix: "",
    attachmentSeparator: " ",
  },
  opencode: {
    kind: "opencode",
    label: "OpenCode",
    command: "opencode",
    launchArgs(o) {
      return [...(o?.resume ? ["--session", o.resume] : []), ...(o?.firstMessage ? ["--prompt", o.firstMessage] : [])];
    },
    promptInArgv: true,
    launchModel: false,
    interruptKeys: ["esc"],
    resumable: true,
    mentionPrefix: "@",
  },
  pi: {
    kind: "pi",
    label: "pi",
    command: "pi",
    launchArgs(o) {
      return [...(o?.resume ? ["--session", o.resume] : []), ...(o?.modelId ? ["--model", o.modelId] : []), ...(o?.thinking ? ["--thinking", o.thinking] : [])];
    },
    interruptKeys: ["esc"],
    resumable: true,
    mentionPrefix: "@",
    // herdr-adapter.md §7, checked against pi 1.5: `/thinking <level>` changes this session only. Its
    // `/model <text>` opens a fuzzy picker that can pick another model, so pi has no model switch.
  },
  terminal: {
    kind: "terminal",
    label: "Terminal",
    launchArgs: () => [],
    interruptKeys: ["ctrl+c"],
    resumable: false,
    mentionPrefix: "",
  },
};

export function getAgentRecipe(kind: string): AgentRecipe | undefined {
  const k = kind.toLowerCase();
  return Object.hasOwn(AGENT_RECIPES, k) ? AGENT_RECIPES[k] : undefined;
}

export function listAgentRecipes(): AgentRecipe[] {
  return Object.values(AGENT_RECIPES);
}
