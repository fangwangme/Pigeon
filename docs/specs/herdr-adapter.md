# Herdr Adapter Specification

## 1. Scope and Isolation Contract

`src/server/herdr-client.ts` (`HerdrClient`) is the only Pigeon component that talks to the Herdr daemon. The rest of the daemon (WebSocket server, pane store, UI) consumes its domain objects (`SnapshotPayload`, `PaneStatePayload`) and its events. It never sees Herdr's wire format.

Herdr is the source of truth for topology, agent identity and agent status. Pigeon adds exactly one thing on top: it classifies the screen text of the panes a phone is looking at into cards and prompts (§8).

## 2. API Contract-First and Herdr Compatibility

- **No version pinning**: Pigeon does not assert a Herdr version. It relies on the socket API documented by `herdr api schema --json`, and was developed against Herdr 0.9.5 (protocol 22).
- **Unknown fields are ignored** when reading snapshots and responses.
- **Channel**: the Unix socket at `$HERDR_SOCKET_PATH`, or `~/.config/herdr/herdr.sock` by default, carrying newline-delimited JSON. This path is resolved from the environment at every start and never written to `config.json`.
- **One request per connection**: Every RPC opens a fresh connection, sends one request, reads one response and closes. The event subscription has its own long-lived connection, and no other request is ever sent on it (Herdr resets a subscription socket that receives one).
- **Errors**: A Herdr `{"error":{code,message}}` response, or a socket failure, becomes a `HerdrError(code)`. The socket failures `ECONNREFUSED`, `ENOENT`, `ECONNRESET` and `EPIPE` mean "Herdr not reachable". They change connection state (§3.4) and are not logged as bugs. Every other failure is logged with its stack trace.

## 3. Event Subscription & Lifecycle Synchronization

### 3.1 Snapshot
`session.snapshot` is the baseline. It returns workspaces, tabs, panes and agents.
- Each snapshot rebuilds the pane facts: workspace, tab, agent kind, `cwd`, Herdr status and agent session.
- State for panes missing from the snapshot is dropped, so a reused pane id never shows old data.
- A snapshot is taken at startup, shortly after every topology event (debounced), every time the subscription (re)connects, and every 30 seconds as reconciliation.

### 3.2 Subscription
`events.subscribe` is sent with:
- the global events `workspace.{created,updated,renamed,closed,focused}`, `tab.{created,closed,focused,renamed,moved}` and `pane.{created,closed,focused,moved,exited,agent_detected}`, each of which schedules a snapshot;
- one `pane.agent_status_changed` subscription per pane that has an agent. When the set of agent panes changes, the subscription is rebuilt.

A `pane_agent_status_changed` event updates that pane's status at once, notifies the push logic (`push.md` §4), and schedules a screen read when the pane is blocked or already being watched.

### 3.3 Screen Reads
Herdr has no "output changed" event. The panes that connected clients are viewing (the union over all connections) are therefore read once per second with `pane.read` (`source: "recent_unwrapped"`, last 200 lines).
- A pane is not polled while a read of it is still in flight.
- A screen whose hash is unchanged is dropped before classification.
- A changed screen produces a new `PaneStatePayload` with the next `revision`.
- Reads after sending keys always read fresh and never reuse a read already in flight.

### 3.4 Connection State
The client is connected while requests or the subscription reach Herdr. Losing Herdr is an expected state:
- it is reported through `upstream_status`;
- the subscription reconnects every 3 seconds;
- startup does not fail when Herdr is not running.

`disconnect()` stops every timer and socket. Before `connect()`, the client opens no sockets and starts no timers.

## 4. Agent Lifecycle States

Pigeon uses Herdr's agent states unchanged: `idle`, `working`, `blocked`, `done` and `unknown` (no agent detected).

A pane's effective status is Herdr's status, with one override: a prompt recognized on screen (§8.2) makes it `blocked`. When Herdr says `blocked` but no prompt is recognized, the pane still gets a pending interaction. That interaction has no options, so the phone shows the raw key pad instead of hiding the fact that the agent is waiting.

Prompts are not refused while an agent is `working`: the agents queue typed input. A prompt sent while `blocked` is refused by Herdr (`agent_blocked`).

## 5. Tab Creation and Agent Launch Sequence

1. **Create tab**: `tab.create { workspace_id, cwd? }` returns `tab.tab_id` and `root_pane.pane_id`.
2. **Name**: `p-<kind>-<6 hex>`, which matches Herdr's `^[a-z][a-z0-9_-]{0,31}$`.
3. **Start agent**: `agent.start { pane_id, kind, name, args? }`. `args` come from the agent recipe (`src/server/agent-recipes.ts`): only flags the CLI documents, built by the server from validated model and thinking choices, never from client text.
4. **Failure**: If `agent.start` fails, the new tab is closed with `tab.close` and the error is returned. No empty tab is left behind.
5. **Startup prompts** (directory trust, login) appear as ordinary prompts on the new pane (§8.2), or as the raw key pad.

The `terminal` recipe creates the tab without starting an agent.

## 6. Prompting and Command Execution

- **Prompt**: For a pane with an agent, Pigeon uses `agent.prompt { target, text }`, which handles bracketed paste and submission. For a plain pane, it uses `pane.send_text` followed by `pane.send_keys ["enter"]`.
- **Keys**: `pane.send_keys { pane_id, keys }`.
- **Answer**: The option's digit is sent with `pane.send_keys`, exactly once. A failed or timed-out send is **not retried**, because it may already have landed. The screen is re-read after about 300 ms to report whether the prompt went away (`protocol.md` §4.1).
- **Error translation**:

  | Herdr | Protocol |
  | :--- | :--- |
  | `agent_blocked` | `ERR_AGENT_BLOCKED` |
  | `agent_not_ready` | `ERR_AGENT_NOT_READY` |
  | `agent_prompt_stalled` | `ERR_TIMEOUT` |
  | `timeout` | `ERR_TIMEOUT` |
  | `pane_not_found` | `ERR_NOT_FOUND` |
  | anything else | `ERR_INTERNAL` |

## 7. Agent Menus and Slash Commands

Pigeon does not drive agent menus with a state machine. An agent command such as `/model`, `/compact` or a skill invocation is sent as prompt text (§6). The menu it opens is then either:
- a recognized numbered prompt (§8.2), answered with one tap; or
- a menu without numbers, answered with the raw key pad (arrows, Enter, Esc).

The default "模型" macro is the text `/model`.

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

### 8.3 Skills
Skills come from each agent's own skill directories: project directories first, so a project skill shadows a user skill of the same name. Each skill is offered with the agent's own invocation syntax.

| Agent | Directories (project, then user) | Invocation |
| :--- | :--- | :--- |
| claude | `<cwd>/.claude/skills`, `~/.claude/skills` | `/name` |
| codex | `<cwd>/.agents/skills`, `~/.agents/skills`, `~/.codex/skills` | `$name` |
| pi | `<cwd>/.pi/skills`, `~/.pi/agent/skills` | `/skill:name` |
| agy | `<cwd>/.agents/skills`, `~/.gemini/antigravity-cli/skills`, Antigravity builtin skills | `/name` |
| opencode | `<cwd>/.opencode/skills`, `~/.config/opencode/skills` | `/name` |

A skill is a directory containing `SKILL.md`. Its description is the front matter `description:`. Skill files are untrusted and are rendered as text.
