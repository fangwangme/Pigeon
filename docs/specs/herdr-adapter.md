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
- Both paths are resolved from the environment at every start (or from `--herdr-app-sock` / `--herdr-core-sock`) and never written to `config.json`. On macOS, where `XDG_RUNTIME_DIR` is usually unset, the Core default is the path Herdr Core itself uses on macOS (checked against `hc` on a Mac). When the Core path cannot be resolved, the daemon refuses to start.
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
- A tab named only by its number is labelled after its primary pane's session title, else its agent recipe, else `Tab <n>`.
- Each snapshot rebuilds the pane facts. State for panes missing from the snapshot is dropped, so a reused address never shows old data.
- A terminal the App shows but the Core does not list (it finished, or its machine is not connected) is a pane without an agent and with status `unknown`.
- **Branch**: a workspace's `branch` is read from its folder, a tab's from its first pane's folder: walk up to the nearest `.git` (a directory, or a worktree's `.git` file naming its `gitdir`), read its `HEAD`, and take the name after `ref: refs/heads/`. A detached HEAD or no repository gives no branch. Read failures other than a missing file fail loudly.
- A snapshot is taken at startup, shortly after every topology event (debounced), every time the subscription (re)connects, and every 30 seconds as reconciliation. The reconciliation also picks up renames in the App, which no Core event reports.
- A pane status in a snapshot that differs from the one Pigeon holds is handled exactly like a `status` event (§3.2): viewers, push triggers and the prompt queue see it. This covers changes missed while the subscription was down.

### 3.2 Subscription
Core `events.subscribe {}` covers every terminal. Its notifications are `{"method":"event","params":{"type","terminal","data"}}`:
- `status`: `data.status` is the terminal's new root status record. It updates that pane's status at once, notifies the push logic (`push.md` §4) and the prompt queue (`protocol.md` §4.2), schedules a screen read when the pane is blocked or already being watched, and re-evaluates the session binding of that pane only (`agent-session-normalization.md` §2.0). It schedules no snapshot.
- `created`, `removed`, `finished`, `lost`, `restarted` and `labels` schedule a snapshot. The App places a terminal in a tab through its `herdr.space` / `herdr.tab` labels.
- A `missed` notification (the subscriber fell behind) schedules a snapshot.
- Every other notification, including the 15-second `heartbeat`, is ignored.
- A notification whose `params` lack what its type needs (for `status`, a string `data.status.state`) is logged once per type and shape, and schedules a snapshot so the state is reconciled. It never throws out of the socket handler.

Status events for terminals the window does not show (hidden workers) change nothing.

### 3.3 Screen Reads
Herdr has no "output changed" event. The panes that connected clients are viewing (the union over all connections) are therefore read once per second with Core `terminal.read { terminal, lines: 200 }`.
- **Full-screen programs**: Reading history of a full-screen program scrolls it on the desktop and back. Once a read answers `how: "stitched"` — or a history read times out, which happens when the Core cannot scroll a full-screen program — Pigeon reads that terminal with `lines: 0` (the visible screen only), falling back to `lines: 0` at once on the timeout. A terminal demoted by `stitched` stays demoted for as long as it exists. A terminal demoted by a timeout (which a busy machine also causes) is tried with history again 5 minutes later; a read that then answers without `stitched` restores history reads.
- A pane is not polled while a read of it is still in flight.
- A pane nobody views is not polled; a connection that views no pane (`protocol.md` §4.4, `paneId: null`) adds nothing to the union.
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

A pane's effective status is that status, with two overrides: a prompt recognized on screen (§8.2), or a pending question or plan in the pane's bound session (`protocol.md` §5.4, transcript interaction), makes it `blocked`. When the status is `blocked` but no prompt is recognized, the pane still gets a pending interaction. That interaction has no options, so the phone shows the raw key pad instead of hiding the fact that the agent is waiting.

**Seen** (user decision, 2026-11-07): Herdr turns `done` into `idle` once the pane is looked at on the desktop, and the phone cannot tell Herdr it looked. The daemon therefore keeps its own seen mark per pane, shared by every phone. A pane is seen when a connected phone reports it is visible and viewing that pane (`presence_update`, `protocol.md` §2.1) while the pane is `done`, or when the pane turns `done` while such a phone is viewing it. A seen pane is reported as `idle` everywhere the phone gets a status (`snapshot_update`, `pane_state`, push triggers). The mark is cleared by the pane's next Core status change, so its next `done` is reported as `done` again. The mark changes only what is reported: the prompt queue (`protocol.md` §4.2) still follows the Core status. The desktop Herdr is not touched.

Prompts are not refused while an agent is `working`: the agents queue typed input. A prompt sent while `blocked` is refused by the Core (`blocked`).

The Core reports no agent session id. Pigeon binds a pane to its session from the pane's agent kind, foreground process id, folder and creation time (`agent-session-normalization.md` §2.0).

## 5. Tab Creation and Closing

1. **Create**: App `do tab.new { space, folder, argv?, task? }`. `space` is the workspace id; `name` is omitted so the tab is created without a name and Herdr's default number applies (`protocol.md` §4.5); `folder` is the requested `cwd`, else the workspace's folder. `task` is the first message, which Herdr sends once the agent is ready (except for AGY and OpenCode, whose CLIs reject a positional prompt: AGY takes `-i <text>` and OpenCode takes `--prompt <text>` in `argv`, with `task` omitted). `argv` is the recipe's command followed by its arguments (`src/server/agent-recipes.ts`): only flags the CLI documents, built by the server from validated choices, never from client text (except the first message for AGY and OpenCode, passed as one `argv` element). Codex always gets `--no-daemon`, without which its commands would run outside the Core.
   - **Model at launch**: claude, codex, agy and pi take the chosen model and effort as flags. OpenCode takes none: interactive `opencode` has no model flag, and with `OPENCODE_CONFIG_CONTENT` naming a listed model it still starts on its last-used model (checked 2026-11-07). Its recipe says so (`protocol.md` §5.7 `launchModel`).
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

  A request that fails because the socket is not reachable (§2) becomes `ERR_UPSTREAM_OFFLINE` (`protocol.md` §4.2), not `ERR_INTERNAL`.

## 7. Agent Menus and Slash Commands

Pigeon does not drive agent menus with a state machine. An agent command such as `/model`, `/compact` or a skill invocation is sent as prompt text (§6). The menu it opens is then either:
- a recognized numbered prompt (§8.2), answered with one tap; or
- a menu without numbers, answered with the raw key pad (arrows, Enter, Esc).

**No runtime model switch** (user decision, 2026-11-12): Pigeon sets a session's model and effort only at launch (§5, `protocol.md` §4.5). For reference, what each CLI offers inside a running session (checked 2026-11-07):

| Agent | Model | Effort |
| :--- | :--- | :--- |
| claude | `/model <id>` | none: `/effort <level>` also saves the level as the default for new sessions |
| codex | `/model <id>` (this session only) | `/model --reasoning=<level>` (this session only) |
| pi | none: `/model <text>` opens a fuzzy picker that can choose another model | `/thinking <level>` |
| opencode | none: `/models` is a picker searched by label | none |
| agy | none: `/model <id>` also saves the model as the default for new sessions | none (the model names its effort) |

### 7.1 Model catalog
Each recipe's model list (`protocol.md` §5.7) comes from a catalog the daemon keeps, one list per agent, filled from the agent's own source:

| Agent | Source | Thinking levels |
| :--- | :--- | :--- |
| claude | Anthropic's Models API, `GET https://api.anthropic.com/v1/models` (every page), with the Claude Code OAuth access token (`security-and-pairing.md` §6) as `Authorization: Bearer`, plus `anthropic-beta: oauth-2025-04-20` and `anthropic-version: 2023-06-01`. Id `id`, label `display_name`, in the API's order | the levels under `capabilities.effort` whose `supported` is true, in the API's order; none when `capabilities.effort.supported` is false |
| codex | `~/.codex/models_cache.json` (models not marked hidden) | the model's `supported_reasoning_levels` |
| pi | `~/.pi/agent/models-store.json`: every provider's `models[]` (`id`, `name`, `reasoning`, `thinkingLevelMap`); the id sent is `<provider>/<id>` | when `reasoning` is true: the keys of `thinkingLevelMap` whose value is not null; without a map, the levels pi offers for the model (checked against the CLI) |
| opencode | ids from the output of `opencode models`, one `<provider>/<model>` per line; the label from OpenCode's models cache `~/.cache/opencode/models.json`, entry `<provider>.models.<model>` (`<provider>` is the id up to its first `/`), field `name`; the id when the cache lacks the entry | the `values` of the entry's `reasoning_options` item whose `type` is `effort`; none otherwise |
| agy | the output of `agy models`, one `<id>` TAB `<label>` per line | none: each model already names its effort (`gemini-3.8-flash-high`, label `Gemini 3.8 Flash (High)`) |

- **Persistence and the daily limit** (user decision, 2026-11-12): the catalog is written to `models.json` in the instance's state directory after every fill that changed it, with the time of each agent's last successful fetch, and read when the catalog is created, so the lists are there before any source answers. An automatic fill (daemon start, a model named by session records that the list lacks) requests the Claude Models API only when its last successful request is more than 24 hours old; a fill asked by `models_refresh` (`protocol.md` §4.15) always requests. The other sources are local and are read on every fill. Without Claude credentials no request is made.
- `ModelCatalog` takes, besides `home` and `env`, the options `cachePath`, `anthropicModelsUrl` (default: the Models API URL above), `keychain` (read the Claude credential from the macOS keychain, as `quota-and-usage.md` does; default on macOS) and `now`, so tests use a temporary file, a local server, the credential file and a fixed clock. `refresh()` is the automatic fill; `models_refresh` is the asked fill.
- Session records name Claude models by full id (`claude-opus-5-5`), which the list holds; Claude's `<synthetic>` is never a model (`agent-session-normalization.md` §2.3). The CLI's aliases are not listed.
- The sources are files, command output and an external API written by other programs: a trust boundary. An entry without a string id is skipped; a source that is missing, fails or times out leaves that agent's previous list in place and is not an error the phone sees.
- A model value read from session records is resolved to a catalog id through `ModelCatalog.resolve(agent, idOrLabel)`: by exact id, else by case-insensitive label match, else kept as read. An unknown value triggers the existing one-time refill (`noteModel`).
- The catalog is filled at daemon start, off the startup path, so `welcome` never waits for it. It is filled again when `models_refresh` asks for it (`protocol.md` §4.14), and when a bound session's records name a model (source `log`) that the agent's list lacks — at most once per model name, so a model the source never lists does not refresh in a loop.
- After every fill that changes a list, every connected phone gets `recipes_sync` (`protocol.md` §5.9).


### 7.2 Answering transcript questions
A transcript interaction (`protocol.md` §5.4) is answered with the keys the agent's question UI takes, checked against the real CLI and listed here per agent, with the date of the check. An agent not listed, and any question kind its row does not cover (a multi-select question, typing an "other" answer), is answered in the terminal view (`mobile-ui-and-themes.md` §5).

| Agent | Question tool | Keys for option `n` of question `k` |
| :--- | :--- | :--- |

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
- **What counts as a menu**: an arrow-cursor list is a prompt's option block only when at least two consecutive option lines start directly under the question line and one of them carries the cursor (`❯ › ▶ >`). A single cursor line — such as the agent's own input line (`> `, `❯ `) — is never a menu.
- **A question line alone** (no numbered options, no cursor list) is a prompt only when it carries a `(y/n)`, `[y/N]` or `[Y/n]` marker. Plain output that starts with `Select`, `Choose` and the like, sitting above the agent's input line, is therefore not a prompt; when the agent really waits, Herdr's `blocked` still produces an interaction without options (§4).
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
