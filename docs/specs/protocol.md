# Wire Protocol Specification

## 1. Overview and Design Principles

The phone and the Pigeon daemon talk through **typed JSON messages over one WebSocket** (`/ws`). Pairing goes through one HTTP endpoint (`POST /api/pair`, see `security-and-pairing.md`). The TypeScript source of truth is `src/types/protocol.ts`. Runtime validation of every client frame lives in `src/server/ws-validate.ts`.

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
- A WebSocket upgrade without a valid session cookie is refused with HTTP **401**. A wrong `Host` or `Origin` is refused with HTTP **403** (`security-and-pairing.md` §4). In the browser, both show up as a plain close. Before reconnecting, the client checks `GET /api/auth/status` and shows the pairing guidance when it is not paired.
- `4403`: The device was revoked (`pigeon devices revoke`). The client shows the pairing guidance and does not reconnect.
- `4409`: Incompatible protocol major version. The client does not reconnect.
- The client also treats `4401` and `1008` as final.

## 3. Handshake and Initial Synchronization

### 3.1 Handshake Request (`client -> server`)
```json
{ "type": "hello", "id": "cli_1", "payload": { "protocolVersion": "1.0.0", "subscribePaneId": "w1:p2" } }
```
If the major version differs from the server's, the server answers `ERR_INCOMPATIBLE_PROTOCOL` and closes the socket with `4409`.

### 3.2 Handshake Response (`server -> client`)
```json
{
  "type": "welcome",
  "replyTo": "cli_1",
  "payload": {
    "protocolVersion": "1.0.0",
    "serverVersion": "0.1.0",
    "deviceId": "6f1c…",
    "clientConfig": { "themeKey": "gruvbox", "themeMode": "system", "macros": [] },
    "recipes": { "claude": { "kind": "claude", "label": "Claude Code", "models": [], "interruptKeys": ["esc"] } }
  }
}
```
Then come, in this order, `upstream_status` (§5.7) and `snapshot_update` (§5.3).

### 3.3 Initial Pane Data (`server -> client`)
The server picks a pane. It uses `subscribePaneId` when Herdr knows that pane, otherwise Herdr's focused pane. It subscribes the connection to that pane and sends:
1. `normalized_turns` (§5.6). This is always sent, with `turns: []` for panes without a structured session, so the client never keeps the previous pane's conversation.
2. `skills_sync` (§5.8) for that pane's agent and project directory.
3. `pane_state` (§5.4): the cached state at once if the pane was read before, then a fresh screen read. The fresh read reaches the client as another `pane_state` only if the screen changed.

`select_view` (§4.4) runs the same three steps for a different pane.

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
1. If the pane has no pending prompt, or its `interactionId` or `fingerprint` differs, the server rejects with `ERR_INTERACTION_STALE` and sends no key. The client then re-selects the pane to get fresh state.
2. If `optionId` is not one of the prompt's options, the server rejects with `ERR_INVALID_PAYLOAD`.
3. The server sends exactly the option's `keyShortcut`, which is its digit (`herdr-adapter.md` §8), once through `pane.send_keys`. A failed send is never retried, because a timed-out send may already have landed.
4. After about 300 ms the server re-reads the screen. It acks `{ "approved": true, "interactionId": … }` when that prompt is gone, or `{ "approved": false, … }` when it is still showing. On `approved: false` the client opens the raw terminal sheet.

### 4.2 Submit Prompt (`agent_prompt`)
```json
{ "type": "agent_prompt", "id": "cli_8", "payload": { "targetPaneId": "w1:p2", "text": "Fix the unit tests in auth.test.ts" } }
```
*Server Behavior*: For a pane with a detected agent, the server calls Herdr's `agent.prompt`, which handles bracketed paste and submission. For a plain shell pane, it sends the text followed by Enter. Herdr's `agent_blocked` surfaces as `ERR_AGENT_BLOCKED`, `agent_not_ready` as `ERR_AGENT_NOT_READY`, and `agent_prompt_stalled` as `ERR_TIMEOUT`. Agent slash commands (`/model`, `/compact`, a skill's invocation) are ordinary prompt text.

### 4.3 Dispatch Raw Keys (`agent_send_keys`)
```json
{ "type": "agent_send_keys", "id": "cli_9", "payload": { "targetPaneId": "w1:p2", "keys": ["ctrl+c"] } }
```
`keys` holds 1–16 Herdr key names. Each matches `^[a-z0-9+_-]{1,24}$` (case-insensitive). This command serves the raw key pad, the interrupt button and key macros.

### 4.4 Switch Mobile View (`select_view`)
```json
{ "type": "select_view", "id": "cli_10", "payload": { "paneId": "w1:p4" } }
```
This moves the connection's subscription and sends the pane data from §3.3. Desktop focus is not touched. Herdr polls the union of the panes that connected clients are viewing.

### 4.5 Create Tab and Launch Agent (`create_tab_and_agent`)
```json
{
  "type": "create_tab_and_agent",
  "id": "cli_11",
  "payload": { "workspaceId": "w1", "agentKind": "claude", "modelId": "opus", "thinking": "high", "cwd": "/home/user/project" }
}
```
*Server Behavior*: The server checks the request against the recipe:
- `agentKind` must be a known recipe.
- `modelId`, if given, must be one of the recipe's models.
- `thinking`, if given, must be one of that model's levels.
- `cwd`, if given, must be absolute.

Any violation gets `ERR_INVALID_PAYLOAD` before anything is created. The launch sequence is in `herdr-adapter.md` §5. The ack carries `{ "workspaceId", "tabId", "paneId" }`, and the client switches to the new pane.

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
        "id": "w1", "label": "Pigeon", "tabCount": 1, "activeTabId": "w1:t1", "hasWarn": true, "hasWorking": false, "isFocused": true,
        "tabs": [
          { "id": "w1:t1", "label": "Claude Code", "paneCount": 2, "panes": [
            { "id": "w1:p2", "agent": "claude", "agentStatus": "blocked", "isPrimary": true, "name": "claude" },
            { "id": "w1:p3", "agent": null, "agentStatus": "unknown", "isPrimary": false }
          ] }
        ]
      }
    ],
    "workingAgents": [
      { "agent": "claude", "name": "claude", "status": "blocked", "workspaceId": "w1", "workspaceLabel": "Pigeon", "tabId": "w1:t1", "paneId": "w1:p2", "summary": "Do you want to proceed?" }
    ]
  }
}
```

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
      "title": "需要授权",
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

### 5.5 Upstream Status (`upstream_status`)
```json
{ "type": "upstream_status", "payload": { "herdrConnected": true, "lastSyncTimestamp": 1729650000000 } }
```
This is sent in the handshake and broadcast whenever the daemon's connection to Herdr goes up or down.

### 5.6 Normalized Turns (`normalized_turns`, `turns_delta`)
`normalized_turns` carries the whole conversation of a pane's structured session (`agent-session-normalization.md`): `{ paneId, turns, sessionStats?, sessionTitle? }`.

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
`sinceTurnIndex: 0` without `patchLastTurn` replaces the whole list. Otherwise `patchLastTurn` replaces the last known turn, and `appendTurns` is placed from `sinceTurnIndex` on.

### 5.7 Skills and Agent Recipes (`skills_sync`)
```json
{
  "type": "skills_sync",
  "payload": {
    "paneId": "w1:p2",
    "skills": [ { "name": "review", "description": "Review code", "source": "project", "invocation": "/review" } ],
    "recipes": { "claude": { "kind": "claude", "label": "Claude Code", "models": [ { "id": "opus", "label": "Opus", "thinkingLevels": ["low", "medium", "high", "xhigh", "max"] } ], "interruptKeys": ["esc"] } }
  }
}
```
Skills are per pane: they depend on the pane's agent kind and project directory (`herdr-adapter.md` §8.3). The client ignores skills for a pane it is no longer viewing. Typing `/` in the composer completes skills by inserting their `invocation`.

## 6. Configuration Synchronization Protocol

The client part of `config.json` (theme, macros, display options) is shared by all paired devices.

### 6.1 Handshake Delivery
`welcome.payload.clientConfig` carries the current client config.

### 6.2 Request (`config_get` → `config_sync`)
```json
{ "type": "config_get", "id": "cli_20" }
```
```json
{ "type": "config_sync", "replyTo": "cli_20", "payload": { "version": 3, "client": { "themeKey": "gruvbox", "macros": [] } } }
```

### 6.3 Patch (`config_patch`)
```json
{ "type": "config_patch", "id": "cli_21", "payload": { "client": { "themeKey": "nord" } } }
```
*Server Behavior*:
1. The patch is validated against a whitelist of keys and value types. Key macros must name a valid key (§4.3). Any unknown key or bad value rejects the whole patch with `ERR_INVALID_PAYLOAD`, and nothing is saved.
2. The patch is deep-merged and written to `config.json` before the reply. A write error is reported as `ERR_INTERNAL`.
3. The config version is bumped. The sender gets `ack` with `{ "version", "client" }`.
4. Every other client gets `{ "type": "config_updated", "payload": { "version", "client" } }`. Clients ignore a `config_sync` or `config_updated` whose version is older than one they have already applied.

## 7. Error Code Registry

| Error Code | Meaning | Recovery Action |
| :--- | :--- | :--- |
| `ERR_INVALID_PAYLOAD` | Frame failed validation, unknown type, unknown option/model/key | Fix the request; nothing was executed |
| `ERR_NOT_FOUND` | Targeted pane is not in the Herdr snapshot | Wait for the next `snapshot_update` |
| `ERR_INTERACTION_STALE` | Prompt changed or was already answered | Re-select the pane for fresh state |
| `ERR_AGENT_NOT_READY` | Herdr: agent not ready for input | Retry once the agent is idle |
| `ERR_AGENT_BLOCKED` | Herdr: agent is waiting on a prompt | Answer the prompt first |
| `ERR_TIMEOUT` | Herdr request or prompt submission timed out | Check the pane before retrying; the action may have landed |
| `ERR_INCOMPATIBLE_PROTOCOL` | Protocol major version mismatch | Update the PWA (service worker update banner) |
| `ERR_INTERNAL` | Unexpected daemon error (logged with a stack trace) | Check daemon logs |
| `ERR_OFFLINE` | Client-side only: the socket was not open, so nothing was sent | The draft is kept; resend after reconnect |
