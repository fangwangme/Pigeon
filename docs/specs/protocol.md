# Wire Protocol Specification

## 1. Overview and Design Principles

The phone and the Pigeon daemon talk through **typed JSON messages over one WebSocket** (`/ws`). Pairing goes through `POST /api/pair` (`security-and-pairing.md`) and attachments through `POST /api/uploads` (§7). The TypeScript source of truth is `src/types/protocol.ts`. Runtime validation of every client frame lives in `src/server/ws-validate.ts`.

Key Protocol Principles:
1. **No guessed keys**: A prompt is answered with `interaction_respond`, which names an `interactionId`, a screen `fingerprint` and an `optionId`. The server sends exactly that option's key, and only while the same prompt is still on screen. Anything without a structured option goes through the raw key pad (`agent_send_keys`).
2. **State, not replay**: Each pane update carries the full classified state of the pane (`pane_state`) with a per-pane `revision`. A reconnecting client gets the current state, and nothing is replayed from a log offset.
3. **Application heartbeats**: `ping`/`pong` frames detect half-open mobile connections. `presence_update` frames drive push suppression.
4. **Desktop non-interference**: Choosing what the phone shows (`select_view`) never moves keyboard focus in the desktop Herdr session.
5. **Validate at the boundary**: Every client frame is validated before dispatch. A frame that fails validation, or has an unknown `type`, is answered with `ERR_INVALID_PAYLOAD`.
6. **Small frames**: the WebSocket negotiates per-message deflate, and pane data travels in the light form of `agent-session-normalization.md` §3.3; details are fetched on demand (§4.20).

## 2. Connection Lifecycle and Heartbeat

### 2.1 Heartbeat (`client <-> server`)
- The client sends `{ "type": "ping", "timestamp": 1729650000000 }` every 15 seconds. The server answers `{ "type": "pong", "timestamp": … }`.
- **Timeout**: If no `pong` has arrived for 30 seconds, the client closes the socket and reconnects.
- **Wakeup**: When `document.visibilityState` becomes `visible`, the client reconnects at once if the socket is not open. Otherwise it sends a `ping` at once and reconnects when no `pong` arrives within 3 seconds, so a connection that died while the phone slept is replaced without waiting for the 30-second timeout.
- With every heartbeat, and whenever visibility or the viewed pane changes, the client sends `{ "type": "presence_update", "isVisible": true, "viewingPaneId": "w1:p2" }`. This message has no `id` and gets no reply.

### 2.2 Refusals and Closure Codes
- A WebSocket upgrade without a valid session cookie is refused with HTTP **401**. A wrong `Host` or `Origin` is refused with HTTP **403** (`security-and-pairing.md` §4). In the browser, both show up as a plain close. Before reconnecting, the client checks `GET /api/auth/status` and shows the pairing guidance when it is not paired. When that check cannot reach the daemon (it is restarting, or the network is down), the client tries again 3 seconds later.
- After a close that is not final, the first reconnect attempt is immediate; later attempts wait 3 seconds each.
- `4403`: The device was revoked (`pigeon devices revoke`). The client shows the pairing guidance and does not reconnect.
- `4409`: Incompatible protocol major version. The client does not reconnect and shows that the app is out of date, with a reload button (`mobile-ui-and-themes.md` §8.3).
- The client also treats `4401` and `1008` as final.

## 3. Handshake and Initial Synchronization

### 3.1 Handshake Request (`client -> server`)
```json
{ "type": "hello", "id": "cli_1", "payload": { "protocolVersion": "1.0.0", "subscribePaneId": "w1:p2", "have": { "sessionId": "s_1", "turnCount": 5, "anchorHash": "a1b2c3d4" } } }
```
If the major version differs from the server's, the server answers `ERR_INCOMPATIBLE_PROTOCOL` and closes the socket with `4409`. `have` is optional: when the client holds turns for `subscribePaneId`, it supplies their `sessionId`, how many it holds (`turnCount`), and `anchorHash`, the FNV-1a 32-bit hash (lowercase hex) of `JSON.stringify(turn)` of the second-to-last turn it holds (index `turnCount - 2`, in the light form of `agent-session-normalization.md` §3.3), to request an incremental resume (§3.3). The last turn is not the anchor because it is the one that keeps changing while the agent works. `have` is validated with the other frame fields (`src/server/ws-validate.ts`).

### 3.2 Handshake Response (`server -> client`)
```json
{
  "type": "welcome",
  "replyTo": "cli_1",
  "payload": {
    "protocolVersion": "1.0.0",
    "serverVersion": "0.1.0",
    "buildId": "3f9a0c21d7e4",
    "environment": { "kind": "production", "port": 4100 },
    "deviceId": "6f1c…",
    "clientConfig": { "themeMode": "system", "accent": "blue" },
    "recipes": { "claude": { "kind": "claude", "label": "Claude Code", "models": [], "interruptKeys": ["esc"] } }
  }
}
```
Then come, in this order, `upstream_status` (§5.5) and `snapshot_update` (§5.3).

`serverVersion` is the `package.json` version and `environment` the instance kind and port (`architecture.md` §4.8). `buildId` identifies the client bundle the daemon serves (the first 12 hex digits of its SHA-256). The first `welcome` a page receives records it. When a later `welcome` (after a reconnect) carries a different `buildId`, the daemon was rebuilt and restarted: the page shows the update banner, and tapping it reloads the page (`architecture.md` §4.1).

### 3.3 Initial Pane Data (`pane_bootstrap`)
The server picks a pane. It uses `subscribePaneId` when Herdr knows that pane, otherwise Herdr's focused pane. It subscribes the connection to that pane and sends one message, which the client applies in one step:
```json
{ "type": "pane_bootstrap", "payload": { "paneId": "w1:p2", "turns": null, "resume": { "paneId": "w1:p2", "seq": 41, "sinceTurnIndex": 4, "appendTurns": [] }, "queue": [], "state": null, "serverMs": 9 } }
```
- **Turns**: when `have` is given, `have.turnCount ≥ 2`, the pane's bound session id equals `have.sessionId`, the pane has at least `turnCount` turns, and the hash of its turn `turnCount - 2` equals `have.anchorHash`, then `resume` is a `turns_delta` payload (§5.6) with `sinceTurnIndex: turnCount - 1`, the turns from that index on, and `sessionStats`, `sessionTitle`, `todos` and `session`; `turns` is null. Otherwise `turns` is the full `normalized_turns` payload (§5.6) and `resume` is null. A pane without a structured session gets `turns` with `turns: []` and `session.bound: false`, so the client never keeps the previous pane's conversation. Both carry the pane's current `seq`.
- **`queue`**: the pane's queued prompts (§5.8), empty when none.
- **`state`**: the pane's cached `pane_state` payload (§5.4) when the pane was read before, else null. A fresh screen read follows as `pane_state` only if it differs. The bootstrap never waits for a screen read.
- **`serverMs`**: how long the daemon took to build the message, so the client can time a switch.
- Skills are not part of the bootstrap: the client asks with `skills_get` (§4.7) when the user types `/` at line start or opens the skills sheet.

`select_view` (§4.4) sends the same bootstrap for another pane, then its `ack`.

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
A multi-select question menu recognized on screen (`herdr-adapter.md` §8.2, `multiSelect: true`) is answered with `optionIds`: its picked option ids; the server sends their digits, then `right`. An interaction with `allowsOther: true` also takes the user's own text for a question: the pick `opt_other` (on screen) or `q<k>_other` (transcript) stands for it, and `otherTexts` carries the text by question, `{ "1": "…" }` (1–2000 characters after trimming, only for questions with that pick); the keys follow `herdr-adapter.md` §7.2. A transcript interaction (§5.4) is answered once for all its questions, with `optionIds` in place of `optionId`: every picked option id (`q<k>_opt_<n>`), in question order; a single-select question has exactly one, a multi-select question at least one.
*Server Behavior*:
1. If the pane has no pending prompt, or its `interactionId` or `fingerprint` differs, or another answer for that pane is still being sent (a double tap), the server rejects with `ERR_INTERACTION_STALE` and sends no key. The client then re-selects the pane to get fresh state.
2. If `optionId` is not one of the prompt's options, or `optionIds` does not pick every question of a transcript interaction as above, or the agent has no checked keys (`herdr-adapter.md` §7.2), the server rejects with `ERR_INVALID_PAYLOAD`.
3. The server sends exactly the option's `keyShortcut` once through Herdr Core `terminal.keys`: for an interaction recognized on screen it is the option's digit (`herdr-adapter.md` §8); for a transcript interaction (§5.4) it is the key sequence the agent's question UI takes for all the picks (`herdr-adapter.md` §7.2). A failed send is never retried, because a timed-out send may already have landed.
4. After about 300 ms the server re-reads the screen. It acks `{ "approved": true, "interactionId": … }` when that prompt is gone, or `{ "approved": false, … }` when it is still showing. On `approved: false` the client keeps the card (`mobile-ui-and-themes.md` §4.1). A transcript interaction is acked `approved: true` once its keys are sent. From then on the pane no longer reports it, so every viewer's `pane_state` drops its card at once, whichever phone answered (user decision, 2026-11-13); the transcript recording the answer later changes nothing. If 10 seconds after the answer the transcript still holds the same question pending, the agent did not take the keys, and the pane reports it again.

### 4.2 Submit Prompt (`agent_prompt`)
When Herdr cannot be reached (its socket is missing or refuses the connection, `herdr-adapter.md` §2), this and every other command that writes to Herdr (§4.1, §4.3, §4.5, §4.6, §4.11, §4.22) is answered with `ERR_UPSTREAM_OFFLINE`; nothing reached Herdr. A prompt that is queued (below) makes no Herdr call and is queued as usual.
```json
{ "type": "agent_prompt", "id": "cli_8", "payload": { "targetPaneId": "w1:p2", "text": "Fix the unit tests in auth.test.ts", "attachments": ["up_3f9a0c21d7e4b5a6"] } }
```
- `text` may be empty only when `attachments` is not. `attachments` holds at most 10 upload ids from §7. An id the daemon does not know is `ERR_INVALID_PAYLOAD`, and nothing is sent.
- **Attachments**: the daemon appends attachment file paths: the file's absolute path, prefixed with the recipe's file-mention prefix (`@` for claude, opencode, and pi; none for codex, agy, and a plain terminal; agy uses space separation without `@` to prevent CLI autocomplete popups and multiline mode stalls).
- **Queue**: when the pane's Herdr status is `working`, or the pane already has queued prompts, the prompt is queued instead of sent (user decision, 2026-11-06). The ack carries `{ "queued": true, "queueId": "q_…" }`, and every viewer of the pane gets `prompt_queue` (§5.8).
- **Queue state machine**: each pane's queue is either `idle` (nothing out) or `sending` (a batch is out and not yet settled). One transition function takes every input: the pane's Herdr status (from a status event or from a snapshot, `herdr-adapter.md` §3.1), a new user turn in the pane's transcript (including the first turn of a fresh session), a send result, the send timeout, a queue edit, and the pane's removal.
  - In `idle`, when the pane's status is `idle` or `done` and the queue is not empty, **every** queued prompt goes out at once as one batch (user decision, 2026-11-13: the agent sees everything that piled up and decides itself): their composed prompts (§4.2) are joined in queue order with a blank line between them and sent as one prompt. Each is marked `sending: true`, and the queue enters `sending`. Prompts queued while a batch is out wait for the next batch.
  - The batch out **settles** when a new user turn appears, when the pane is seen `working` and later `idle` or `done`, when the send fails, or when the send timeout (30 seconds after the send) expires. On a pane without a bound session no transcript can confirm it, so it leaves the queue right after a successful send, and the queue still waits for it to settle before the next batch. A settled batch leaves the queue, the queue returns to `idle`, and when the pane is `idle` or `done` at that moment the next batch goes out at once — except after a settle by a new user turn before the pane was seen `working`: the agent has just received the batch and is about to work, and its `idle` is stale, so the next batch waits for the pane's next `idle` or `done` (user decision, 2026-11-13). This is what keeps a batch that never starts work (a slash command such as `/model`, a local command) from blocking the queue.
  - A batch that fails to send is dropped and reported to the viewers as `error` with its first `queueId` in `details`.
  - While a prompt is `sending`, `queue_update` and `queue_cancel` on it answer `ERR_NOT_FOUND`.
  - **Pause** (user decision, 2026-11-12): while the latest record of the pane's bound session is an agent error (`agent-session-normalization.md` §3, item `error`), the queue is paused. Nothing is sent, a new prompt is queued even when the pane is `idle` or `done`, and `prompt_queue` says `paused: true`. The queue resumes, and sends as in `idle`, on `queue_resume` (§4.22), when the pane turns `working`, or when the session records anything after the error. A pause is not persisted: after a restart it is derived again from the session.
  - `WsServer` takes the send timeout as the option `queueSendTimeoutMs` (default 30 000), so tests drive it with a short one.
- **Persistence**: the queue is written to `queue.json` in the instance's state directory (`architecture.md` §4.6) only when it changes, atomically (a temporary file, then rename). Each item records the terminal creation time (`created_ms`, `herdr-adapter.md` §3.1) of its pane at enqueue time. A prompt in `sending` is not written. A queue file that cannot be parsed stops startup with an error naming the file, and is left untouched. Closing the pane drops its queue.
- **Restore** (user decision, 2026-11-11): Herdr reuses terminal addresses, so a restored item is kept only when the first Herdr snapshot after start shows a terminal at its address with the same creation time. Kept items go out as soon as their pane is `idle` or `done`; the others are dropped and logged with their address and `queueId`.
- **Immediate send**: otherwise the server calls Herdr Core's `terminal.send`, which pastes the text and presses Enter, for agents and plain shells alike, and acks `{ "queued": false }`. Herdr's `blocked` surfaces as `ERR_AGENT_BLOCKED`, `unavailable` as `ERR_AGENT_NOT_READY`, and a timed-out request as `ERR_TIMEOUT` (`herdr-adapter.md` §6).
- Agent slash commands (`/compact`, a skill's invocation) are ordinary prompt text.

### 4.3 Dispatch Raw Keys (`agent_send_keys`)
```json
{ "type": "agent_send_keys", "id": "cli_9", "payload": { "targetPaneId": "w1:p2", "keys": ["ctrl+c"] } }
```
`keys` holds 1–16 Herdr key names. Each matches `^[a-z0-9+_-]{1,24}$` (case-insensitive). This command serves the terminal view's keys and the stop button (`mobile-ui-and-themes.md` §3.5, §5).

### 4.4 Switch Mobile View (`select_view`)
```json
{ "type": "select_view", "id": "cli_10", "payload": { "paneId": "w1:p4", "have": { "sessionId": "s_1", "turnCount": 5, "anchorHash": "a1b2c3d4" } } }
```
This moves the connection's subscription and sends the pane data from §3.3 (resumed incrementally when `have` matches, else full). Desktop focus is not touched. Herdr polls the union of the panes that connected clients are viewing.

`paneId: null` (Home, All Agents) unsubscribes: the connection views no pane, nothing is polled for it, and it gets no `pane_state` or `turns_delta` until it selects a pane again. The ack carries nothing else.

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

### 4.9 Removed: Change Model or Effort (`agent_set_model`)
Removed (user decision, 2026-11-12): a session's model and thinking level are chosen only when it is created (§4.5). `agent_set_model` is an unknown type and is answered with `ERR_INVALID_PAYLOAD`.

### 4.10 List Past Sessions (`sessions_list`)
```json
{ "type": "sessions_list", "id": "cli_15", "payload": { "workspaceId": "w1", "agentKind": "claude" } }
```
The ack carries `{ "sessions": [ { "id", "title", "updatedAt", "model" } ] }`, `model` being the model id the session last used (left out when its records name none; issue #21): the agent's own sessions whose project folder is the workspace's folder or below it, newest first, at most 50 (`agent-session-normalization.md` §2.6). `title` is the session's title, else its first user message (at most 120 characters). An agent kind without a session store answers with an empty list; an unknown workspace is `ERR_NOT_FOUND`.

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
Updates the text and attachments of an existing queued prompt in-place, preserving its exact queue index and order. Rebroadcasts `prompt_queue` to the viewers. `text` and `attachments` follow the rules of §4.2 (at most 10 known upload ids; `text` empty only when `attachments` is not), else `ERR_INVALID_PAYLOAD` and nothing changes. A `queueId` that is no longer queued or is currently in `sending` state responds with `ERR_NOT_FOUND`.

### 4.15 Refresh Model Lists (`models_refresh`)
```json
{ "type": "models_refresh", "id": "cli_19", "payload": { "agent": "claude" } }
```
`agent`, if given, must be a known recipe; the daemon then fills only that agent's list, else every agent's list (`herdr-adapter.md` §7.1). A refresh asked from the phone always reads the source, the Claude Models API included, whatever the daily limit of an automatic fill. The ack comes once the fill has finished and carries `{ "recipes": { … } }` in the shape of §5.7; every connected client also gets `recipes_sync` (§5.9) when a list changed.

### 4.16 Quota (`quota_get`)
```json
{ "type": "quota_get", "id": "cli_20", "payload": {} }
```
Answers with the quota of every provider (`quota-and-usage.md` §2). Answers from the daemon's 60-second provider cache to protect upstream provider rate limits. When `quotaUsageEnabled` is `false` (`quota-and-usage.md` §1.1), the request is rejected with `ERR_FEATURE_DISABLED` without querying any provider. The ack carries:
```json
{ "providers": [ { "provider": "claude", "enabled": true,
    "snapshot": { "provider": "claude", "plan": "pro", "account": "you@example.com", "fetchedAt": 1794218000000, "credits": [],
      "windows": [ { "id": "five_hour", "label": "5h", "usedPercent": 52, "periodMs": 18000000, "resetsAt": 1794228620000 } ] },
    "error": null } ], "fetchedAt": 1794218000000 }
```
One entry per provider, enabled or not; a disabled provider has `snapshot: null` and is not fetched. The top-level `fetchedAt` carries the timestamp when the daemon last fetched or checked the providers. A provider that failed has `error: { "message", "at" }` and keeps its previous `snapshot` (or null when it never had one). Provider failures never turn into a command error.

### 4.17 Usage Report (`usage_get`)
```json
{ "type": "usage_get", "id": "cli_21", "payload": { "preset": "custom", "from": "2026-10-01", "to": "2026-10-31", "agents": ["claude", "codex", "agy", "opencode", "pi"] } }
```
`preset` is `today`, `7d`, `30d`, `year`, `all` or `custom`; `custom` requires `from` and `to` (`YYYY-MM-DD`), which other presets must not carry. An optional boolean `force` (the refresh button) rescans newly modified session files before answering in realtime mode (`quota-and-usage.md` §3.7); in scheduled mode, requests always answer from the background cache (user decision, 2026-11-11). `agents` is a non-empty list of distinct agent kinds and filters every figure in the reply. Anything else is `ERR_INVALID_PAYLOAD` and nothing is scanned. When `quotaUsageEnabled` is `false` (`quota-and-usage.md` §1.1), the request is rejected with `ERR_FEATURE_DISABLED` without scanning files or querying prices. The ack carries:
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

### 4.20 Detail (`detail_get`)
```json
{ "type": "detail_get", "id": "cli_24", "payload": { "paneId": "w1:p2", "kind": "tool", "turnId": "t_12", "callId": "toolu_01" } }
```
Fetches what the light form (`agent-session-normalization.md` §3.3) leaves out, from the pane's bound session:
- `kind: "tool"` with `turnId` and `callId` → the ack carries `{ "call" }`, the full `NormalizedToolCall` (input, output, diff with patch).
- `kind: "reasoning"` with `turnId` → `{ "text" }`, the turn's reasoning text.
- `kind: "file"` with `filePath` → `{ "diff" }`, that file's `FileDiffSummary` from `sessionStats` with its accumulated `patch`.
A pane without a bound session, or a turn, call or file the session does not have, is `ERR_NOT_FOUND`. The phone keeps details in memory only.

### 4.21 Screen Watch (`screen_watch`)
```json
{ "type": "screen_watch", "id": "cli_25", "payload": { "paneId": "w1:p2", "on": true } }
```
The terminal view (`mobile-ui-and-themes.md` §5) turns this on while it is open. While on, this connection's `pane_state` for that pane carries `cards` and `rawScreen` even when the pane has a bound session (§5.4). Selecting another pane turns it off.

### 4.22 Resume a Paused Queue (`queue_resume`)
```json
{ "type": "queue_resume", "id": "cli_30", "payload": { "paneId": "w1:p2" } }
```
Releases the pane's paused queue (§4.2): its oldest prompt goes out as in `idle`. A pane the daemon does not know is `ERR_NOT_FOUND`; a queue that is not paused is acked with no effect.

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
            { "id": "w1:p2", "agent": "claude", "agentStatus": "blocked", "isPrimary": true, "name": "claude", "program": "claude", "model": "opus", "summary": "Do you want to proceed?", "summaryKind": "text" },
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
- `model` is the pane's current model as `session.model.value` of §5.6 gives it, absent when the pane has no agent session or its source is `unknown`. A change of model is a snapshot change.
- The daemon broadcasts `snapshot_update` only when the payload differs from the last one it sent.

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
- For a pane with a bound session, `cards` is empty and `rawScreen` absent unless this connection watches the screen (§4.21): the conversation comes from the transcript. `agentStatus` and `pendingInteraction` are always sent.
- `pendingInteraction.options` is empty when the prompt has no numbered options, or when Herdr reports `blocked` but no prompt was recognized. The client then shows `fallbackKeys` as a raw key pad.
- `exitCode` on a tool card is present only when the screen shows it.
- `pendingInteraction.title` is a title the screen showed for the prompt, else empty; `question` is empty when the screen showed no question line. The phone then shows its own label (`mobile-ui-and-themes.md` §10.2).
- `pendingInteraction.source` is `screen` or `transcript`. When the pane's bound session has a pending question and the agent's question keys are checked (`herdr-adapter.md` §7.2), the interaction comes from the transcript whatever the screen shows, so the question is answered in the card (`mobile-ui-and-themes.md` §4.2). Otherwise a prompt recognized on screen (`herdr-adapter.md` §8.2), or Herdr's `blocked` with nothing recognized, is `screen`. When no prompt is recognized on screen and the pane's bound session has a pending question or plan (`agent-session-normalization.md` §3 `pendingQuestion`, `pendingPlan`), the interaction comes from the transcript and the pane's `agentStatus` is `blocked`, whatever Herdr reports. A transcript interaction's `question` is the first question's text (empty for a plan) and its `options` are every question's options, with ids `q<k>_opt_<n>` (question `k` and option `n`, counted from 1) and the `label` the transcript gives; their `keyShortcut` follows `herdr-adapter.md` §7.2 and is empty for an agent without checked keys. A plan's interaction has no options. `interactionId` is a hash of the tool call id. A question menu recognized on screen carries `multiSelect` and each option's `description` (`herdr-adapter.md` §8.2). `allowsOther: true` marks an interaction whose questions also take the user's own text: a screen menu with a `Type something` entry, or a transcript interaction whose agent has checked keys for it (`herdr-adapter.md` §7.2).

- `folder` is the Herdr workspace's folder. `branch` (workspace: of its folder; tab: of its first pane's folder) is the checked-out git branch, absent outside a git repository or on a detached HEAD.
- `program` is the name of the pane's foreground program, absent when the Core does not list the terminal. `summary` is the pane's one-line summary (also in `workingAgents`), and `summaryKind` says how to show it: `text` is shown as is (a prompt's question, the start of the last message, or the terminal title); `run` holds only the running command, which the phone prefixes with its own word for "running"; `thinking` holds the thought's title, or is empty when the agent shows none, and the phone shows its own word for "thinking" in that case. The daemon composes no UI text of its own (`mobile-ui-and-themes.md` §10.2).

### 5.5 Upstream Status (`upstream_status`)
```json
{ "type": "upstream_status", "payload": { "herdrConnected": true, "lastSyncTimestamp": 1729650000000 } }
```
This is sent in the handshake and broadcast whenever the daemon's connection to Herdr goes up or down.

### 5.6 Normalized Turns (`normalized_turns`, `turns_delta`)
`normalized_turns` carries the whole conversation of a pane's structured session (`agent-session-normalization.md`): `{ paneId, seq, turns, sessionStats?, sessionTitle?, todos?, session }`. Turns and `sessionStats` are in the light form (`agent-session-normalization.md` §3.3).
```json
"session": { "bound": true, "agent": "claude", "sessionId": "2c9ad7c8-…", "model": { "value": "opus", "source": "launch" }, "thinking": { "value": "high", "source": "launch" } }
```
- `bound` says whether the pane has a structured session (`agent-session-normalization.md` §2.0).
- `model` and `thinking` name the current value and its source: `log` (the session records name it), else `launch` (Pigeon started the pane with it), else `unknown` (value absent).
- `todos` is the session's latest todo list (`agent-session-normalization.md` §3); absent when the session has none.

A pane that becomes bound or switches session (for example after the agent's `/clear`) gets a fresh `normalized_turns`.

`turns_delta` streams later changes to the viewing clients:
```json
{
  "type": "turns_delta",
  "payload": {
    "paneId": "w1:p2",
    "seq": 42,
    "sinceTurnIndex": 12,
    "appendTurns": [],
    "patchLastTurn": { "turnNumber": 12 },
    "sessionStats": { "filesModified": 3, "additions": 45, "deletions": 12 }
  }
}
```
`sinceTurnIndex: 0` without `patchLastTurn` replaces the whole list. Otherwise `patchLastTurn` replaces the last known turn, and `appendTurns` is placed from `sinceTurnIndex` on. `sessionStats`, `todos` and `session` ride along only when they changed.

`seq` counts the pane's turn changes: each `turns_delta` carries the previous value plus one, and `normalized_turns` and the bootstrap carry the current value. A client that receives a `turns_delta` whose `seq` is not one more than the last it applied for that pane discards it and selects the pane again with its `have` (§4.4).

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

Each recipe summary also carries `resumable` (the recipe can resume a session) and `launchModel` (whether §4.5 can start the agent on a chosen model, `herdr-adapter.md` §5). A recipe without `launchModel` may carry `lastUsed: { "model": "<id>", "thinking"?: "<level>" }`, the model and effort the agent will start on (`herdr-adapter.md` §5; today OpenCode). A recipe's `models` is that agent's list in the model catalog (`herdr-adapter.md` §7.1), complete; the phone searches it.

### 5.8 Queue (`prompt_queue`)
```json
{ "type": "prompt_queue", "payload": { "paneId": "w1:p2", "paused": false, "items": [ { "queueId": "q_1a2b3c", "text": "also run lint", "attachments": [], "createdAt": 1729650000000, "sending": false } ] } }
```
The pane's whole queue, oldest first, and whether it is paused (§4.2). Sent on pane selection (§3.3) and to the pane's viewers whenever its queue changes. An item's `text` and `attachments` are what the phone sent (its own text and upload ids), so a withdrawn prompt can go back into the composer (`mobile-ui-and-themes.md` §3.5); the prompt that reaches the agent is composed from them as in §4.2. `sending: true` indicates that the prompt has been dispatched to the terminal and is awaiting detection as a user turn in the agent session.

### 5.9 Recipes (`recipes_sync`)
```json
{ "type": "recipes_sync", "payload": { "recipes": { "codex": { "kind": "codex", "label": "Codex", "models": [ { "id": "gpt-5.5", "label": "GPT-5.5", "thinkingLevels": ["low", "medium", "high"] } ], "interruptKeys": ["esc"], "resumable": true, "launchModel": true } } } }
```
Every recipe summary, in the shape of §5.7. Broadcast to every client after a fill of the model catalog changed a list (`herdr-adapter.md` §7.1). It replaces the recipes the client had from `welcome` or `skills_sync`.

### 5.10 Pane Tail (`pane_tail`)
```json
{ "type": "pane_tail", "payload": { "paneId": "w1:p2", "agentStatus": "working", "seq": 42, "sessionId": "2c9ad7c8-…", "turns": [] } }
```
Prefetch for fast switching (user decision, 2026-11-10: only for agents that are working or waiting). For every pane whose status is `working` or `blocked` and that has a bound session, the daemon pushes to every connection that is not viewing that pane the last turns of its session in the light form, as many as fit in 32 KB counted from the newest, with the pane's current `seq`. At most one `pane_tail` per pane per second, and one more when the pane leaves `working` or `blocked`. The client stores them in its in-memory pane views (`mobile-ui-and-themes.md` §3.1); a later bootstrap of that pane resumes from them.

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
3. Defaults are `themeMode: "system"`, `accent: "blue"`, `quotaUsageEnabled: true`, `quotaDisplay: "remaining"`, `quotaButton: true`, `quotaShowAccount: true`, `usageScanMode: "scheduled"` and `usageScanInterval: "15m"`; `quotaProviders` defaults to the providers logged in on this computer (`quota-and-usage.md` §2.5). The config version is bumped. The sender gets `ack` with `{ "version", "client" }`.
4. Every other client gets `{ "type": "config_updated", "payload": { "version", "client" } }`. Clients ignore a `config_sync` or `config_updated` whose version is older than one they have already applied.

## 7. Uploads (`POST /api/uploads`)

Attachments are uploaded before the prompt that uses them.
- **Gate**: a valid session cookie (else HTTP 401) and the same exact `Origin` and `Host` checks as the WebSocket upgrade (`security-and-pairing.md` §4, else HTTP 403).
- **Request**: the raw file bytes as the body, `Content-Type` the file's type, and `X-Pigeon-Filename` the URI-encoded original name (1–200 characters after decoding).
- **Validation** (trust boundary): a body over 20 MiB is HTTP 413; an empty body, a missing or bad file name is HTTP 400. The stored name keeps only `[A-Za-z0-9._-]` of the original (others become `_`, a leading dot is dropped).
- **Storage**: `<stateDir>/uploads/<id>-<name>`, mode `0600`, where `id` is `up_` + 16 random hex digits. Uploads older than 7 days are deleted when the daemon starts.
- **Reply**: `{ "id", "name", "size", "mime" }`. The phone then names `id` in `agent_prompt.attachments` (§4.2).
- **Retrieval (`GET /api/uploads/:id`)**: returns the uploaded file bytes with its stored `Content-Type`, so the phone can show thumbnails and images in the transcript. Gate: a valid session cookie (else HTTP 401) and an allowed `Host` (else HTTP 403). `Origin` may be absent, because a browser sends none for an `<img>` load or a link; when present it must pass the exact Origin check (`security-and-pairing.md` §4, else HTTP 403). The session cookie is `SameSite=Strict`, so a request from another site carries no cookie.

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
| `ERR_UPSTREAM_OFFLINE` | Herdr App or Core cannot be reached; nothing was sent | Wait until `upstream_status` reports Herdr connected |
| `ERR_INTERNAL` | Unexpected daemon error (logged with a stack trace) | Check daemon logs |
| `ERR_OFFLINE` | Client-side only: the socket was not open, so nothing was sent | The draft is kept; resend after reconnect |
