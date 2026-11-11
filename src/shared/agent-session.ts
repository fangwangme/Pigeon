// The normalized session model (`agent-session-normalization.md` §3), shared by the daemon and the PWA.

export interface FileDiffSummary {
  filePath: string;
  status: "modified" | "created" | "deleted";
  additions: number;
  deletions: number;
  /** Unified diff. */
  patch?: string;
}

export type ToolVerb = "run" | "edit" | "create" | "read" | "search" | "other";

export interface NormalizedToolCall {
  id: string;
  /** The agent's own tool name. */
  name: string;
  verb: ToolVerb;
  /** File path, pattern or command shown next to the verb. */
  target?: string;
  /** The agent's own description of the call (Claude Bash `description`). */
  description?: string;
  input: Record<string, unknown> | string;
  output?: string;
  exitCode?: number;
  status: "running" | "completed" | "failed";
  durationMs?: number;
  diff?: FileDiffSummary;
}

export interface NormalizedQuestion {
  id: string;
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
}

export type TurnItem =
  | { kind: "text"; markdown: string }
  | { kind: "tool"; call: NormalizedToolCall }
  | { kind: "todo"; done: number; total: number }
  | { kind: "reasoning"; text?: string; hasText?: boolean; durationMs?: number; isStreaming?: boolean }
  | { kind: "error"; errorKind: string; text: string };

export interface NormalizedTurn {
  turnId: string;
  turnNumber: number;
  timestamp: number;
  /** Time of the turn's latest record. */
  updatedAt?: number;
  userPrompt?: { text: string; files?: string[] };
  reasoning?: { text: string; durationMs?: number; isStreaming?: boolean };
  /** Text and tool calls in the order the agent produced them. */
  items?: TurnItem[];
  toolCalls?: NormalizedToolCall[];
  assistantResponse?: { markdown: string; isStreaming?: boolean };
  pendingQuestion?: NormalizedQuestion;
  pendingPlan?: { markdown: string };
}

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface SessionStats {
  filesModified: number;
  additions: number;
  deletions: number;
  diffs?: FileDiffSummary[];
  files?: Array<{ filePath: string; status?: string; additions?: number; deletions?: number }>;
}
