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

1. **Exact**: the agent process names the session it is writing. claude: `~/.claude/sessions/<pid>.json` names `sessionId` and `cwd`; the session is `~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl`. Every other agent: among the files that the pane's foreground process or any of its descendants holds open (Linux: `/proc/<pid>/fd`, descendants from `/proc`; macOS: `lsof`, descendants from `ps`), the one that is a session file of that agent (§2.1–§2.5 name the file per agent) is its session. The descendants count because an agent's command is often a launcher whose child does the work. A process that has gone or whose open files cannot be read gives no exact signal.
2. **Folder and time (every agent without an exact signal)**: the newest session of that agent whose folder is the pane's folder and that was last written at or after the terminal's creation time. AGY records carry no folder, so for AGY the newest session written since the creation time is used.
3. A session already bound to another pane is skipped by rules 2 and 6, so two panes in the same folder do not show the same conversation.
4. No match leaves the pane unbound (Track 2).
5. A pane started with `resumeSessionId` (`protocol.md` §4.5) is bound to that session unless rule 1 names another one.
6. A pane bound by rule 2 or rule 5 keeps its session while it runs the same agent, until a newer session appears: after every unbound pane has picked by rule 2, a bound pane without an exact signal moves to a session of its agent and folder (any folder for AGY) that is unclaimed and was last written after its current session. That is how `/clear` or `/new` in such a pane is followed (user decision, 2026-11-07). Unbound panes pick first, so a new pane opened in the same folder takes its own new session before an older pane can move to it. The accepted cost: when one pane's folder has two sessions written at the same time by programs outside any pane, the pane can move to the wrong one.
7. A pane whose agent exits (a plain terminal again) is unbound.

Binding is re-evaluated for every pane on every snapshot (`herdr-adapter.md` §3.1), and for one pane on that pane's status event (`herdr-adapter.md` §3.2). When the result changes (rule 1 names a new session after `/clear`, rule 6 moves the pane, the pane's agent restarted, a resume), the pane switches session and its viewers get a fresh `normalized_turns` (`protocol.md` §5.6). A session is read only while its pane is viewed or bound; closing the pane drops it.

`slug(path)` replaces every character outside `[A-Za-z0-9]` with `-` (`/home/u/My.Proj` → `-home-u-My-Proj`).

### 2.1 OpenCode (`opencode`)
- **Storage**: SQLite at `$XDG_DATA_HOME/opencode/opencode.db` (defaulting to `~/.local/share/opencode/opencode.db`), opened read-only with `PRAGMA query_only = ON` and `PRAGMA busy_timeout = 2000`, so the running OpenCode is never locked.
- **Session**: `session_v2` (`id`, `directory`, `title`, `time_updated`, summary columns), or `session` in older databases; binding and reads probe the available table the same way the usage scanner does (`quota-and-usage.md` §3.1). Messages and parts (`text`, `tool`, `reasoning`, …) in `session_message` are read per session in a single database open. An incremental read reuses the previous result only while the session's `time_updated`, its message count and its messages' latest `time_updated` are all unchanged: OpenCode rewrites message rows while it streams without touching the session row.
- **Binding and listing** use `directory` and `time_updated` (milliseconds). All sessions share one database file, so no open file names a session (§2.0 rule 1 does not apply).
- **Model**: the latest assistant message's `model` (`{ providerID, id }`), as `<providerID>/<id>` like `opencode models` (source `log`).
- **Title**: `session_v2.title` unless it is OpenCode's default placeholder (`New session - <ISO time>`, matching `/^New session - \d{4}-\d{2}-\d{2}T/`). An absent or placeholder title leaves the session untitled (no first-prompt fallback); listing still falls back to the first prompt (§2.6).
- **Errors** (issue #25): an assistant message whose data holds `error` (`{ type, message }`) adds an `error` item (§3) with `errorKind` its `type` and its `message` as the text (seen: `provider.quota`, `provider.rate-limit`, `provider.free-limit`, `provider.auth`, `provider.transport`, `provider.internal`, `provider.invalid-output`, `provider.invalid-request`). `type: "aborted"` is the user interrupting the step and adds nothing.
- **Sub-agents** (§3.4): the `session_v2` rows whose `parent_id` is this session, by `time_created`. Id `id`; title `title`; type `agent`. Status: `time_idle` absent is `running`; `idle_outcome` `succeeded` is `completed`; any other outcome is `failed`. Its conversation is that session, read by this reader. A session with a `parent_id` is never bound to a pane (§2.0) and never listed (§2.6): it shares its parent's folder and is written later, so it would otherwise take the parent's pane.

### 2.2 Antigravity (`agy`)
- **Storage**: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` (NDJSON). Title from `~/.gemini/antigravity-cli/annotations/<id>.pbtxt` (`title: "…"`).
- **Records**: `USER_INPUT`, `PLANNER_RESPONSE` (`thinking`, `tool_calls`, `content`), `GENERIC` (tool output), `ERROR_MESSAGE`, `CHECKPOINT`, `SYSTEM_MESSAGE`. When a line has `truncated_fields`, the full line is read from `transcript_full.jsonl`. Other record types are ignored (issue #25: the typed results such as `RUN_COMMAND` and `VIEW_FILE` were last written by AGY versions before 2026-10-03 and are not read).
  - `USER_INPUT.media` (`[{ mime_type, uri }]`, images pasted in AGY itself) adds each `uri` to the prompt's `files`; the phone loads them through `protocol.md` §7.1.
  - `GENERIC` is the output of the turn's first tool call without output. `status: "ERROR"` (or a non-zero `Command exited with code N`) is `failed`. `status: "RUNNING"` is a command AGY moved to the background (`Tool is running as a background task with task id: <task>`): the call keeps that output and stays `running` until a later `SYSTEM_MESSAGE` from `sender=<task>` says `Task id "<task>" finished with result:` (`completed`) or `was canceled with result:` (`failed`). Any other status is `completed`.
  - `ERROR_MESSAGE`: an agent error (issue #25). Its `error` text, else its `content`, becomes an `error` item (§3) with `errorKind` its `error_code`, else `unknown`. AGY retries on its own and records each attempt; consecutive ones fold (§3).
  - `CHECKPOINT`: a compaction; its `content` becomes a `compact` item (§3) in the current turn.
  - A pending `ask_question` call (no output yet) is the turn's `pendingQuestion`: `args.questions` is a JSON text of `[{ question, is_multi_select, options }]` whose `options` are plain strings; each string is an option's `label`, `is_multi_select` is `multiSelect`, and there is no `header`. A pending `exit_plan_mode` call (`args.plan`) is the turn's `pendingPlan`. When the session's latest turn has no pending `exit_plan_mode`, the last completed `write_file` or `edit_file` call in that turn whose `ArtifactMetadata` (object or JSON string) has `RequestFeedback: true` sets `pendingPlan` (`{ markdown, title, artifact: true }`, issue #35): `markdown` is read as UTF-8 from the call's `Path` only after `realpath` confirms the file sits inside `~/.gemini/antigravity-cli/brain/<id>/` (falling back to the call's `Content` when the file is absent), and `title` is the file's basename. Paths outside that session's brain directory are never read. A later user turn clears it.
- **Sub-agents** (§3.4): the rows of `conversation_summaries` (§2.6, opened the same way) whose `parent_conversation_id` is this session, by `last_user_input_time` (the task it was given; the table's row order is not chronological). Id `conversation_id`; title `title`, else `agent_name`; type `agent_name`. Status: `killed` 1 is `failed`; `status` `CASCADE_RUN_STATUS_IDLE` or empty is `completed`; any other `status` is `running`. Its conversation is that id's transcript, read by this reader. A locked or changed database leaves the list empty (`architecture.md` §5). A conversation that `conversation_summaries` lists with a `parent_conversation_id` is never bound to a pane by §2.0 rules 2 and 6: its transcript is newer than its parent's and would otherwise move the parent's pane to it.
- **Binding**: exact (§2.0 rule 1) when the AGY process holds `~/.gemini/antigravity-cli/presence/<id>.lock` or the session's transcript open; otherwise the transcript's modification time (no folder).
- **Model**: the latest of a `USER_INPUT` record whose content reports that the user changed the `Model Selection` setting (a model label resolved through the model catalog, `herdr-adapter.md` §7.1) or a `PLANNER_RESPONSE` record's `model` field (a model id), in record order; source `log` (issue #25, user decision 2026-11-15). Tool outputs and other record types never count. Without either, the launch value, else unknown (`protocol.md` §5.6). The global `settings.json` is not read.

### 2.3 Claude Code (`claude`)
- **Storage**: `~/.claude/projects/<slug(cwd)>/<id>.jsonl` (NDJSON); live process map `~/.claude/sessions/<pid>.json`.
- **Records used**:
  - `user` with string `message.content`, or text blocks: a user prompt. Lines with `isMeta: true`, with `origin.kind` `task-notification` (Claude Code telling itself a background task ended; issue #25), or whose text starts with `<command-`, `<local-command-` or `<system-reminder>`, are not prompts.
  - `user` with `isCompactSummary: true`: the summary Claude Code wrote when it compacted the conversation. It is not a prompt and starts no turn; its text becomes a `compact` item (§3) in the current turn (user decision, 2026-11-13). Image blocks become attachments (`files`).
  - `user` whose content holds `tool_result` blocks: the result of the tool call with that `tool_use_id` (`content` as text; `is_error` marks failure). `toolUseResult.structuredPatch` (when present) gives the edit's hunks.
  - `assistant`: content blocks `thinking` (reasoning text; empty thinking is not shown), `text` (assistant Markdown), `tool_use` (`id`, `name`, `input`). `message.model` is the model in use (source `log`).
  - `assistant` with `isApiErrorMessage: true`: an agent error. Its text becomes an `error` item (§3) whose `errorKind` is the record's `error` (seen: `rate_limit`, `authentication_failed`, `server_error`, `model_not_found`; `unknown` when absent). Its `message.model` (`<synthetic>`) is not a model value, so the session model stays the last real one.
  - `custom-title` / `ai-title`: the session title (the latest wins).
  - Every other record type is ignored.
- **Turns**: a turn starts at each user prompt and holds everything up to the next one. `isSidechain: true` records (sub-agents) are not shown in the session itself.
- **Sub-agents** (§3.4): each `Agent` or `Task` tool call, in record order. Id: the `agentId` of its result's `toolUseResult`, else the call's id until a result names one; title `input.description`; type `input.subagent_type`; model `toolUseResult.resolvedModel`, else `input.model`. Status: without a result `running`; a result with `toolUseResult.status` `async_launched` (a background agent) stays `running` until a `task-notification` record whose text holds `<task-id>` equal to the id: `<status>completed</status>` is `completed`, any other status `failed`; any other result is `failed` when `is_error`, else `completed`. Its conversation is `~/.claude/projects/<slug(cwd)>/<sessionId>/subagents/agent-<id>.jsonl`, read by this reader with its `isSidechain` records shown; a sub-agent without that file has no conversation.
- **Tool calls**: a `tool_use` without a result yet is `running`; with an `is_error` result `failed`; else `completed`. `Bash` input `description` is the call's description, `command` its command. `Edit`, `MultiEdit`, `Write` and `NotebookEdit` produce a `FileDiffSummary` (§3.1). `TodoWrite` input `todos` (`content`, `status`, `activeForm`) is the todo list (§3.2). A pending `AskUserQuestion` (input `questions`: `question`, `header`, `options` with `label` and `description`, `multiSelect`) is the turn's `pendingQuestion`; a pending `ExitPlanMode` (input `plan`) is the turn's `pendingPlan`.

### 2.4 Codex (`codex`)
- **Storage**: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` (NDJSON). The first record is `session_meta` (`payload.id`, `payload.cwd`, `payload.source`). Subagent rollouts (`isObj(payload.source) && "subagent" in payload.source`, or `typeof payload.thread_source === "string" && payload.thread_source !== "user"`) are excluded from session binding and session listing (`B18`).
- **Records used**:
  - `response_item` payloads: `message` with role `user` (`input_text` blocks; text starting with `<environment_context>`, `<user_instructions>` or `<user_action>` is not a prompt) or `assistant` (`output_text` blocks); `reasoning` (`summary[].text`); `function_call` (`name`, `arguments` JSON text, `call_id`) and `function_call_output` (`call_id`, `output`); `custom_tool_call` (`name`, `input` JSON or raw string, `call_id`) and `custom_tool_call_output` (`output` string, object, or array of `input_text` blocks).
  - `event_msg` payloads: `thread_settings_applied` (`thread_settings.model`, source `log`); `item_completed` (`item.type` `CommandExecution`, `FileChange`, `McpToolCall`, `ContextCompaction`). `item_completed` `AgentMessage` is read as assistant text, because some (a question put to the user) have no `response_item`; an assistant `response_item` message with the id of a message already read is that message again and is skipped, while equal text under another id is a new message. `item_completed` `UserMessage`/`Reasoning` are ignored to avoid duplicating `response_item` records.
  - `turn_context`: `payload.model` overrides the turn's active model (`B9`).
  - A `custom_tool_call` named `exec` is shown as a `running` command as soon as it is recorded. When its first `item_completed:CommandExecution` arrives, the commands replace the wrapper (it leaves the turn) and its later `custom_tool_call_output` is ignored; when no `CommandExecution` arrives, the output completes the wrapper itself. Other records are ignored.
- **Tools**: `shell` / `exec_command` / `local_shell` (`command` as an array or a string, or `cmd`) and `item_completed:CommandExecution` (`command`, `aggregated_output`, `exit_code`, `duration_ms`, `status`) are commands; `apply_patch` (`*** Update File:`, `*** Add File:`, `*** Delete File:`) and `item_completed:FileChange` (`changes` object map keyed by file path) produce `FileDiffSummary[]`; `item_completed:McpToolCall` maps tool/args/result/status; `item_completed:ContextCompaction` produces a `compact` item; `update_plan` (`plan[]` with `step`, `status`) is the todo list.
- **Listing and binding** read the newest non-subagent rollouts first and only their first line for the folder. Exact binding (§2.0 rule 1): a rollout file the Codex process holds open.
- **Title**: none (Codex assigns no title); listings still show the first prompt (§2.6).

### 2.5 Pi (`pi`)
- **Storage**: `~/.pi/agent/sessions/--<path>--/<time>_<id>.jsonl`, where `<path>` is the folder without its leading `/` and with `/` replaced by `-`.
- **Records used**: `message` records with `message.role` `user` (text blocks), `assistant` (`text`, `thinking`, `toolCall` blocks with `id`, `name`, `arguments`) and `toolResult` (`toolCallId`, `content` text, `isError`). `bash` tool calls are commands; `edit` (`path`, `oldText`, `newText`) and `write` (`path`, `content`) produce file diffs. Others are ignored.
- **Errors** (issue #25): an `assistant` message with `stopReason: "error"` adds an `error` item (§3) with `errorKind` `unknown` and its `errorMessage` as the text.
- **Binding**: exact (§2.0 rule 1) when the pi process holds a session file open; otherwise folder and time.
- **Model**: the latest `model_change` record (`provider`, `modelId`) or assistant message (`provider`, `model`), as `<provider>/<id>` like the model catalog (`herdr-adapter.md` §7.1, source `log`).
- **Title**: none (Pi assigns no title); listings still show the first prompt (§2.6).

### 2.6 Listing past sessions
`sessions_list` (`protocol.md` §4.10) lists, newest first and at most 50, an agent's sessions whose folder is the workspace's folder or inside it:
- claude: the `.jsonl` files of every `~/.claude/projects/<slug>` directory whose slug starts with `slug(folder)`; folder confirmed from the records' `cwd`. Title: the latest `custom-title`/`ai-title`, else the first prompt. `updatedAt`: file modification time.
- codex: rollouts whose `session_meta.cwd` is the folder or inside it; title from the first prompt. At most 2000 rollouts are inspected.
- opencode: `session_v2` rows by `directory`, not archived.
- pi: files of the folder's session directory; the id is the file name without `.jsonl`.
- **Model** (issue #21): each listed session carries the model its records name, by its agent's **Model** rule above (the value with source `log`; a session that names none has no model), resolved through the model catalog (`herdr-adapter.md` §7.1). Only the listed sessions are read for it, and of a file larger than 512 KB only its first and last 256 KB, so the list stays fast (user decision, 2026-11-13); the latest record in what was read wins, and a model changed only in the unread middle of a very long session is not seen.
- agy (issue #21): rows of the table `conversation_summaries` in `~/.gemini/antigravity-cli/conversation_summaries.db` whose `workspace_uris` (a JSON list of `file://` URIs) names the folder or a folder inside it, with `nesting_depth` 0 (a sub-agent's conversation is not listed). Id `conversation_id`; title `title`, else `preview`; `updatedAt` `last_modified_time`; `model` follows the §2.2 **Model** rule across the read slices. The database is AGY's own: it is opened read-only, and a locked or changed database degrades only this list (`architecture.md` §5).

## 3. Normalized model

```typescript
interface NormalizedTurn {
  turnId: string;
  turnNumber: number;
  timestamp: number;
  /** Time of the turn's latest record. */
  updatedAt: number;
  userPrompt?: { text: string; files?: string[] };
  reasoning?: { text: string; durationMs?: number; isStreaming?: boolean };
  /** Text and tool calls in the order the agent produced them. */
  items?: Array<
    | { kind: "text"; markdown: string }
    | { kind: "tool"; call: NormalizedToolCall }
    | { kind: "todo"; done: number; total: number }
    | { kind: "error"; errorKind: string; text: string; count?: number }
    | { kind: "compact"; summary: string }
  >;
  toolCalls?: NormalizedToolCall[];
  assistantResponse?: { markdown: string; isStreaming?: boolean };
  pendingQuestion?: NormalizedQuestion;
  pendingPlan?: { markdown: string; title?: string; artifact?: boolean };
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
- `updatedAt` is the timestamp of the turn's latest record that has one, else the turn's `timestamp`.
- A `compact` item marks where the agent compacted its context, with the summary it carried over; it belongs to the agent's side of the turn. Each agent's reader names the records that are compactions: Claude (§2.3), Codex (§2.4) and AGY (§2.2).
- An `error` item is an error the agent itself reported (for example a rate limit), with the agent's own text. Each agent's reader names the records that are errors: Claude (§2.3), OpenCode (§2.1), AGY (§2.2) and Pi (§2.5); other agents are added as real samples are seen (user decision, 2026-11-12; Codex has none on record).
- **Folding** (issue #25): an error recorded while the turn's last item is already an error does not add an item. That item takes the new `errorKind` and text, and `count` becomes the number of errors folded into it (absent while it is 1). An agent retrying a failed request therefore shows one line that updates, not one line per attempt.

### 3.1 File diffs and session changes
`FileDiffSummary { filePath, status: "modified" | "created" | "deleted", additions, deletions, patch? }`. `patch` is a unified diff. For an edit given as old and new text, the diff is computed from the two texts (line based); a write of a new file counts every line as added.
`sessionStats { filesModified, additions, deletions, diffs }` sums the session's completed edits per file, in first-touched order; `diffs` holds one summary per file whose `patch` concatenates that file's patches.

### 3.2 Todos
The session's todo list is the input of its latest todo tool call (Claude `TodoWrite`, Codex `update_plan`), mapped to `TodoItem`. A todo call also appears in the turn's `items` as `{ kind: "todo", done, total }`.

### 3.3 Light list form
The daemon sends turns to the phone in a light form (user decision, 2026-11-10: the list needs about 5% of the full records); the full records stay in the daemon and are fetched with `detail_get` (`protocol.md` §4.20).
- `userPrompt`, text items, error items, compact items, `assistantResponse`, `pendingQuestion`, `pendingPlan`, `updatedAt` and todo items are sent in full.
- A tool item's `call` keeps `id`, `name`, `verb`, `target` (at most 200 characters), `description`, `status`, `exitCode`, `durationMs`, and for an edit `diff` without `patch`. `input` and `output` are left out.
- `reasoning` keeps `text`, `durationMs` and `isStreaming` (the client renders it collapsed by default, `mobile-ui-and-themes.md` §3.2).
- `toolCalls` is not sent; `items` holds the calls in order.
- `sessionStats` is sent as `{ filesModified, additions, deletions, files }`, where `files` lists each file's `filePath`, `status`, `additions` and `deletions`; a file's accumulated patch comes from `detail_get`.
- The resume anchor hash (`protocol.md` §3.1) is computed over this form.

### 3.4 Sub-agents
A session's sub-agents are the agents its own agent started (issue #25: display only, user decision 2026-11-15). Each agent's reader names where they come from: Claude (§2.3), OpenCode (§2.1), AGY (§2.2). Codex and Pi list none.

```typescript
interface SubagentInfo {
  id: string;
  title: string;          // the task the parent gave it, else its agent name
  type?: string;          // the sub-agent's kind (Claude `subagent_type`, AGY `agent_name`, OpenCode `agent`)
  model?: string;
  status: "running" | "completed" | "failed";
}
```

- The session's `subagents` lists them in the order they were started, as each reader orders them; a session without any has none.
- A sub-agent's conversation is its own session read by its agent's reader, as `NormalizedTurn[]` in the light form (§3.3). Pigeon does not merge it into the parent's turns, does not follow its own sub-agents, and offers no way to stop it.
- The list is computed on every read of the parent session; a conversation is read when the phone asks for it (`protocol.md` §4.20) and not followed afterwards.

## 4. Reading and streaming

1. **Incremental reads**: JSONL sessions keep a byte offset per file; a change notification reads only the appended bytes. A full read starts from scratch.
2. **Partial lines**: the last line of a file being written may be incomplete; it is kept as bytes until its newline arrives. Only complete lines are decoded as UTF-8, so a multi-byte character split between two reads is never broken.
3. **Change notification**: the session file is watched (`fs.watch`), debounced by 100 ms. OpenCode watches its `-wal` file; when that file is deleted (a checkpoint), the watcher is dropped and set up again at the pane's next binding evaluation.
4. **Deltas**: a change emits `turns_delta` (`protocol.md` §5.6) with the changed last turn and any appended turns.
5. A read error other than a missing file goes to the source's error boundary (`architecture.md` §5): it is logged with its stack, at a limited rate, and the pane keeps its last turns.
