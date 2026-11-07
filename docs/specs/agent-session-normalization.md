# Agent Session Normalization Specification

## 1. Purpose

A terminal screen loses what a phone needs: where a tool call starts and ends, what an edit changed, which text is reasoning. Each supported agent writes its own session records to disk. Pigeon reads them, normalizes them into one model (`NormalizedTurn`, §3), and the phone renders that as a conversation (`mobile-ui-and-themes.md` §3).

- **Track 1 (structured)**: a pane bound to a session (§2.0) shows its turns.
- **Track 2 (screen)**: a pane with an agent but no bound session shows the classified screen cards (`herdr-adapter.md` §8). A plain terminal shows the terminal view.

Prompts are always detected on the screen (`herdr-adapter.md` §8.2), because the records do not contain a prompt until it is answered. Pending tool calls in the records only enrich the prompt card (`mobile-ui-and-themes.md` §4).

Session records are files written by other programs: they are a trust boundary. Each record is parsed on its own; a record that is not valid JSON or has an unknown shape is skipped, and its text is never interpreted as markup or commands.

## 2. Sessions

### 2.0 Binding a pane to its session
Herdr Core reports no session id (`herdr-adapter.md` §4). Pigeon binds each agent pane from what the Core does report: the agent kind, the foreground process id (`foreground.pid`), the pane's folder (`foreground.cwd`, else `cwd`) and the terminal's creation time (`created_ms`).

1. **Exact**: the agent process names the session it is writing. claude: `~/.claude/sessions/<pid>.json` names `sessionId` and `cwd`; the session is `~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl`. Every other agent: among the files that the pane's foreground process or any of its descendants holds open (Linux `/proc/<pid>/fd`), the one that is a session file of that agent (§2.1–§2.5 name the file per agent) is its session. The descendants count because an agent's command is often a launcher whose child does the work. A process that has gone or whose open files cannot be read gives no exact signal.
2. **Folder and time (every agent without an exact signal)**: the newest session of that agent whose folder is the pane's folder and that was last written at or after the terminal's creation time. AGY records carry no folder, so for AGY the newest session written since the creation time is used.
3. A session already bound to another pane is skipped by rules 2 and 6, so two panes in the same folder do not show the same conversation.
4. No match leaves the pane unbound (Track 2).
5. A pane started with `resumeSessionId` (`protocol.md` §4.5) is bound to that session unless rule 1 names another one.
6. A pane bound by rule 2 or rule 5 keeps its session while it runs the same agent, until a newer session appears: after every unbound pane has picked by rule 2, a bound pane without an exact signal moves to a session of its agent and folder (any folder for AGY) that is unclaimed and was last written after its current session. That is how `/clear` or `/new` in such a pane is followed (user decision, 2026-11-07). Unbound panes pick first, so a new pane opened in the same folder takes its own new session before an older pane can move to it. The accepted cost: when one pane's folder has two sessions written at the same time by programs outside any pane, the pane can move to the wrong one.
7. A pane whose agent exits (a plain terminal again) is unbound.

Binding is re-evaluated on every snapshot (`herdr-adapter.md` §3.1). When the result changes (rule 1 names a new session after `/clear`, rule 6 moves the pane, the pane's agent restarted, a resume), the pane switches session and its viewers get a fresh `normalized_turns` (`protocol.md` §5.6). A session is read only while its pane is viewed or bound; closing the pane drops it.

`slug(path)` replaces every character outside `[A-Za-z0-9]` with `-` (`/home/u/My.Proj` → `-home-u-My-Proj`).

### 2.1 OpenCode (`opencode`)
- **Storage**: SQLite at `~/.local/share/opencode/opencode.db`, opened read-only with `PRAGMA query_only = ON` and `PRAGMA busy_timeout = 2000`, so the running OpenCode is never locked.
- **Session**: `session_v2` (`id`, `directory`, `title`, `time_updated`, summary columns); messages and parts (`text`, `tool`, `reasoning`, …) in `session_message`.
- **Binding and listing** use `directory` and `time_updated` (milliseconds). All sessions share one database file, so no open file names a session (§2.0 rule 1 does not apply).
- **Model**: the model the session's latest assistant message names (source `log`).

### 2.2 Antigravity (`agy`)
- **Storage**: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` (NDJSON). Title from `~/.gemini/antigravity-cli/annotations/<id>.pbtxt` (`title: "…"`).
- **Records**: `USER_INPUT`, `PLANNER_RESPONSE` (`thinking`, `tool_calls`, `content`), `GENERIC` (tool output). When a line has `truncated_fields`, the full line is read from `transcript_full.jsonl`.
- **Binding**: exact (§2.0 rule 1) when the AGY process holds `~/.gemini/antigravity-cli/presence/<id>.lock` or the session's transcript open; otherwise the transcript's modification time (no folder).
- **Model**: the model the records name, when they name one (source `log`).

### 2.3 Claude Code (`claude`)
- **Storage**: `~/.claude/projects/<slug(cwd)>/<id>.jsonl` (NDJSON); live process map `~/.claude/sessions/<pid>.json`.
- **Records used**:
  - `user` with string `message.content`, or text blocks: a user prompt. Lines with `isMeta: true`, or whose text starts with `<command-`, `<local-command-` or `<system-reminder>`, are not prompts. Image blocks become attachments (`files`).
  - `user` whose content holds `tool_result` blocks: the result of the tool call with that `tool_use_id` (`content` as text; `is_error` marks failure). `toolUseResult.structuredPatch` (when present) gives the edit's hunks.
  - `assistant`: content blocks `thinking` (reasoning text; empty thinking is not shown), `text` (assistant Markdown), `tool_use` (`id`, `name`, `input`). `message.model` is the model in use (source `log`).
  - `custom-title` / `ai-title`: the session title (the latest wins).
  - Every other record type is ignored.
- **Turns**: a turn starts at each user prompt and holds everything up to the next one. `isSidechain: true` records (sub-agents) are not shown.
- **Tool calls**: a `tool_use` without a result yet is `running`; with an `is_error` result `failed`; else `completed`. `Bash` input `description` is the call's description, `command` its command. `Edit`, `MultiEdit`, `Write` and `NotebookEdit` produce a `FileDiffSummary` (§3.1). `TodoWrite` input `todos` (`content`, `status`, `activeForm`) is the todo list (§3.2). A pending `AskUserQuestion` (input `questions`: `question`, `header`, `options` with `label` and `description`, `multiSelect`) is the turn's `pendingQuestion`; a pending `ExitPlanMode` (input `plan`) is the turn's `pendingPlan`.

### 2.4 Codex (`codex`)
- **Storage**: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` (NDJSON). The first record is `session_meta` (`payload.id`, `payload.cwd`).
- **Records used** (`response_item` payloads): `message` with role `user` (`input_text` blocks; text starting with `<environment_context>`, `<user_instructions>` or `<user_action>` is not a prompt) or `assistant` (`output_text` blocks); `reasoning` (`summary[].text`); `function_call` (`name`, `arguments` JSON text, `call_id`) and `function_call_output` (`call_id`, `output`); `custom_tool_call` (`name`, `input`, `call_id`) and `custom_tool_call_output`. `event_msg` with `thread_settings_applied` names the model (`thread_settings.model`, source `log`). Others are ignored.
- **Tools**: `shell` / `exec_command` (`command` as an array or a string, or `cmd`) are commands; `apply_patch` input is a patch whose `*** Update File:`, `*** Add File:` and `*** Delete File:` sections produce one `FileDiffSummary` each; `update_plan` (`plan[]` with `step`, `status`) is the todo list.
- **Listing and binding** read the newest rollouts first and only their first line for the folder. Exact binding (§2.0 rule 1): a rollout file the Codex process holds open.
- **Title**: the first prompt (at most 120 characters).

### 2.5 Pi (`pi`)
- **Storage**: `~/.pi/agent/sessions/--<path>--/<time>_<id>.jsonl`, where `<path>` is the folder without its leading `/` and with `/` replaced by `-`.
- **Records used**: `message` records with `message.role` `user` (text blocks), `assistant` (`text`, `thinking`, `toolCall` blocks with `id`, `name`, `arguments`) and `toolResult` (`toolCallId`, `content` text, `isError`). `bash` tool calls are commands; `edit` (`path`, `oldText`, `newText`) and `write` (`path`, `content`) produce file diffs. Others are ignored.
- **Binding**: exact (§2.0 rule 1) when the pi process holds a session file open; otherwise folder and time.
- **Model**: the model the latest assistant message names (source `log`).
- **Title**: the first prompt (at most 120 characters).

### 2.6 Listing past sessions
`sessions_list` (`protocol.md` §4.10) lists, newest first and at most 50, an agent's sessions whose folder is the workspace's folder or inside it:
- claude: the `.jsonl` files of every `~/.claude/projects/<slug>` directory whose slug starts with `slug(folder)`; folder confirmed from the records' `cwd`. Title: the latest `custom-title`/`ai-title`, else the first prompt. `updatedAt`: file modification time.
- codex: rollouts whose `session_meta.cwd` is the folder or inside it; title from the first prompt. At most 2000 rollouts are inspected.
- opencode: `session_v2` rows by `directory`, not archived.
- pi: files of the folder's session directory; the id is the file name without `.jsonl`.
- agy: not listed (it cannot be resumed, `herdr-adapter.md` §5).

## 3. Normalized model

```typescript
interface NormalizedTurn {
  turnId: string;
  turnNumber: number;
  timestamp: number;
  userPrompt?: { text: string; files?: string[] };
  reasoning?: { text: string; durationMs?: number; isStreaming?: boolean };
  /** Text and tool calls in the order the agent produced them. */
  items?: Array<{ kind: "text"; markdown: string } | { kind: "tool"; call: NormalizedToolCall } | { kind: "todo"; done: number; total: number }>;
  toolCalls?: NormalizedToolCall[];
  assistantResponse?: { markdown: string; isStreaming?: boolean };
  pendingQuestion?: NormalizedQuestion;
  pendingPlan?: { markdown: string };
}

interface NormalizedToolCall {
  id: string;
  name: string;            // the agent's tool name
  verb: "run" | "edit" | "create" | "read" | "search" | "other";
  target?: string;         // file path, pattern or command shown next to the verb
  description?: string;    // the agent's own description (Claude Bash `description`)
  input: Record<string, unknown> | string;
  output?: string;
  exitCode?: number;
  status: "running" | "completed" | "failed";
  durationMs?: number;
  diff?: FileDiffSummary;
}

interface NormalizedQuestion {
  id: string;
  questions: Array<{ question: string; header?: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }>;
}

interface TodoItem { text: string; status: "pending" | "in_progress" | "completed" }
```

- `toolCalls` lists the turn's calls; `items` keeps their order relative to the text, and `assistantResponse` is the turn's last text.
- **Verbs**: run = a shell command; edit = a change to an existing file; create = a new file; read = reading a file; search = grep/glob/web search; other = everything else.
- `exitCode` is set only when the agent recorded it.

### 3.1 File diffs and session changes
`FileDiffSummary { filePath, status: "modified" | "created" | "deleted", additions, deletions, patch? }`. `patch` is a unified diff. For an edit given as old and new text, the diff is computed from the two texts (line based); a write of a new file counts every line as added.
`sessionStats { filesModified, additions, deletions, diffs }` sums the session's completed edits per file, in first-touched order; `diffs` holds one summary per file whose `patch` concatenates that file's patches.

### 3.2 Todos
The session's todo list is the input of its latest todo tool call (Claude `TodoWrite`, Codex `update_plan`), mapped to `TodoItem`. A todo call also appears in the turn's `items` as `{ kind: "todo", done, total }`.

## 4. Reading and streaming

1. **Incremental reads**: JSONL sessions keep a byte offset per file; a change notification reads only the appended bytes. A full read starts from scratch.
2. **Partial lines**: the last line of a file being written may be incomplete; it is kept until its newline arrives.
3. **Change notification**: the session file is watched (`fs.watch`), debounced by 100 ms. OpenCode watches its `-wal` file.
4. **Deltas**: a change emits `turns_delta` (`protocol.md` §5.6) with the changed last turn and any appended turns.
5. A read error other than a missing file is logged with its stack and the pane keeps its last turns.
