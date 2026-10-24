# Wire Protocol Specification

## 1. Overview and Design Principles

The communication between the mobile client and the Pigeon bridge daemon is conducted via a **Typed JSON Message Protocol over WebSocket** (`/ws`), supported by initial HTTP authentication endpoints (`/api/pair`).

Key Protocol Principles:
1. **Zero Raw Key Misfires**: Interactive prompts and approvals are answered via discrete `interaction_respond` commands referencing an explicit `interactionId` and verified screen fingerprint, preventing stale keys from acting on subsequent commands.
2. **Deterministic Reconnection**: Handshake immediately pushes the complete state (`pane_state`) of the subscribed pane, eliminating fragile log offset replays.
3. **Application Heartbeats**: Regular `ping`/`pong` frames prevent silent mobile connection drops and ensure accurate push notification suppression.
4. **Desktop Non-Interference**: Mobile navigation and view switching use `select_view` and do **not** steal keyboard focus on the desktop Herdr session.

## 2. Connection Lifecycle and Heartbeat

### 2.1 Heartbeat (`client <-> server`)
Mobile operating systems aggressively suspend background network sockets.
- The client dispatches a `ping` message every 15 seconds:
  ```json
  { "type": "ping", "timestamp": 1729650000000 }
  ```
- The server responds immediately with `pong`:
  ```json
  { "type": "pong", "timestamp": 1729650000000 }
  ```
- **Timeout**: If the client misses 2 consecutive `pong` responses (30 seconds), the connection is terminated and re-established.
- **Wakeup**: When `document.visibilityState` changes to `visible`, if the elapsed time since the last `pong` exceeds 15 seconds, the client initiates an immediate reconnect.

### 2.2 WebSocket Closure Codes
The server uses standardized closure codes to communicate authorization and protocol status:
- `4401`: Unauthorized (missing or invalid session cookie). The client must redirect to the pairing screen.
- `4403`: Forbidden (Origin or Host validation failed).
- `4409`: Incompatible Protocol Version. The client triggers a hard reload to bust Service Worker cache.

## 3. Handshake and Initial Synchronization

### 3.1 Handshake Request (`client -> server`)
```json
{
  "type": "hello",
  "id": "msg_001",
  "payload": {
    "protocolVersion": "1.0.0",
    "subscribePaneId": "w1:p2"
  }
}
```

### 3.2 Handshake Response (`server -> client`)
```json
{
  "type": "welcome",
  "replyTo": "msg_001",
  "payload": {
    "protocolVersion": "1.0.0",
    "serverVersion": "0.1.0",
    "deviceId": "dev_9f8a3b12",
    "preferences": {
      "themeId": "pigeon",
      "mode": "dark",
      "locale": "zh-CN",
      "macrosVersion": 1
    }
  }
}
```

### 3.3 Initial Pane State (`server -> client`)
Immediately following `welcome`, the server transmits the complete initial state for the requested pane:
```json
{
  "type": "pane_state",
  "payload": {
    "paneId": "w1:p2",
    "workspaceId": "w1",
    "tabId": "w1:t1",
    "agentStatus": "idle",
    "cards": [
      {
        "id": "card_auth_01",
        "kind": "tool_call",
        "title": "Bash",
        "command": "bun test auth.test.ts",
        "status": "done",
        "exitCode": 0,
        "output": "✓ 2 tests pass"
      }
    ],
    "pendingInteraction": null,
    "activeGhost": null,
    "rawScreen": "$ bun test auth.test.ts\n✓ 2 tests pass\n"
  }
}
```

## 4. Client Commands (`client -> server`)

Every client command contains a unique `id` for tracking and deduplication. The server enforces a 60-second idempotency deduplication window.

### 4.1 Answer Interactive Prompt (`interaction_respond`)
Submits a user response to a pending authorization or multiple-choice interaction.
```json
{
  "type": "interaction_respond",
  "id": "cmd_101",
  "payload": {
    "targetPaneId": "w1:p2",
    "interactionId": "int_789",
    "optionId": "opt_0"
  }
}
```
*Server Behavior*:
1. Verifies that `interactionId` matches the pane's active interaction and that the screen fingerprint has not changed.
2. If stale or mismatched, rejects with `ERR_INTERACTION_STALE`.
3. Dispatches the option's key sequence to Herdr (`enter`, `1\n`, etc.).
4. Re-reads the screen buffer to verify the prompt is dismissed. If verification fails, downgrades to raw terminal view with fallback keys.

### 4.2 Submit Prompt (`agent_prompt`)
Sends user prompt text (from keyboard or speech-to-text) to the targeted pane.
```json
{
  "type": "agent_prompt",
  "id": "cmd_102",
  "payload": {
    "targetPaneId": "w1:p2",
    "text": "Fix the unit tests in auth.test.ts"
  }
}
```
*Server Behavior*: Invokes Herdr's `agent.prompt` with bracketed paste enabled. If the agent is currently `blocked`, Herdr rejects with `agent_blocked` which surfaces as `ERR_AGENT_BLOCKED`.

### 4.3 Dispatch Raw Keys (`agent_send_keys`)
Dispatches raw physical keys. Used exclusively for navigation fallback buttons and macro dock commands.
```json
{
  "type": "agent_send_keys",
  "id": "cmd_103",
  "payload": {
    "targetPaneId": "w1:p2",
    "keys": ["ctrl+c"]
  }
}
```

### 4.4 Switch Mobile View (`select_view`)
Switches the mobile view to a different pane. **Does not steal or alter desktop Herdr focus.**
```json
{
  "type": "select_view",
  "id": "cmd_104",
  "payload": {
    "paneId": "w1:p4"
  }
}
```

### 4.5 Execute Predicted Command (`ghost_execute`)
Accepts and executes an agent's ghost text command suggestion.
```json
{
  "type": "ghost_execute",
  "id": "cmd_105",
  "payload": {
    "targetPaneId": "w1:p2",
    "suggestionId": "gh_456",
    "paneRevision": 18
  }
}
```
*Server Behavior*: Verifies that `paneRevision` matches current screen revision. If the screen has changed since the suggestion was offered, rejects with `ERR_INTERACTION_STALE`.

### 4.6 Open Agent Native Menu (`open_agent_menu`)
Triggers an agent's built-in interactive menu (e.g. `/model`). Permitted only when status is `idle` or `done`.
```json
{
  "type": "open_agent_menu",
  "id": "cmd_106",
  "payload": {
    "targetPaneId": "w1:p2",
    "menu": "model"
  }
}
```

### 4.7 Create Tab and Launch Agent (`create_tab_and_agent`)
Creates a new Tab and launches the requested Agent with secure server-assembled model and thinking CLI parameters:
```json
{
  "type": "create_tab_and_agent",
  "id": "cmd_107",
  "payload": {
    "workspaceId": "w1",
    "agentKind": "claude",
    "modelId": "claude-3-7-sonnet",
    "thinking": "medium",
    "cwd": "/home/user/project"
  }
}
```

### 4.8 Close Tab with Session Teardown (`close_tab`)
Closes the targeted Tab, terminates its running agent processes, and triggers a fresh snapshot update:
```json
{
  "type": "close_tab",
  "id": "cmd_108",
  "payload": {
    "tabId": "w1:t1"
  }
}
```

### 4.9 Query Available Skills (`skills_get`)
Explicitly requests an up-to-date listing of installed and project skills:
```json
{
  "type": "skills_get",
  "id": "cmd_109"
}
```

### 4.10 Preferences Synchronization (`preferences_set`)
```json
{
  "type": "preferences_set",
  "id": "cmd_108",
  "payload": {
    "themeId": "github",
    "mode": "dark",
    "locale": "en",
    "macrosVersion": 2,
    "macros": [
      { "id": "m1", "label": "Tab", "type": "key", "payload": "tab" },
      { "id": "m2", "label": "Continue", "type": "prompt", "payload": "continue" }
    ]
  }
}
```

## 5. Server Push Events (`server -> client`)

### 5.1 Command Acknowledgment (`ack`)
```json
{
  "type": "ack",
  "replyTo": "cmd_101",
  "payload": { "status": "ok" }
}
```

### 5.2 Command Error (`error`)
```json
{
  "type": "error",
  "replyTo": "cmd_101",
  "error": {
    "code": "ERR_INTERACTION_STALE",
    "message": "The interaction has expired or was already answered."
  }
}
```

### 5.3 Topology & Radar Snapshot (`snapshot_update`)
Pushes workspace and tab topology, including sub-pane lists for split tabs:
```json
{
  "type": "snapshot_update",
  "payload": {
    "workspaces": [
      {
        "id": "w1",
        "label": "Pigeon",
        "tabCount": 2,
        "activeTabId": "w1:t1",
        "hasWarn": true,
        "hasWorking": false,
        "tabs": [
          {
            "id": "w1:t1",
            "label": "c1",
            "paneCount": 2,
            "panes": [
              { "id": "w1:p2", "agent": "claude", "agentStatus": "blocked", "isPrimary": true },
              { "id": "w1:p3", "agent": null, "agentStatus": "idle", "isPrimary": false }
            ]
          }
        ]
      }
    ],
    "workingAgents": [
      {
        "agent": "claude",
        "name": "c1",
        "status": "blocked",
        "workspaceId": "w1",
        "workspaceLabel": "Pigeon",
        "tabId": "w1:t1",
        "paneId": "w1:p2",
        "summary": "Asking permission for: rm -rf dist && bun run build"
      }
    ]
  }
}
```

### 5.4 Card Stream Upsert & Removal (`cards_upsert`, `cards_remove`)
```json
{
  "type": "cards_upsert",
  "payload": {
    "paneId": "w1:p2",
    "cards": [
      {
        "id": "card_hash_89a",
        "kind": "diff",
        "filePath": "src/auth.ts",
        "additions": 1,
        "deletions": 1,
        "diff": "@@ -10,1 +10,1 @@\n- const exp = sec * 1000;\n+ const exp = sec;"
      }
    ]
  }
}
```

### 5.5 Interactive Question Prompt (`interaction_required`)
```json
{
  "type": "interaction_required",
  "payload": {
    "paneId": "w1:p2",
    "interactionId": "int_789",
    "kind": "select",
    "title": "Bash command permission",
    "question": "Allow Claude to execute this command?",
    "payload": "rm -rf dist && bun run build",
    "fingerprint": "fp_88a7b9c1",
    "options": [
      { "id": "opt_0", "label": "Yes, execute", "keyShortcut": "1" },
      { "id": "opt_1", "label": "Yes, don't ask again", "keyShortcut": "2" },
      { "id": "opt_2", "label": "No", "keyShortcut": "3" }
    ],
    "fallbackKeys": ["enter", "esc", "up", "down"]
  }
}
```

### 5.6 Ghost Text Suggestion (`ghost_suggestion`, `ghost_cleared`)
```json
{
  "type": "ghost_suggestion",
  "payload": {
    "paneId": "w1:p2",
    "suggestionId": "gh_456",
    "command": "git commit -am 'fix: auth expiry'",
    "paneRevision": 18
  }
}
```

### 5.7 Raw Screen View (`pane_screen`)
Supplies clean plain-text screen content for the raw terminal fallback sheet:
```json
{
  "type": "pane_screen",
  "payload": {
    "paneId": "w1:p2",
    "text": "Claude Code\n~/Projects/coding/Pigeon\n$ bun test\n",
    "revision": 19
  }
}
```

### 5.8 Normalized Turns & Delta Streaming (`normalized_turns`, `turns_delta`)
Delivers normalized semantic turns parsed by Track 1 adapters. For large or streaming sessions, `turns_delta` streams append and patch deltas to prevent mobile UI re-render thrashing:
```json
{
  "type": "turns_delta",
  "payload": {
    "paneId": "w1:p2",
    "seqWatermark": 42,
    "sinceTurnIndex": 12,
    "appendTurns": [
      {
        "id": "turn_13",
        "role": "assistant",
        "timestamp": 1729650005000,
        "blocks": [
          { "kind": "markdown", "content": "Running test suite now..." }
        ]
      }
    ],
    "sessionStats": { "filesModified": 3, "additions": 45, "deletions": 12 }
  }
}
```

### 5.9 Upstream Runtime Health Status (`upstream_status`)
Reports connectivity state with the underlying Herdr daemon:
```json
{
  "type": "upstream_status",
  "payload": {
    "herdrConnected": true,
    "lastSyncTimestamp": 1729650000000
  }
}
```

### 5.10 Skills & Agent Recipe Sync (`skills_sync`)
Pushes available skill registry items and agent capabilities:
```json
{
  "type": "skills_sync",
  "payload": {
    "skills": [
      { "name": "grilling", "description": "Stress-test ideas and architecture plans", "source": "user" }
    ],
    "recipes": {
      "claude": {
        "kind": "claude",
        "label": "Claude Code",
        "models": [{ "id": "claude-3-7-sonnet", "label": "Claude 3.7 Sonnet" }],
        "interruptKeys": ["esc"]
      }
    }
  }
}
```

## 6. Configuration Synchronization Protocol

To enable seamless multi-device persistence and pre-installed defaults, Pigeon provides bidirectional configuration synchronization over WebSocket.

### 6.1 Handshake Configuration Delivery (`server -> client`)
In the `welcome` message payload, the server includes the current `clientConfig`:
```json
{
  "type": "welcome",
  "replyTo": "msg_001",
  "payload": {
    "protocolVersion": "1.0.0",
    "serverVersion": "0.1.0",
    "deviceId": "dev_9f8a3b12",
    "clientConfig": {
      "themeKey": "tokyo-night",
      "themeMode": "system",
      "themeId": "tokyo-night",
      "confirmCtrlC": true,
      "defaultView": "cards",
      "macros": [
        { "id": "m_model", "name": "模型", "type": "key", "payload": "model" }
      ]
    }
  }
}
```

### 6.2 Request Full Configuration (`client -> server`)
Clients may explicitly query the configuration:
```json
{
  "type": "config_get",
  "id": "req_cfg_01"
}
```
Server responds with `config_sync`:
```json
{
  "type": "config_sync",
  "replyTo": "req_cfg_01",
  "payload": {
    "version": 1,
    "client": {
      "themeKey": "tokyo-night",
      "themeMode": "system",
      "themeId": "tokyo-night",
      "confirmCtrlC": true,
      "defaultView": "cards",
      "macros": []
    }
  }
}
```

### 6.3 Partial Patch Update (`client -> server`)
When the user alters a setting in the mobile UI (e.g. changes theme or customizes a macro), the client sends a `config_patch` carrying only the modified delta:
```json
{
  "type": "config_patch",
  "id": "req_cfg_02",
  "payload": {
    "client": {
      "themeKey": "monokai-pro",
      "themeId": "monokai-pro"
    }
  }
}
```

### 6.4 Server Patch Acknowledgment and Broadcast
Upon receiving `config_patch`:
1. The daemon validates the payload fields and deep-merges them into `config.client`.
2. The daemon replies with standard `ack`:
   ```json
   { "type": "ack", "replyTo": "req_cfg_02" }
   ```
3. The daemon asynchronously flushes the merged configuration to `~/.config/pigeon/config.json`.
4. The daemon broadcasts `config_updated` to all connected clients:
   ```json
   {
     "type": "config_updated",
     "payload": {
       "client": { "themeKey": "monokai-pro", "themeId": "monokai-pro" }
     }
   }
   ```

## 7. Error Code Registry

| Error Code | Meaning | Recovery Action |
| :--- | :--- | :--- |
| `ERR_UNAUTHORIZED` | Session cookie invalid or expired | Redirect to QR code pair page |
| `ERR_FORBIDDEN_ORIGIN` | Request Origin or Host check failed | Verify Tailscale / publicBaseUrl |
| `ERR_INVALID_PAYLOAD` | Schema validation failed | Drop frame, log client error |
| `ERR_NOT_FOUND` | Targeted workspace, tab, or pane not found | Refresh snapshot |
| `ERR_INTERACTION_STALE` | Interaction ID expired, answered, or screen changed | Refresh pane state, dismiss card |
| `ERR_AGENT_BUSY` | Action rejected because agent is working | Wait until agent reaches idle/done |
| `ERR_AGENT_NOT_READY` | Agent shell prompt not ready | Wait for shell readiness |
| `ERR_AGENT_BLOCKED` | Agent waiting for interactive input | Answer active interaction card |
| `ERR_MENU_NOT_SUPPORTED` | Agent profile does not declare this menu | Disable menu button in UI |
| `ERR_MENU_TIMEOUT` | Menu did not render within timeout | Press Esc to dismiss menu |
| `ERR_TIMEOUT` | Operation timed out | Retry |
| `ERR_INCOMPATIBLE_PROTOCOL` | Client/server protocol version mismatch | Reload PWA |
| `ERR_INTERNAL` | Unhandled daemon error | Check daemon logs |
