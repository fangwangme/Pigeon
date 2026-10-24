export interface FileDiffSummary {
  filePath: string;
  status: "modified" | "created" | "deleted";
  additions: number;
  deletions: number;
  patch?: string; // Unified diff chunk
}

export interface NormalizedToolCall {
  id: string;
  name: string; // e.g. "Bash", "edit_file", "read_file"
  input: Record<string, any> | string;
  output?: string;
  exitCode?: number;
  status: "running" | "completed" | "failed";
  durationMs?: number;
  diff?: FileDiffSummary;
}

export interface NormalizedQuestion {
  id: string;
  question: string;
  options: {
    id: string;
    label: string;
    keyShortcut?: string;
  }[];
  multiSelect?: boolean;
}

export interface NormalizedTurn {
  turnId: string;
  turnNumber: number;
  timestamp: number;
  userPrompt?: {
    text: string;
    files?: string[];
  };
  reasoning?: {
    text: string;
    durationMs?: number;
    tokens?: number;
    isStreaming?: boolean;
  };
  toolCalls?: NormalizedToolCall[];
  assistantResponse?: {
    markdown: string;
    isStreaming?: boolean;
  };
  pendingQuestion?: NormalizedQuestion;
}

export type NormalizedBlockKind =
  | "user_prompt"
  | "reasoning"
  | "tool_call"
  | "assistant_text"
  | "interactive_question"
  | "error";

export interface NormalizedBlock {
  id: string;
  kind: NormalizedBlockKind;
  turnId: string;
  timestamp: number;
  payload: any;
}

export interface SessionStats {
  filesModified: number;
  additions: number;
  deletions: number;
  diffs?: FileDiffSummary[];
}
