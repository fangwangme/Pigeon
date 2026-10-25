# Agent Session Normalization & Structured Rendering Specification

## 1. Overview and Purpose

Pigeon provides a mobile-first mirror client for developers running AI coding agents inside [Herdr](https://herdr.dev). 

While raw VT100 character scraping works for traditional CLI tools, it is fundamentally ill-suited for AI coding agents on mobile screens (360–412px wide):
1. **Semantic Deprivation**: Plain terminal text loses semantic boundaries, making it impossible to distinguish between thought processes, tool parameters, file diffs, and assistant conclusions.
2. **Table Wrapping Catastrophe**: 80-column Markdown tables are forcibly soft-wrapped into 35-column mobile terminal grids, turning structured tables into unreadable vertical garbage.
3. **Screen Real Estate Waste**: Large Chain-of-Thought (CoT) reasoning blocks and verbose tool execution logs flood the mobile viewport, burying the agent's actual responses.

To solve this, Pigeon adopts a **Dual-Track Architecture (双轨制)**:
- **Track 1 (Structured Agent Stream)**: When a Herdr pane runs a supported AI coding agent, Pigeon attaches an `AgentSessionAdapter` directly to the agent's native local storage (SQLite or JSONL) and streams a standardized `NormalizedTurn` event stream to the mobile PWA.
- **Track 2 (PTY Raw Terminal Stream)**: When a pane runs a generic interactive shell (`bash`, `zsh`, `htop`, `vim`, etc.), Pigeon falls back smoothly to its streaming PTY terminal view.

---

## 2. Supported Local Agent Engines & Native Storage Contracts

Herdr's `pane_list` and `snapshot` provide the exact agent identity and session identifier for each pane:
```json
"agent_session": {
  "agent": "opencode" | "agy" | "claude" | "codex" | "pi",
  "kind": "id",
  "value": "<session-id>"
}
```

Pigeon resolves and tails each agent's native session records according to the following contracts:

### 2.1 OpenCode (`opencode`)
* **Storage**: SQLite 3 database at `~/.local/share/opencode/opencode.db`.
* **Session ID**: Matched against `session_v2.id` (e.g. `ses_e9b2e23adffeQnsWp6LzXPX3tA`).
* **Tables Queried**:
  - `session_v2`: Metadata, title, active model, token statistics, and total cost.
  - `session_message`: Message ordering and sequence (`id`, `session_id`, `type`, `seq`, `data`).
  - `part`: Message content components (`text`, `tool_use`, `tool_result`, `reasoning`, `permission`).
* **Concurrency Rules**: The database **MUST** be opened in read-only mode (`Database(path, { readonly: true })`) with WAL mode enabled to prevent database locking against the active OpenCode daemon.

### 2.2 Antigravity CLI (`agy`)
* **Storage**: NDJSON append log at `~/.gemini/antigravity-cli/brain/<session-id>/.system_generated/logs/transcript.jsonl`.
* **Session ID**: Direct 1:1 match with `<session-id>` directory in `brain/`.
* **Record Types**:
  - `USER_INPUT`: Raw user request content (`<USER_REQUEST>...`).
  - `PLANNER_RESPONSE`: Contains raw `thinking` string, `tool_calls` array, and final assistant `content`.
  - `GENERIC`: Tool execution output, command results, and line diffs.
  - Full content lookup: If `truncated_fields` is present on a line, the adapter reads the corresponding line from `transcript_full.jsonl`.

### 2.3 Claude Code (`claude`)
* **Storage**: NDJSON append log at `~/.claude/projects/<slug>/<session-id>.jsonl`.
* **Session ID**: Direct match with the `<session-id>.jsonl` filename.
* **Slug Resolution**: Project directory slug (e.g. `/home/fangwang/Projects/Pigeon` -> `-home-fangwang-Projects-Pigeon`).
* **Record Types**:
  - `user`: User prompt and invocation metadata.
  - `assistant`: Array of content blocks:
    - `{ type: "thinking", thinking: "..." }`
    - `{ type: "text", text: "..." }`
    - `{ type: "tool_use", id: "...", name: "...", input: {...} }`
  - `tool_result`: Output content, exit codes, and diff results.

### 2.4 Codex CLI (`codex`)
* **Storage**: NDJSON log at `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session-id>.jsonl`.
* **Session ID**: Matches the UUID suffix of the rollout filename. Indexed via `~/.codex/session_index.jsonl`.
* **Record Types**: `session_meta`, `turn_start`, `event_msg`, `user_msg`, `agent_msg` (with reasoning payload), and tool blocks.

### 2.5 Pi (`pi`)
* **Storage**: NDJSON log at `~/.pi/agent/sessions/<slug>/<timestamp>_<session-id>.jsonl`.
* **Session ID**: Direct match with the `<session-id>` in the filename.
* **Record Types**: `message` with roles `user` and `assistant`, containing `thinking`, `text`, `tool_call`, and `tool_result`.

---

## 3. Canonical Normalized Data Model

Regardless of the underlying agent engine, the `AgentSessionAdapter` normalizes session records into an unambiguous, strongly typed sequence of `NormalizedTurn` objects:

```typescript
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

export interface FileDiffSummary {
  filePath: string;
  status: "modified" | "created" | "deleted";
  additions: number;
  deletions: number;
  patch?: string; // Unified diff chunk
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
```

---

## 4. Mobile Typesetting and Component Rendering Rules

### 4.1 Table Horizontal Overflow Protection (Table Anti-Wrap)
To completely prevent Markdown tables from breaking and turning into vertical single-character text on 360px mobile screens, the mobile renderer enforces:

```css
.markdown-body table {
  display: block;
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border-collapse: collapse;
  white-space: nowrap; /* Prevents cell text from wrapping; preserves column widths */
  margin: 10px 0;
}

.markdown-body th,
.markdown-body td {
  padding: 6px 10px;
  min-width: 72px;
  border: 1px solid var(--color-border);
  font-size: 13px;
}
```

### 4.2 Thought Chain & Tool Call Folding
* **Reasoning (Thinking)**: Rendered as an accordion. Default state is **collapsed**, displaying an indicator pill: `▸ Thought for 8s (895 tokens)`. Tapping the pill smoothly expands the reasoning text in faint text with a left accent border.
* **Tool Call**: Collapsed by default as a single-line status pill: `✓ $ bun test · exit 0 (42ms)`. Tapping expands the tool invocation arguments and full stdout/stderr output.

### 4.3 Session Diff / Review Drawer
The top app bar includes a session-wide code change summary badge:
- **Badge Format**: `[ 📝 3 files · +42 -18 ]`.
- **Drawer Interaction**: Tapping the badge slides open a dedicated full-screen or half-sheet **Session Diff Drawer**:
  - Displays a clean list of touched files with addition/deletion bars.
  - Tapping a file expands its unified diff with line numbers and green (`+`) / red (`-`) highlighted background lines.

### 4.4 Interactive Question Action Sheet
When `pendingQuestion` is present (or Herdr reports `agent_status === "blocked"` with an interactive prompt):
- Pigeon suppresses inline terminal keyboard menus.
- Renders a native mobile **Action Sheet** anchored at the bottom:
  - Displays the question in bold text.
  - Renders each option as a prominent touch target (height `>= 44px`).
  - Clicking an option dispatches the corresponding key shortcut via Herdr and dismisses the Action Sheet upon verified disappearance (`protocol.md` §4.1). If the prompt is still showing afterwards, the raw terminal sheet opens.
  - A prompt without numbered options shows no option buttons, only a raw key pad built from `fallbackKeys` (`herdr-adapter.md` §8.2).

---

## 5. Streaming Ingestion & Performance Safeguards

1. **Incremental Byte-Offset Tracking**: The JSONL adapter maintains an in-memory map of `fileDescriptor -> lastReadByteOffset`. When filesystem notification fires (`fs.watch` / polling), the adapter reads only the appended bytes, avoiding O(N) re-reads of multi-megabyte transcripts.
2. **Partial-Line EOF Protection**: When reading JSONL streams while an agent is actively writing, the final line may be truncated. The adapter buffers unclosed lines and parses them only once a newline (`\n`) is observed.
3. **SQLite Read-Only Isolation**: OpenCode queries are wrapped with `PRAGMA query_only = ON;` and `PRAGMA busy_timeout = 2000;`.
4. **Debounced UI Updates**: Streaming tokens and tool output chunks are throttled at 60–100ms intervals before pushing to WebSocket clients to preserve mobile 60fps rendering performance.
