# Herdr Adapter Specification

## 1. Scope and Isolation Contract

The `herdr` adapter (`src/server/herdr/`) is the sole component in the entire Pigeon codebase authorized to communicate with the local Herdr daemon.

All other Pigeon subsystems (HTTP/WebSocket server, screen parsers, UI) consume structured domain objects and remain completely oblivious to Herdr's low-level IPC mechanics.

## 2. API Contract-First and Herdr 0.9.5 Compatibility

- **Zero Rigid Version Bounds**: Pigeon strictly avoids hardcoding or asserting specific Herdr versions (e.g. `assert version == 0.9.5`). As long as Herdr satisfies its public CLI and Socket contract, Pigeon maintains full interoperability.
- **Graceful Schema Handling**: When deserializing Herdr's session snapshot or command responses, the adapter ignores any unknown or unexpected fields.
- **Protocol Channels**:
  - Primary & Production: Unix Domain Socket at `~/.config/herdr/herdr.sock` (configurable via `HERDR_SOCKET_PATH` for `--session` instances) transmitting newline-delimited JSON (NDJSON).
  - CLI usage is restricted solely to offline test fixtures and test doubles.

## 3. Event Subscription & Lifecycle Synchronization

Rather than polling snapshots continuously:
1. **Event Subscription**: On startup, the adapter opens the Unix socket and sends:
   ```json
   { "id": "sub_1", "method": "events.subscribe" }
   ```
2. **Subscribed Events**:
   - `pane_agent_status_changed`: updates agent state machine immediately.
   - `pane_output_changed`: contains `pane_id` and monotonic `revision`. Triggers throttled screen classification (150–250ms debounce) for the active pane.
   - `tab_created`, `tab_closed`, `pane_closed`: updates topology snapshot.
   - `pane_moved`: updates internal routing tables when a pane moves across workspaces, mapping the new `pane_id`.
3. **Reconciliation**: An initial `herdr api snapshot` is queried once upon connection to establish baseline state.

## 4. Agent Lifecycle States

Herdr recognizes 5 distinct agent lifecycle states:
- `idle`: The agent is ready for input and its tab has been seen. Input and menus permitted.
- `done`: The underlying agent has completed work while in the background. **Input and menus permitted** (identical to `idle`).
- `working`: The agent is actively reasoning, calling tools, or editing files. Prompts and menu commands are rejected with `ERR_AGENT_BUSY`.
- `blocked`: The agent is paused at an interactive confirmation or question dialog. Triggers `interaction_required` event and Web Push.
- `unknown`: Process running in pane without confirmed agent identity. Handled as raw terminal fallback.

## 5. Tab Creation and Agent Launch Sequence

Creating a tab and starting an agent in Herdr requires a strict two-stage sequence:
1. **Create Tab**:
   The adapter invokes `tab.create` with `workspace_id` and optional `cwd`:
   ```json
   { "method": "tab.create", "params": { "workspace_id": "w1", "cwd": "/path/to/project" } }
   ```
   Herdr creates a new tab with an interactive shell at `root_pane.pane_id`.
2. **Generate Unique Agent Name**:
   Names must strictly match the regex `^[a-z][a-z0-9_-]{0,31}$`.
   The adapter formats: `p-<kind>-<random_hex_4>` (e.g. `p-claude-8f3a`).
3. **Start Agent**:
   ```json
   { "method": "agent.start", "params": { "name": "p-claude-8f3a", "kind": "claude", "pane": "w1:p3" } }
   ```
4. **Handling Startup Prompts**:
   If Claude Code or Codex prompts for directory trust or initial login during startup, Herdr returns `agent_not_ready`. The adapter captures the screen, identifies the onboarding dialog, and emits an `interaction_required` card so the user can approve on mobile, rather than failing the launch.

## 6. Prompting and Command Execution

- **`agent_prompt` Mapping**: Maps directly to Herdr's `agent.prompt` command, which automatically manages bracketed paste mode and newline submission.
- **Herdr Error Code Translation**:
  - `agent_blocked` -> `ERR_AGENT_BLOCKED`
  - `agent_not_ready` -> `ERR_AGENT_NOT_READY`
  - `agent_prompt_stalled` -> `ERR_TIMEOUT`
  - `timeout` -> `ERR_TIMEOUT`

## 7. Native Menu Lifecycle (`/model`)

To adjust models without brittle CLI flags, Pigeon drives the agent's built-in interactive menu via an explicit state machine:

```
[idle / done]
      │
      ▼ (User taps "模型")
[menu_pending] ──► Pre-flight: verify composer is empty & pane mutex acquired
      │            Send "/model\n"
      ▼
 [menu_open]   ──► Call `pane.wait-output` with regex match for menu title (timeout: 2000ms)
      │            Parse options & identify current selection index
      ▼
 [selecting]   ──► User taps option -> map to "1\n" or calculated down/enter keys
      │
      ├─► Success: Screen re-check confirms menu dismissed -> [idle]
      └─► Timeout / User Cancel: Dispatch "esc" key -> [idle]
```

## 8. Agent Profile Registry with Parse Rules

```typescript
export interface AgentProfile {
  kind: string;                   // "claude" | "codex" | "agy" | "opencode" | "pi"
  label: string;                  // Display name
  capabilities: {
    hasModelMenu: boolean;        // true for claude, codex
  };
  parse: {
    thoughtPattern: RegExp;       // Matches "+ Thought" or thinking blocks
    toolPattern: RegExp;          // Matches bash execution ($ ...)
    diffPattern: RegExp;          // Matches file modification blocks
    promptPattern: RegExp;        // Matches inquirer/ink interactive questions
    ghostPattern: RegExp;         // Matches predictive dim/gray command hints
  };
}
```
All parsing rules are tested against real-world terminal fixtures located in `tests/fixtures/screens/<agent>/`.
