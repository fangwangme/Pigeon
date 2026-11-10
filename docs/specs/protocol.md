# Wire Protocol Specification

## 1. Overview and Design Principles

The phone and the Pigeon daemon talk through **typed JSON messages over one WebSocket** (`/ws`). Pairing goes through `POST /api/pair` (`security-and-pairing.md`) and attachments through `POST /api/uploads` (§7). The TypeScript source of truth is `src/types/protocol.ts`. Runtime validation of every client frame lives in `src/server/ws-validate.ts`.

Key Protocol Principles:
1. **No guessed keys**: A prompt is answered with `interaction_respond`, which names an `interactionId`, a screen `fingerprint` and an `optionId`. The server sends exactly that option's key, and only while the same prompt is still on screen. Anything without a structured option goes through the raw key pad (`agent_send_keys`).
2. **State, not replay**: Each pane update carries the full classified state of the pane (`pane_state`) with a per-pane `revision`. A reconnecting client gets the current state, and nothing is replayed from a log offset.
3. **Application heartbeats**: `ping`/`pong` frames detect half-open mobile connections. `presence_update` frames drive push suppression.
4. **Desktop non-interference**: Choosing what the phone shows (`select_view`) never moves keyboard focus in the desktop Herdr session.
5. **Validate at the boundary**: Every client frame is validated before dispatch. A frame that fails validation, or has an unknown `type`, is answered with `ERR_INVALID_PAYLOAD`.

## 2. Connection Lifecycle and Heartbeat

### 2.1 Heartbeat (`client <-> server`)
- The client sends `{ "type": "ping", "timestamp": 1729650000000 }` every 15 seconds. The server answers `{ "type": "pong", "timestamp": … }`.
- **Timeout**: If no `pong` has arrived for 30 seconds, the client closes the socket and reconnects.
- **Wakeup**: When `document.visibilityState` becomes `visible`, the client reconnects at once if the socket is not open or the last `pong` is older than 30 seconds.
- With every heartbeat, and whenever visibility or the viewed pane changes, the client sends `{ "type": "presence_update", "isVisible": true, "viewingPaneId": "w1:p2" }`. This message has no `id` and gets no reply.

### 2.2 Refusals and Closure Codes
- A WebSocket upgrade without a valid session cookie is refused with HTTP **401**. A wrong `Host` or `Origin` is refused with HTTP **403** (`security-and-pairing.md` §4). In the browser, both show up as a plain close. Before reconnecting, the client checks `GET /api/auth/status` and shows the pairing guidance when it is not paired. When that check cannot reach the daemon (it is restarting, or the network is down), the client tries again 3 seconds later.
- `4403`: The device was revoked (`pigeon devices revoke`). The client shows the pairing guidance and does not reconnect.
- `4409`: Incompatible protocol major version. The client does not reconnect.
- The client also treats `4401` and `1008` as final.

## 3. Handshake and Initial Synchronization

### 3.1 Handshake Request (`client -> server`)
```json
{ "type": "hello", "id": "cli_1", "payload": { "protocolVersion": "1.0.0", "subscribePaneId": "w1:p2", "have": { "sessionId": "s_1", "turnCount": 5, "lastTurnHash": "a1b2c3d4" } } }
```
If the major version differs from the server's, the server answers `ERR_INCOMPATIBLE_PROTOCOL` and closes the socket with `4409`. `have` is optional: when the client has a cached transcript for `subscribePaneId`, it supplies its `sessionId`, `turnCount`, and `lastTurnHash` (FNV-1a 32-bit over `JSON.stringify(turn)` of the turn at index `turnCount - 1`, as lowercase hex) to request an incremental resume (§3.3).

### 3.2 Handshake Response (`server -> client`)
```json
{
  "type": "welcome",
  "replyTo": "cli_1",
  "payload": {
    "protocolVersion": "1.0.0",
    "serverVersion": "0.1.0",
    "buildId": "3f9a0c21d7e4",
    "deviceId": "6f1c…",
    "clientConfig": { "themeMode": "system", "accent": "blue" },
    "recipes": { "claude": { "kind": "claude", "label": "Claude Code", "models": [], "interruptKeys": ["esc"] } }
  }
}
```
Then come, in this order, `upstream_status` (§5.5) and `snapshot_update` (§5.3).

`buildId` identifies the client bundle the daemon serves (the first 12 hex digits of its SHA-256). The first `welcome` a page receives records it. When a later `welcome` (after a reconnect) carries a different `buildId`, the daemon was rebuilt and restarted: the page shows the update banner, and tapping it reloads the page (`architecture.md` §4.1).

### 3.3 Initial Pane Data (`server -> client`)
The server picks a pane. It uses `subscribePaneId` when Herdr knows that pane, otherwise Herdr's focused pane. It subscribes the connection to that pane and sends:
1. `normalized_turns` (§5.6) or `turns_delta` (§5.6): if `have` is given, the pane's bound session id equals `have.sessionId`, it has at least `turnCount` turns, and the hash of turn `turnCount - 1` matches `have.lastTurnHash` → send `turns_delta` with `sinceTurnIndex: turnCount`, the remaining turns, and `sessionStats`, `sessionTitle`, `todos`, `session`. Otherwise → the full `normalized_turns` exactly as today. This is always sent (or resumed), with `turns: []` and `session.bound: false` for panes without a structured session, so the client never keeps the previous pane's conversation.
2. `skills_sync` (§5.7) for that pane's agent and project directory.
3. `prompt_queue` (§5.8) for that pane, empty when nothing is queued.
4. `pane_state` (§5.4): the cached state at once if the pane was read before, then a fresh screen read. The fresh read reaches the client as another `pane_state` only if the screen changed.

`select_view` (§4.4) runs the same four steps for a different pane.

## 4. Client Commands (`client -> server`)

Every command except `ping` and `presence_update` carries a string `id`. Success is answered with `ack` (§5.1), failure with `error` (§5.2). Commands that name a pane are answered with `ERR_NOT_FOUND` when that pane is not in the latest Herdr snapshot.

### 4.1 Answer Interactive Prompt (`interaction_respond`)
```json
{
  "type": "interaction_respond",
  "id": "cli_7",
  "payload": { "targetPaneId": "w1:p2", "interactionId": "int_4ae721c8e2", "fingerprint": "fp_88a7b9c1d2e3", "optionId": "opt_2" }
}
```
*Server Behavior*:
1. If the pane has no pending prompt, or its `interactionId` or `fingerprint` differs, or another answer for that pane is still being sent (a double tap), the server rejects with `ERR_INTERACTION_STALE` and sends no key. The client then re-selects the pane to get fresh state.
2. If `optionId` is not one of the prompt's options, the server rejects with `ERR_INVALID_PAYLOAD`.
3. The server sends exactly the option's `keyShortcut`, which is its digit (`herdr-adapter.md` §8), once through Herdr Core `terminal.keys`. A failed send is never retried, because a timed-out send may already have landed.
4. After about 300 ms the server re-reads the screen. It acks `{ "approved": true, "interactionId": … }` when that prompt is gone, or `{ "approved": false, … }` when it is still showing. On `approved: false` the client opens the raw terminal sheet.

### 4.2 Submit Prompt (`agent_prompt`)
```json
{ "type": "agent_prompt", "id": "cli_8", "payload": { "targetPaneId": "w1:p2", "text": "Fix the unit tests in auth.test.ts", "attachments": ["up_3f9a0c21d7e4b5a6"] } }
```
- `text` may be empty only when `attachments` is not. `attachments` holds at most 10 upload ids from §7. An id the daemon does not know is `ERR_INVALID_PAYLOAD`, and nothing is sent.
- **Attachments**: the daemon appends one line per attachment after a blank line: the file's absolute path, prefixed with the recipe's file-mention prefix (`@` for claude, opencode, pi and agy; none for codex and a plain terminal).
- **Queue**: when the pane's Herdr status is `working`, or the pane already has queued prompts, the prompt is queued instead of sent (user decision, 2026-11-06). The ack carries `{ "queued": true, "queueId": "q_…" }`, and every viewer of the pane gets `prompt_queue` (§5.8). When the pane's status next becomes `idle` or `done`, the daemon sends the oldest queued prompt, marking it `sending: true` in `prompt_queue`. The prompt remains in `prompt_queue` in the `sending` state until a new user turn appears in this pane's transcript (including the initial turn of a fresh session), or sending fails, or a safety timeout (30 seconds) expires. When the pane has no bound session, the prompt is cleared from the queue immediately after send. While in `sending` state, client edits and cancels respond with `ERR_NOT_FOUND`. A queued prompt that fails to send is dropped from the queue and reported to the viewers as `error` with that prompt's `queueId` in `details`. The prompt queue is persisted to disk on each change (`queue.json` or `queue-<port>.json`) and restored on daemon restart; a prompt in `sending` state is not restored; closing the pane drops its queue. When the daemon starts with restored queued items, any pane whose status is already `idle` or `done` in the initial Herdr snapshot dispatches its oldest queued prompt at once.
- **Immediate send**: otherwise the server calls Herdr Core's `terminal.send`, which pastes the text and presses Enter, for agents and plain shells alike, and acks `{ "queued": false }`. Herdr's `blocked` surfaces as `ERR_AGENT_BLOCKED`, `unavailable` as `ERR_AGENT_NOT_READY`, and a timed-out request as `ERR_TIMEOUT` (`herdr-adapter.md` §6).
- Agent slash commands (`/compact`, a skill's invocation) are ordinary prompt text.

### 4.3 Dispatch Raw Keys (`agent_send_keys`)
```json
{ "type": "agent_send_keys", "id": "cli_9", "payload": { "targetPaneId": "w1:p2", "keys": ["ctrl+c"] } }
```
`keys` holds 1–16 Herdr key names. Each matches `^[a-z0-9+_-]{1,24}$` (case-insensitive). This command serves the terminal view's keys and the stop button (`mobile-ui-and-themes.md` §3.5, §5).

### 4.4 Switch Mobile View (`select_view`)
```json
{ "type": "select_view", "id": "cli_10", "payload": { "paneId": "w1:p4", "have": { "sessionId": "s_1", "turnCount": 5, "lastTurnHash": "a1b2c3d4" } } }
```
This moves the connection's subscription and sends the pane data from §3.3 (resumed incrementally via `turns_delta` when `have` matches, else full `normalized_turns`). Desktop focus is not touched. Herdr polls the union of the panes that connected clients are viewing.

### 4.5 Create Tab and Launch Agent (`create_tab_and_agent`)
```json
{
  "type": "create_tab_and_agent",
  "id": "cli_11",
  "payload": { "workspaceId": "w1", "agentKind": "claude", "modelId": "opus", "thinking": "high", "cwd": "/home/user/project", "firstMessage": "Fix the flaky test", "resumeSessionId": "2c9ad7c8-eac4-4643-82f8-51bf56057348" }
}
```
*Server Behavior*: The server checks the request against the recipe:
- `agentKind` must be a known recipe.
- `modelId`, if given, must be one of the recipe's models, and the recipe must take a model at launch (§5.7 `launchModel`).
- `thinking`, if given, must be one of that model's levels.
- `cwd`, if given, must be absolute. Without it the tab starts in the workspace's folder.
- `firstMessage`, if given, is 1–100 000 characters. It is handed to Herdr as the tab's first message; the tab is created without a name, so Herdr's default number applies and the label rule in §5.3 takes over.
- `resumeSessionId`, if given, matches `^[A-Za-z0-9._-]{1,128}$` and the recipe must support resuming (`herdr-adapter.md` §5).

Any violation gets `ERR_INVALID_PAYLOAD` before anything is created. The launch sequence is in `herdr-adapter.md` §5. The daemon remembers the launch model and thinking level for the new pane (shown as source `launch`, §5.6). The ack carries `{ "workspaceId", "tabId", "paneId" }`, and the client switches to the new pane.

### 4.6 Close Tab (`close_tab`)
```json
{ "type": "close_tab", "id": "cli_12", "payload": { "tabId": "w1:t1" } }
```
This closes the tab through Herdr (ending its processes) and refreshes the snapshot. The ack carries `{ "closedTabId" }`.

### 4.7 Query Skills (`skills_get`)
```json
{ "type": "skills_get", "id": "cli_13" }
```
The server answers with `skills_sync` for the connection's current pane.

### 4.8 Configuration (`config_get`, `config_patch`)
See §6.

### 4.9 Change Model or Effort (`agent_set_model`)
```json
{ "type": "agent_set_model", "id": "cli_14", "payload": { "targetPaneId": "w1:p2", "modelId": "sonnet", "thinking": "high" } }
```
At least one of `modelId` and `thinking` is given. Each must be one the pane's recipe offers (`thinking` for the given model, else for the pane's current model). The daemon builds the agent's own runtime command from the recipe (`herdr-adapter.md` §7) and submits it like §4.2, queueing included. A recipe without a runtime command for that value answers `ERR_INVALID_PAYLOAD` and sends nothing. The client never builds the command text.

### 4.10 List Past Sessions (`sessions_list`)
```json
{ "type": "sessions_list", "id": "cli_15", "payload": { "workspaceId": "w1", "agentKind": "claude" } }
```
The ack carries `{ "sessions": [ { "id", "title", "updatedAt" } ] }`: the agent's own sessions whose project folder is the workspace's folder or below it, newest first, at most 50 (`agent-session-normalization.md` §2.6). `title` is the session's title, else its first user message (at most 120 characters). An agent kind without a session store answers with an empty list; an unknown workspace is `ERR_NOT_FOUND`.

### 4.11 Rename Tab (`tab_rename`)
```json
{ "type": "tab_rename", "id": "cli_16", "payload": { "tabId": "tab1", "name": "auth tests" } }
```
`name` is 1–80 characters after trimming. The tab is renamed in Herdr and the snapshot refreshed; the ack carries `{ "tabId", "name" }`. An unknown tab is `ERR_NOT_FOUND`.

### 4.12 Devices (`devices_list`, `device_revoke`)
`devices_list` acks `{ "devices": [ { "deviceId", "deviceName", "createdAt", "lastUsedAt", "isThisDevice" } ] }`, newest `createdAt` first. `device_revoke { deviceId }` revokes that device exactly like `pigeon devices revoke` (`security-and-pairing.md` §5): its connections close with `4403`. An unknown device is `ERR_NOT_FOUND`. Revoking this device acks first, then closes this connection.

### 4.13 Cancel a Queued Prompt (`queue_cancel`)
```json
{ "type": "queue_cancel", "id": "cli_17", "payload": { "targetPaneId": "w1:p2", "queueId": "q_1a2b3c" } }
```
Removes the prompt from the pane's queue and sends `prompt_queue` to the viewers. A `queueId` that is no longer queued or is currently in `sending` state is `ERR_NOT_FOUND`.

### 4.14 Update a Queued Prompt (`queue_update`)
```json
{ "type": "queue_update", "id": "cli_18", "payload": { "targetPaneId": "w1:p2", "queueId": "q_1a2b3c", "text": "updated prompt", "attachments": ["up_0000000000000001"] } }
```
Updates the text and attachments of an existing queued prompt in-place, preserving its exact queue index and order. Rebroadcasts `prompt_queue` to the viewers. A `queueId` that is no longer queued or is currently in `sending` state responds with `ERR_NOT_FOUND`.

### 4.15 Refresh Model Lists (`models_refresh`)
```json
{ "type": "models_refresh", "id": "cli_19", "payload": {} }
```
Fills the model catalog again from every agent's source (`herdr-adapter.md` §7.1). The ack comes once the fill has finished and carries `{ "recipes": { … } }` in the shape of §5.7; every connected client also gets `recipes_sync` (§5.9) when a list changed.

### 4.16 Quota (`quota_get`)
```json
{ "type": "quota_get", "id": "cli_20", "payload": {} }
```
Answers with the quota of every provider (`quota-and-usage.md` §2). Answers from the daemon's 60-second provider cache to protect upstream provider rate limits. When `quotaUsageEnabled` is `false` (`quota-and-usage.md` §1.1), the request is rejected with `ERR_FEATURE_DISABLED` without querying any provider. The ack carries:
```json
{ "providers": [ { "provider": "claude", "enabled": true,
    "snapshot": { "provider": "claude", "plan": "pro", "account": "you@example.com", "fetchedAt": 1794218000000, "credits": [],
      "windows": [ { "id": "five_hour", "label": "5h", "usedPercent": 52, "periodMs": 18000000, "resetsAt": 1794228620000 } ] },
    "error": null } ] }
```
One entry per provider, enabled or not; a disabled provider has `snapshot: null` and is not fetched. A provider that failed has `error: { "message", "at" }` and keeps its previous `snapshot` (or null when it never had one). Provider failures never turn into a command error.

### 4.17 Usage Report (`usage_get`)
```json
{ "type": "usage_get", "id": "cli_21", "payload": { "preset": "custom", "from": "2026-10-01", "to": "2026-10-31", "agents": ["claude", "codex", "agy", "opencode", "pi"] } }
```
`preset` is `today`, `7d`, `30d`, `year`, `all` or `custom`; `custom` requires `from` and `to` (`YYYY-MM-DD`), which other presets must not carry. An optional boolean `force` (the refresh button) scans what changed before answering, also in scheduled mode (`quota-and-usage.md` §3.7). `agents` is a non-empty list of distinct agent kinds and filters every figure in the reply. Anything else is `ERR_INVALID_PAYLOAD` and nothing is scanned. When `quotaUsageEnabled` is `false` (`quota-and-usage.md` §1.1), the request is rejected with `ERR_FEATURE_DISABLED` without scanning files or querying prices. The ack carries:
- `range` (`from`, `to`), `firstDay` (the first day with usage, or null), `scannedAt`, `pricesAvailable`;
- `totals` and, when `quota-and-usage.md` §3.5 gives one, `comparison` (`from`, `to`, `totals`); totals are `{ cost, tokens, input, output, cacheRead, cacheWrite, messages, sessions }`;
- `days`: every day of the range with usage, newest first, each with the totals fields and `date`;
- `models`: every model with usage in the range, each with the totals fields, `model`, `company`, `agents` (kinds), `lastUsed` and `unpriced`.

### 4.18 Day Detail (`usage_day`)
```json
{ "type": "usage_day", "id": "cli_22", "payload": { "date": "2026-11-06", "agents": ["claude", "codex"] } }
```
When `quotaUsageEnabled` is `false`, the request is rejected with `ERR_FEATURE_DISABLED`. The ack carries `date`, `totals`, and `agents`: per agent its totals and `models` (each model's totals), sorted by cost.

### 4.19 Model Detail (`usage_model`)
```json
{ "type": "usage_model", "id": "cli_23", "payload": { "model": "gpt-5-6-sol", "from": "2026-10-11", "to": "2026-11-09", "agents": ["codex"] } }
```
When `quotaUsageEnabled` is `false`, the request is rejected with `ERR_FEATURE_DISABLED`. The ack carries `model`, `company`, `totals`, `lastUsed`, `agents` (per agent: kind and totals) and `perDay` (every day of the range in order, with `date`, `tokens` and `cost`, zero on days without use). An unknown model is answered with zero totals, not an error.

## 5. Server Events (`server -> client`)

### 5.1 Command Acknowledgment (`ack`)
```json
{ "type": "ack", "replyTo": "cli_7", "payload": { "status": "ok", "approved": true, "interactionId": "int_4ae721c8e2" } }
```
Command-specific fields sit next to `status`.

### 5.2 Command Error (`error`)
```json
{ "type": "error", "replyTo": "cli_7", "error": { "code": "ERR_INTERACTION_STALE", "message": "The prompt changed or was already answered." } }
```

### 5.3 Topology Snapshot (`snapshot_update`)
Broadcast to every client whenever the Herdr snapshot changes:
```json
{
  "type": "snapshot_update",
  "payload": {
    "workspaces": [
      {
        "id": "w1", "label": "Pigeon", "folder": "/home/user/Pigeon", "branch": "main", "tabCount": 1, "activeTabId": "w1:t1", "hasWarn": true, "hasWorking": false, "isFocused": true,
        "tabs": [
          { "id": "w1:t1", "label": "Claude Code", "branch": "feat/1-ui", "paneCount": 2, "panes": [
            { "id": "w1:p2", "agent": "claude", "agentStatus": "blocked", "isPrimary": true, "name": "claude", "program": "claude", "summary": "Do you want to proceed?", "summaryKind": "text" },
            { "id": "w1:p3", "agent": null, "agentStatus": "unknown", "isPrimary": false, "program": "zsh" }
          ] }
        ]
      }
    ],
    "workingAgents": [
      { "agent": "claude", "name": "claude", "status": "blocked", "workspaceId": "w1", "workspaceLabel": "Pigeon", "tabId": "w1:t1", "paneId": "w1:p2", "summary": "Do you want to proceed?", "summaryKind": "text" }
    ]
  }
}
```

- A tab's `label` is its Herdr name when the user gave it one. A Herdr name that is empty or only digits is a default, and the label is then the title of the session bound to the tab's primary pane (`agent-session-normalization.md` §2), else the recipe's label (user decision, 2026-11-07). A 'session title' means solely a title the agent itself assigned (Claude Code `custom-title`/`ai-title`, OpenCode non-placeholder title, AGY annotation title); a first prompt is never a live session title.
- `agentStatus` and `status` are the reported status: a pane the daemon marks seen is `idle` (`herdr-adapter.md` §4).

### 5.4 Pane State (`pane_state`)
Sent to the clients viewing a pane whenever its classified screen or status changes:
```json
{
  "type": "pane_state",
  "payload": {
    "paneId": "w1:p2",
    "workspaceId": "w1",
    "tabId": "w1:t1",
    "agentStatus": "blocked",
    "revision": 7,
    "cards": [ { "id": "card_tool_call_…", "kind": "tool_call", "title": "Bash", "command": "bun test", "status": "done", "output": "…" } ],
    "pendingInteraction": {
      "id": "card_interaction_…",
      "kind": "interaction",
      "interactionId": "int_4ae721c8e2",
      "title": "",
      "question": "Do you want to proceed?",
      "fingerprint": "fp_88a7b9c1d2e3",
      "options": [ { "id": "opt_1", "label": "Yes", "keyShortcut": "1" }, { "id": "opt_2", "label": "No", "keyShortcut": "2" } ],
      "fallbackKeys": ["enter", "esc", "up", "down"]
    },
    "rawScreen": "…"
  }
}
```
- `revision` increases per pane, and the client drops any `pane_state` whose revision is not newer than the last one it applied.
- `pendingInteraction.options` is empty when the prompt has no numbered options, or when Herdr reports `blocked` but no prompt was recognized. The client then shows `fallbackKeys` as a raw key pad.
- `exitCode` on a tool card is present only when the screen shows it.
- `pendingInteraction.title` is a title the screen showed for the prompt, else empty; `question` is empty when the screen showed no question line. The phone then shows its own label (`mobile-ui-and-themes.md` §10.2).

- `folder` is the Herdr workspace's folder. `branch` (workspace: of its folder; tab: of its first pane's folder) is the checked-out git branch, absent outside a git repository or on a detached HEAD.
- `program` is the name of the pane's foreground program, absent when the Core does not list the terminal. `summary` is the pane's one-line summary (also in `workingAgents`), and `summaryKind` says how to show it: `text` is shown as is (a prompt's question, the start of the last message, or the terminal title); `run` holds only the running command, which the phone prefixes with its own word for "running"; `thinking` holds the thought's title, or is empty when the agent shows none, and the phone shows its own word for "thinking" in that case. The daemon composes no UI text of its own (`mobile-ui-and-themes.md` §10.2).

### 5.5 Upstream Status (`upstream_status`)
```json
{ "type": "upstream_status", "payload": { "herdrConnected": true, "lastSyncTimestamp": 1729650000000 } }
```
This is sent in the handshake and broadcast whenever the daemon's connection to Herdr goes up or down.

### 5.6 Normalized Turns (`normalized_turns`, `turns_delta`)
`normalized_turns` carries the whole conversation of a pane's structured session (`agent-session-normalization.md`): `{ paneId, turns, sessionStats?, sessionTitle?, todos?, session }`.
```json
"session": { "bound": true, "agent": "claude", "sessionId": "2c9ad7c8-…", "model": { "value": "opus", "source": "launch" }, "thinking": { "value": "high", "source": "launch" } }
```
- `bound` says whether the pane has a structured session (`agent-session-normalization.md` §2.0).
- `model` and `thinking` name the current value and its source: `log` (the session records name it), else `launch` (Pigeon started the pane with it), else `unknown` (value absent). A later `agent_set_model` changes the shown value only once the session records confirm it.
- `todos` is the session's latest todo list (`agent-session-normalization.md` §3); absent when the session has none.

A pane that becomes bound or switches session (for example after the agent's `/clear`) gets a fresh `normalized_turns`.

`turns_delta` streams later changes to the viewing clients:
```json
{
  "type": "turns_delta",
  "payload": {
    "paneId": "w1:p2",
    "seqWatermark": 42,
    "sinceTurnIndex": 12,
    "appendTurns": [],
    "patchLastTurn": { "turnNumber": 12 },
    "sessionStats": { "filesModified": 3, "additions": 45, "deletions": 12 }
  }
}
```
`sinceTurnIndex: 0` without `patchLastTurn` replaces the whole list. Otherwise `patchLastTurn` replaces the last known turn, and `appendTurns` is placed from `sinceTurnIndex` on. `todos` and `session` ride along when they changed.

### 5.7 Skills and Agent Recipes (`skills_sync`)
```json
{
  "type": "skills_sync",
  "payload": {
    "paneId": "w1:p2",
    "skills": [
      { "name": "review", "description": "Review code", "source": "project", "kind": "skill", "invocation": "/review" },
      { "name": "compact", "description": "Compact the context", "descriptionId": "compact", "source": "builtin", "kind": "command", "invocation": "/compact" }
    ],
    "recipes": { "claude": { "kind": "claude", "label": "Claude Code", "models": [ { "id": "opus", "label": "Opus", "thinkingLevels": ["low", "medium", "high", "xhigh", "max"] } ], "interruptKeys": ["esc"] } }
  }
}
```
Skills are per pane: they depend on the pane's agent kind and project directory (`herdr-adapter.md` §8.3). `source` is `project`, `user`, `plugin` or `builtin`; `kind` is `skill` or `command`. A built-in command also carries `descriptionId` (`herdr-adapter.md` §8.3), and the phone shows its own text for that id, falling back to the English `description`. The client ignores skills for a pane it is no longer viewing. Choosing an entry inserts its `invocation` as prompt text.

Each recipe summary also carries `resumable` (the recipe can resume a session), `launchModel` (whether §4.5 can start the agent on a chosen model, `herdr-adapter.md` §5) and `runtimeSwitch: { model, thinking }` (whether §4.9 can change each value). A recipe's `models` is that agent's list in the model catalog (`herdr-adapter.md` §7.1), complete; the phone searches it.

### 5.8 Queue (`prompt_queue`)
```json
{ "type": "prompt_queue", "payload": { "paneId": "w1:p2", "items": [ { "queueId": "q_1a2b3c", "text": "also run lint", "attachments": [], "createdAt": 1729650000000, "sending": false } ] } }
```
The pane's whole queue, oldest first. Sent on pane selection (§3.3) and to the pane's viewers whenever its queue changes. An item's `text` and `attachments` are what the phone sent (its own text and upload ids), so a withdrawn prompt can go back into the composer (`mobile-ui-and-themes.md` §3.5); the prompt that reaches the agent is composed from them as in §4.2. `sending: true` indicates that the prompt has been dispatched to the terminal and is awaiting detection as a user turn in the agent session.

### 5.9 Recipes (`recipes_sync`)
```json
{ "type": "recipes_sync", "payload": { "recipes": { "codex": { "kind": "codex", "label": "Codex", "models": [ { "id": "gpt-5.5", "label": "GPT-5.5", "thinkingLevels": ["low", "medium", "high"] } ], "interruptKeys": ["esc"], "resumable": true, "runtimeSwitch": { "model": false, "thinking": false } } } } }
```
Every recipe summary, in the shape of §5.7. Broadcast to every client after a fill of the model catalog changed a list (`herdr-adapter.md` §7.1). It replaces the recipes the client had from `welcome` or `skills_sync`.

## 6. Configuration Synchronization Protocol

The client part of `config.json` (appearance) is shared by all paired devices.

### 6.1 Handshake Delivery
`welcome.payload.clientConfig` carries the current client config.

### 6.2 Request (`config_get` → `config_sync`)
```json
{ "type": "config_get", "id": "cli_20" }
```
```json
{ "type": "config_sync", "replyTo": "cli_20", "payload": { "version": 3, "client": { "themeMode": "system", "accent": "blue" } } }
```

### 6.3 Patch (`config_patch`)
```json
{ "type": "config_patch", "id": "cli_21", "payload": { "client": { "accent": "green" } } }
```
*Server Behavior*:
1. The patch is validated against a whitelist of keys and value types: `themeMode` (`system`, `light`, `dark`), `accent` (`blue`, `purple`, `green`, `orange`, `pink`), `quotaUsageEnabled` (boolean), `quotaProviders` (an object with any of `claude`, `codex`, `antigravity`, each a boolean), `quotaDisplay` (`remaining`, `used`), `quotaButton` (boolean), `quotaShowAccount` (boolean), `usageScanMode` (`scheduled`, `realtime`) and `usageScanInterval` (`1m`, `2m`, `5m`, `10m`, `15m`). Any unknown key or bad value rejects the whole patch with `ERR_INVALID_PAYLOAD`, and nothing is saved.
2. The patch is deep-merged and written to `config.json` before the reply. A write error is reported as `ERR_INTERNAL`.
3. Defaults are `themeMode: "system"`, `accent: "blue"`, `quotaUsageEnabled: true`, `quotaDisplay: "remaining"`, `quotaButton: true`, `quotaShowAccount: true`, `usageScanMode: "scheduled"` and `usageScanInterval: "5m"`; `quotaProviders` defaults to the providers logged in on this computer (`quota-and-usage.md` §2.5). The config version is bumped. The sender gets `ack` with `{ "version", "client" }`.
4. Every other client gets `{ "type": "config_updated", "payload": { "version", "client" } }`. Clients ignore a `config_sync` or `config_updated` whose version is older than one they have already applied.

## 7. Uploads (`POST /api/uploads`)

Attachments are uploaded before the prompt that uses them.
- **Gate**: a valid session cookie (else HTTP 401) and the same exact `Origin` and `Host` checks as the WebSocket upgrade (`security-and-pairing.md` §4, else HTTP 403).
- **Request**: the raw file bytes as the body, `Content-Type` the file's type, and `X-Pigeon-Filename` the URI-encoded original name (1–200 characters after decoding).
- **Validation** (trust boundary): a body over 20 MiB is HTTP 413; an empty body, a missing or bad file name is HTTP 400. The stored name keeps only `[A-Za-z0-9._-]` of the original (others become `_`, a leading dot is dropped).
- **Storage**: `<stateDir>/uploads/<id>-<name>`, mode `0600`, where `id` is `up_` + 16 random hex digits. Uploads older than 7 days are deleted when the daemon starts.
- **Reply**: `{ "id", "name", "size", "mime" }`. The phone then names `id` in `agent_prompt.attachments` (§4.2).

## 8. Error Code Registry

| Error Code | Meaning | Recovery Action |
| :--- | :--- | :--- |
| `ERR_INVALID_PAYLOAD` | Frame failed validation, unknown type, unknown option/model/key | Fix the request; nothing was executed |
| `ERR_FEATURE_DISABLED` | The requested quota or usage feature is disabled in client settings | Enable quota and usage in Settings |
| `ERR_NOT_FOUND` | Targeted pane, tab, workspace or device is unknown, or a queued prompt is no longer queued | Wait for the next `snapshot_update`, or refresh the list |
| `ERR_INTERACTION_STALE` | Prompt changed, was already answered, or is being answered | Re-select the pane for fresh state |
| `ERR_AGENT_NOT_READY` | Herdr: agent not ready for input | Retry once the agent is idle |
| `ERR_AGENT_BLOCKED` | Herdr: agent is waiting on a prompt | Answer the prompt first |
| `ERR_TIMEOUT` | Herdr request or prompt submission timed out | Check the pane before retrying; the action may have landed |
| `ERR_INCOMPATIBLE_PROTOCOL` | Protocol major version mismatch | Update the PWA (service worker update banner) |
| `ERR_INTERNAL` | Unexpected daemon error (logged with a stack trace) | Check daemon logs |
| `ERR_OFFLINE` | Client-side only: the socket was not open, so nothing was sent | The draft is kept; resend after reconnect |
