# Herdr Adapter Specification

## 1. Scope and Isolation Contract

`src/server/herdr-client.ts` (`HerdrClient`) is the only Pigeon component that talks to Herdr. The rest of the daemon (WebSocket server, pane store, UI) consumes its domain objects (`SnapshotPayload`, `PaneStatePayload`) and its events. It never sees Herdr's wire format.

Herdr is two programs, and Pigeon needs both:
- **Herdr App** (`herdr-app`), the desktop window. It owns spaces and tabs: their names, which terminals sit in which tab, focus, and creating and closing tabs.
- **Herdr Core** (`hc`, `herdr-core`), the daemon that runs the terminals and keeps them alive when the window closes. It owns each terminal's program, folder, status, screen and input.

Herdr is the source of truth for topology, agent identity and agent status. Pigeon adds two things on top: it classifies the screen text of the panes a phone is looking at into cards and prompts (§8), and it binds agent panes to the agents' own session records (`agent-session-normalization.md` §2.0) using the process facts the Core reports.

The older terminal multiplexer `herdr` (TUI, 0.9.x, `~/.config/herdr/herdr.sock`) is not supported.

## 2. Channels and Herdr Compatibility

- **No version pinning**: Pigeon does not assert a Herdr version. It relies on the App's socket commands (`herdr-app commands`) and the Core's OpenRPC API (`hc schema`), and was developed against Herdr App 0.1.13 and Herdr Core 0.1.18 (protocol generation 1). Unknown fields are ignored.
- **App channel**: the Unix socket `herdr-app.sock` in `$HERDR_APP_HOME`, or in `~/.config/herdr-app` by default. It exists only while the window runs. One JSON object per line: `{"ls":{}}`, `{"status":{}}` or `{"do":"<command>","args":{…}}`. The reply is the result object, or `{"error":"<text>"}`.
- **Core channel**: the Unix socket `$HC_TERMINAL_SOCKET`, or `$XDG_RUNTIME_DIR/herdr-core/default.sock` by default, carrying newline-delimited JSON-RPC 2.0. An error carries its stable kind in `error.data.kind`.
- Both paths are resolved from the environment at every start (or from `--herdr-app-sock` / `--herdr-core-sock`) and never written to `config.json`. When the Core path cannot be resolved (no flag, `HC_TERMINAL_SOCKET` or `XDG_RUNTIME_DIR`), the daemon refuses to start.
- **One request per connection**: Every request opens a fresh connection, sends one request, reads one response and closes. The Core event subscription has its own long-lived connection, which carries nothing but the subscription.
- **Errors**: A Core error becomes a `HerdrError(<kind>)`. An App `{"error":…}` reply becomes a `HerdrError("app_error")` carrying the App's text. The socket failures `ECONNREFUSED`, `ENOENT`, `ECONNRESET` and `EPIPE` mean "not reachable". They change connection state (§3.4) and are not logged as bugs. Every other failure is logged with its stack trace.

## 3. Topology, Events and Screen Reads

### 3.1 Snapshot
A snapshot joins three answers: App `ls` (spaces, their tabs, and each tab's terminals), App `status` (the focused pane) and Core `terminal.list` (every live terminal's facts). They are joined by the terminal address.

| Herdr | Pigeon |
| :--- | :--- |
| space `id`, `name` (or the last segment of the workspace folder when unnamed), `active` | workspace `id`, `label`, `isFocused` |
| tab `id`, `name`, `active` | tab `id`, `label`, the workspace's `activeTabId` |
| tab terminal `terminal` (an address such as `t7`) | pane `id` |
| Core terminal `foreground.cwd` (else `cwd`), `status`, `title` | pane folder, agent kind and status (§4), summary |
| Core terminal `foreground.name`, `foreground.pid`, `created_ms` | pane `program`; the process id and start time used for session binding |

- **Workspace folder**: the folder of the first pane of the space's first tab (Core `foreground.cwd`, else `cwd`). Herdr starts a new space in the folder of the space focused before it, and the App's space `folder` and a terminal's `cwd` keep that start folder after the user moves into the project, so neither names the project. The App's `folder` is used only for a space with no live terminal.
- A tab named only by its number is labelled after its first pane's agent recipe, else `Tab <n>`.
- Each snapshot rebuilds the pane facts. State for panes missing from the snapshot is dropped, so a reused address never shows old data.
- A terminal the App shows but the Core does not list (it finished, or its machine is not connected) is a pane without an agent and with status `unknown`.
- **Branch**: a workspace's `branch` is read from its folder, a tab's from its first pane's folder: walk up to the nearest `.git` (a directory, or a worktree's `.git` file naming its `gitdir`), read its `HEAD`, and take the name after `ref: refs/heads/`. A detached HEAD or no repository gives no branch. Read failures other than a missing file fail loudly.
- A snapshot is taken at startup, shortly after every topology event (debounced), every time the subscription (re)connects, and every 30 seconds as reconciliation. The reconciliation also picks up renames in the App, which no Core event reports.

### 3.2 Subscription
Core `events.subscribe {}` covers every terminal. Its notifications are `{"method":"event","params":{"type","terminal","data"}}`:
- `status`: `data.status` is the terminal's new root status record. It updates that pane's status at once, notifies the push logic (`push.md` §4), schedules a screen read when the pane is blocked or already being watched, and schedules a snapshot.
- `created`, `removed`, `finished`, `lost`, `restarted` and `labels` schedule a snapshot. The App places a terminal in a tab through its `herdr.space` / `herdr.tab` labels.
- A `missed` notification (the subscriber fell behind) schedules a snapshot.
- Every other notification, including the 15-second `heartbeat`, is ignored.

Status events for terminals the window does not show (hidden workers) change nothing.

### 3.3 Screen Reads
Herdr has no "output changed" event. The panes that connected clients are viewing (the union over all connections) are therefore read once per second with Core `terminal.read { terminal, lines: 200 }`.
- **Full-screen programs**: Reading history of a full-screen program scrolls it on the desktop and back. Once a read answers `how: "stitched"`, Pigeon reads that terminal with `lines: 0` (the visible screen only) for as long as it exists.
- A pane is not polled while a read of it is still in flight.
- A read is dropped before classification when both the screen hash and the pane's Herdr status are unchanged. A status change alone is therefore classified again and reaches viewers (§3.2), even when the screen did not change.
- A changed screen produces a new `PaneStatePayload` with the next `revision`.
- Reads after sending keys always read fresh and never reuse a read already in flight.

### 3.4 Connection State
Herdr is connected while both the App and the Core answer. Losing either one is an expected state:
- it is reported through `upstream_status` (`herdrConnected: false`), so a closed Herdr window shows as Herdr offline even though the Core keeps the terminals running;
- the subscription reconnects every 3 seconds, and the 30-second snapshot retries the App;
- startup does not fail when Herdr is not running.

`disconnect()` stops every timer and socket. Before `connect()`, the client opens no sockets and starts no timers.

## 4. Agent Identity and States

A terminal is an agent while its program reports a status to the Core (OSC 7501). Its agent kind comes from the status record's `app`: `claude-code` is `claude`, `antigravity` is `agy`, and other words (`codex`, `opencode`, `pi`) are used as they are. A terminal without a status is a plain terminal.

| Core `status.state` | Pigeon status |
| :--- | :--- |
| `idle`, `working`, `blocked`, `done` | the same |
| `error` | `blocked`: a person has to look |
| no status | `unknown` |

A pane's effective status is that status, with one override: a prompt recognized on screen (§8.2) makes it `blocked`. When the status is `blocked` but no prompt is recognized, the pane still gets a pending interaction. That interaction has no options, so the phone shows the raw key pad instead of hiding the fact that the agent is waiting.

**Seen** (user decision, 2026-11-07): Herdr turns `done` into `idle` once the pane is looked at on the desktop, and the phone cannot tell Herdr it looked. The daemon therefore keeps its own seen mark per pane, shared by every phone. A pane is seen when a connected phone reports it is visible and viewing that pane (`presence_update`, `protocol.md` §2.1) while the pane is `done`, or when the pane turns `done` while such a phone is viewing it. A seen pane is reported as `idle` everywhere the phone gets a status (`snapshot_update`, `pane_state`, push triggers). The mark is cleared by the pane's next Core status change, so its next `done` is reported as `done` again. The mark changes only what is reported: the prompt queue (`protocol.md` §4.2) still follows the Core status. The desktop Herdr is not touched.

Prompts are not refused while an agent is `working`: the agents queue typed input. A prompt sent while `blocked` is refused by the Core (`blocked`).

The Core reports no agent session id. Pigeon binds a pane to its session from the pane's agent kind, foreground process id, folder and creation time (`agent-session-normalization.md` §2.0).

## 5. Tab Creation and Closing

1. **Create**: App `do tab.new { space, name, folder, argv?, task? }`. `space` is the workspace id; `name` is the first line of the first message (at most 40 characters), else the recipe's label; `folder` is the requested `cwd`, else the workspace's folder. `task` is the first message, which Herdr sends once the agent is ready. `argv` is the recipe's command followed by its arguments (`src/server/agent-recipes.ts`): only flags the CLI documents, built by the server from validated choices, never from client text. Codex always gets `--no-daemon`, without which its commands would run outside the Core.
   - **Resume**: with `resumeSessionId`, the recipe adds its resume arguments: claude `--resume <id>`, codex `resume <id>` (after `--no-daemon`), opencode `--session <id>`, pi `--session <file>` (the session file the id names, `agent-session-normalization.md` §2.6). AGY and a plain terminal cannot resume.
2. **Result**: The reply names the new `terminal`. Pigeon takes a snapshot and answers with that terminal as the pane and the tab that holds it. A reply without a terminal, or a terminal in no tab, is `invalid_response`.
3. **Failure**: When `tab.new` fails, the App has created nothing. A program that exits right after launch is shown by the App as an error toast, and its pane has no agent.
4. **Startup prompts** (directory trust, login) appear as ordinary prompts on the new pane (§8.2), or as the raw key pad.

The `terminal` recipe sends no `argv`, so the tab starts the machine's shell.

**Close**: App `do tab.close { id, confirmed: true }` ends the tab's terminals. The phone's close dialog is the confirmation. Closing a space's last tab also closes the space.

**Rename**: App `do tab.rename { id, name }`, then a snapshot.

## 6. Prompting and Command Execution

- **Prompt**: Core `terminal.send { terminal, text }` for every pane. It pastes the text and presses Enter once nobody has typed for about 3 seconds.
- **Keys**: Core `terminal.keys { terminal, keys }`. Key names are the Core's (`enter`, `esc`, `up`, `ctrl+c`, `1`, …).
- **Interrupt**: The phone sends the recipe's interrupt keys (`esc` for agents, `ctrl+c` for a terminal) as keys, the same key the Core's own `terminal.interrupt` would choose.
- **Answer**: The option's digit is sent with `terminal.keys`, exactly once. A failed or timed-out send is **not retried**, because it may already have landed. The screen is re-read after about 300 ms to report whether the prompt went away (`protocol.md` §4.1).
- **Error translation**:

  | Herdr | Protocol |
  | :--- | :--- |
  | `blocked` | `ERR_AGENT_BLOCKED` |
  | `unavailable` | `ERR_AGENT_NOT_READY` |
  | `not_found`, `finished` | `ERR_NOT_FOUND` |
  | `timeout` | `ERR_TIMEOUT` |
  | anything else | `ERR_INTERNAL` |

## 7. Agent Menus and Slash Commands

Pigeon does not drive agent menus with a state machine. An agent command such as `/model`, `/compact` or a skill invocation is sent as prompt text (§6). The menu it opens is then either:
- a recognized numbered prompt (§8.2), answered with one tap; or
- a menu without numbers, answered with the raw key pad (arrows, Enter, Esc).

**Runtime model switch** (`protocol.md` §4.9): claude accepts `/model <id>` as prompt text. Another agent declares a runtime model or effort switch only once it has been checked against the real CLI: either a command that takes the value as text, or its model menu driven the way the screen shows it (a numbered option, or the value typed into the menu's search followed by Enter). An agent without a checked switch has none, and the phone offers its values only when creating a session. Checked (2026-11-07):

| Agent | Model | Effort |
| :--- | :--- | :--- |
| claude | `/model <id>` | none: `/effort <level>` also saves the level as the default for new sessions |
| codex | `/model <id>` (this session only) | `/model --reasoning=<level>` (this session only) |
| pi | none: `/model <text>` opens a fuzzy picker that can choose another model | `/thinking <level>` |
| opencode | none: `/models` is a picker searched by label | none |
| agy | none: `/model <id>` also saves the model as the default for new sessions | none (the model names its effort) |

### 7.1 Model catalog
Each recipe's model list (`protocol.md` §5.7) comes from a catalog the daemon keeps in memory, one list per agent, filled from the agent's own source:

| Agent | Source | Thinking levels |
| :--- | :--- | :--- |
| claude | the CLI's aliases (`opus`, `sonnet`, `haiku`) | the effort ladder (`low` … `max`); none for `haiku` |
| codex | `~/.codex/models_cache.json` (models not marked hidden) | the model's `supported_reasoning_levels` |
| pi | `~/.pi/agent/models-store.json`: every provider's `models[]` (`id`, `name`, `reasoning`, `thinkingLevelMap`); the id sent is `<provider>/<id>` | when `reasoning` is true: the keys of `thinkingLevelMap` whose value is not null; without a map, the levels pi offers for the model (checked against the CLI) |
| opencode | the output of `opencode models`, one `<provider>/<model>` per line | none |
| agy | the output of `agy models`, one `<id>` TAB `<label>` per line | none: each model already names its effort (`gemini-3.8-flash-high`, label `Gemini 3.8 Flash (High)`) |

- The sources are files and command output written by other programs: a trust boundary. An entry without a string id is skipped; a source that is missing, fails or times out leaves that agent's previous list in place and is not an error the phone sees.
- The catalog is filled at daemon start, off the startup path, so `welcome` never waits for it. It is filled again when `models_refresh` asks for it (`protocol.md` §4.14), and when a bound session's records name a model (source `log`) that the agent's list lacks — at most once per model name, so a model the source never lists does not refresh in a loop.
- After every fill that changes a list, every connected phone gets `recipes_sync` (`protocol.md` §5.9).


## 8. Screen Parse Rules

The parse rules (`src/server/card-classifier.ts`) are the same for every agent. Before parsing, leftover ANSI escapes are stripped and TUI box borders (`│ … │`) are removed.

### 8.1 Cards
- **tool_call**: a line starting with `$ `, or `●`/`○` followed by `Name(args)`. A `●` line that is plain text is not a tool call. The block runs until the next block start.
  - `exitCode` is set only when the screen shows "exit code N".
- **diff**: from `diff --git` or `@@ ` to the next block start, with added and removed line counts.
- **thought**: `+ Thought`, `Thinking...`, `▸ Thought` or `∴ Thought`, up to the next block start.
- **markdown**: other text. Indentation is kept.

A card id is a hash of kind, anchor line and occurrence number, so identical blocks get distinct, stable ids.

### 8.2 Prompts
A prompt is a question line, meaning one of:
- a line starting with `Allow`, `Do you want to`, `Would you like to`, `Do you trust`, `Select`, `Choose`, `Approve` or `Permission`;
- a line with a `(y/n)`, `[y/N]` or `[Y/n]` marker;
- a line ending in `?` that is followed by numbered options.

The prompt is pending only when it sits at the bottom of the screen. After its options, only blank lines, borders, key hints ("Esc to cancel", "↑/↓ to navigate") or indented continuation lines may follow. A prompt with real output after it is history.

- **Numbered options** (`1. Yes`, `[2] No`, `(3) …`, with an optional `❯ › ▶ >` cursor) become structured options. Each has id `opt_<n>` and `keyShortcut` set to the digit. In the agent TUIs the digit selects the option directly.
- **Menus without numbers** (arrow-cursor lists, `Yes / No` lines) get **no** structured options, because a guessed key sequence could pick the wrong item. They show the raw key pad.
- **Key pad**: `fallbackKeys` is `["y","n","enter","esc"]` for y/n prompts and `["enter","esc","up","down"]` otherwise.
- **Identity**: `interactionId` is a hash of the question and the option labels, and `fingerprint` also covers the payload lines. Both stay the same while unrelated output scrolls away, and both change when the prompt changes.

### 8.3 Skills and commands
Entries come from each agent's own directories, in the order below: project directories first, then the user's, then plugins, then built-in commands. An earlier entry shadows a later one with the same invocation. Within each source, entries are sorted by invocation; built-in commands keep the order of the table. Each entry is offered with the agent's own invocation syntax.

**Project root**: `<root>` is the nearest folder at or above the pane's folder that contains `.git`; without one it is the pane's folder.

| Agent | Skills (project, then user) | Invocation |
| :--- | :--- | :--- |
| claude | `<root>/.claude/skills`, `~/.claude/skills` | `/name` |
| codex | `<root>/.agents/skills`, `~/.agents/skills`, `~/.codex/skills` | `$name` |
| pi | `<root>/.pi/skills`, `~/.pi/agent/skills` | `/skill:name` |
| agy | `<root>/.agents/skills`, `~/.gemini/antigravity-cli/skills`, `~/.gemini/antigravity-cli/builtin/skills` | `/name` |
| opencode | `<root>/.opencode/skills`, `~/.config/opencode/skills` | `/name` |

| Agent | Custom commands (project, then user) | Invocation |
| :--- | :--- | :--- |
| claude | `<root>/.claude/commands`, `~/.claude/commands` | `/name`; a file in a subfolder `a/b.md` is `/a:b` |
| codex | `~/.codex/prompts` | `/prompts:name` |
| pi | `<root>/.pi/prompts`, `~/.pi/agent/prompts` | `/name` |
| opencode | `<root>/.opencode/command`, `~/.config/opencode/command` | `/name` |

**Claude plugins**: every plugin in `~/.claude/plugins/installed_plugins.json` (key `<plugin>@<marketplace>`, entries with an `installPath`) contributes its `skills/*/SKILL.md` and `commands/*.md` with source `plugin`, invoked as `/<plugin>:<name>`. A missing install path contributes nothing; an unparseable file fails loudly.

**Built-in commands** (source `builtin`, kind `command`): a short list of commands that make sense from a phone. Commands the phone already has native UI for (`/model`) are not listed.

| Agent | Built-in commands (`descriptionId`) |
| :--- | :--- |
| claude | `/compact` (`compact`), `/clear` (`clear`), `/init` (`init_claude_md`) |
| codex | `/compact` (`compact`), `/new` (`new`), `/init` (`init_agents_md`), `/review` (`review`) |
| opencode | `/compact` (`compact`), `/new` (`new`), `/init` (`init_agents_md`) |
| pi | `/compact` (`compact`), `/new` (`new`) |

A built-in command's `description` is English; the phone shows its own text for the `descriptionId` (`protocol.md` §5.7).

A skill is a directory containing `SKILL.md`; a command is a `.md` file. The description is the front matter `description:` (else the first non-empty body line, for commands). These files are untrusted and are rendered as text.
