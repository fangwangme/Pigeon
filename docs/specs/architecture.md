# System Architecture Specification

## 1. Overview and Purpose

Pigeon is a mobile-first remote control and mirror client for developers who run AI coding agents inside [Herdr](https://herdr.dev).

Rather than exposing a raw VT100 character-grid terminal over SSH/Mosh—which suffers from severe keyboard overlap, lack of semantic state awareness, and IME/speech-to-text conflicts on mobile devices—Pigeon operates as an intelligent local bridge daemon (`pigeon`) that connects to Herdr's local IPC interface and serves a structured, touch- and voice-optimized Progressive Web App (PWA) to mobile phones.

## 2. Target Platform and Browser Support

- **Primary Target**: **Chrome / modern Chromium-based mobile browsers** (Android Chrome, Chromium web engines, desktop Chrome mobile simulation).
- **iOS Safari Policy**: Explicitly **out of scope for v1**. Pigeon will not introduce complex workarounds (such as manual `visualViewport` height tracking, iOS PWA Cookie partition mitigations, or iOS edge-swipe gesture bypasses). Modern mobile Chrome supports standard `interactive-widget=resizes-content`, standard Cookie handling, and standard Web Push without proprietary platform workarounds.

## 3. System Topology

```
┌─────────────────────────────────────────────────────────┐
│              Mobile Client (Chrome Mobile PWA)          │
│  - Solid.js Reactive UI                                 │
│  - Native Voice-Ready Textarea (IME Composition Safe)   │
│  - Contextual Safeguards (Double-tap Ctrl+C)            │
│  - Sub-pane Pill Chips for Split Tabs                   │
└────────────────────────────┬────────────────────────────┘
                             │ HTTPS + WSS (Tailscale Serve / Insecure Dev)
                             │ Wire Protocol: Typed JSON Message Protocol
┌────────────────────────────▼────────────────────────────┐
│                  Pigeon Bridge Daemon                   │
│  - Runtime: Bun                                         │
│  - Herdr Event-Driven Adapter (events.subscribe)        │
│  - Line Pattern Card Classifier (150-250ms Debounce)   │
│  - Pairing & Security Guard (QR Code Only)              │
│  - Web Push Notification Subsystem                      │
│  - Local Admin Socket ($XDG_RUNTIME_DIR/pigeon.sock)    │
└─────────────▲──────────────────────────────┬────────────┘
              │ Admin IPC (0600)             │ Unix Domain Socket (~/.config/herdr/herdr.sock)
┌─────────────▼─────────────┐                │ Events: events.subscribe (with revisions)
│     Pigeon CLI Admin      │ ┌──────────────▼─────────────┐
│ (pigeon pair/devices/...) │ │    Herdr Runtime Server    │
└───────────────────────────┘ │    Workspaces, Tabs, Panes │
                              └────────────────────────────┘
```

## 4. Core Architectural Decisions

### 4.1 Single Binary Distribution and Build Pipeline
The entire application (daemon + embedded PWA static assets) compiles into a single executable binary via `bun build --compile`:
1. **Frontend Build**: The Solid.js PWA located in `src/client/` is compiled using Vite with `vite-plugin-singlefile`, producing a single self-contained HTML asset (`dist/index.html`) containing all scripts, styles, and SVG icons inlined.
2. **Daemon Build**: Bun compiles `src/cli/index.ts` with the bundled HTML asset embedded into the executable binary:
   ```bash
   bun build --compile --minify ./src/cli/index.ts --outfile dist/pigeon
   ```
   `scripts/embed-html.ts` generates `src/server/embedded-html.ts` from `dist/index.html` and `src/server/pwa-assets.ts` from `public/`. Both are build outputs (gitignored), and `public/` is the only source of the PWA assets. `bun test` rebuilds them first (test preload), so the tests always run against the current client.
3. **Execution**: Running `pigeon start` immediately serves the PWA and API without external `node_modules` or runtime filesystem dependencies.
4. **PWA Updates**: A new service worker installs and then waits. The page shows an "update available" banner. Tapping it posts `SKIP_WAITING`, the worker activates and claims clients, and the page reloads once. An update therefore never reloads the app while the user is typing.
5. **Type Checking**: The whole repository (daemon, client, tests, scripts) is one strict TypeScript project (`tsconfig.json`), and `bun test` fails on any `tsc --noEmit` error.

### 4.2 Access Layer & Networking
- **Primary Deployment Mode**: **Tailscale Serve** (`tailscale serve https / http://127.0.0.1:4100`).
  - Provides an automated, trusted `.ts.net` HTTPS certificate.
  - Grants instant mobile access both on local Wi-Fi and remotely on mobile cellular networks.
  - Satisfies the browser's **Secure Context (`window.isSecureContext`)** prerequisite, enabling Service Worker registration, PWA installation, and Web Push notifications.
  - Automatically derives `publicBaseUrl` from `tailscale status --json` (using `.Self.DNSName`).
- **Development Mode (`--insecure-dev`)**:
  - Explicit flag required for non-Tailscale local network testing (`http://192.168.x.x:4100`).
  - Binds to `0.0.0.0`, displays a prominent terminal security warning, issues non-Secure session cookies, and explicitly disables Web Push (as browsers reject Service Worker push on non-localhost HTTP).

### 4.3 Robust Herdr Adapter Strategy
Herdr has no global "output changed" event. Pigeon combines events, snapshots and targeted polling (details in `herdr-adapter.md` §3):
1. **Topology**: Herdr topology events trigger a debounced `session.snapshot`. A snapshot also runs every 30 seconds as reconciliation.
2. **Viewed Pane Reading**: The panes that phones are viewing are read with `pane.read` (`source: "recent_unwrapped"`) once per second. Unchanged screens (same SHA-256) are dropped before classification.
3. **Agent Status**: Pigeon subscribes to `pane.agent_status_changed` for every agent pane, so a transition into `blocked` is seen at once, even for panes nobody is viewing.

### 4.4 Dual-Track Session Rendering (Structured Stream vs Terminal Fallback)
Pigeon implements a **Dual-Track Architecture** (detailed in `agent-session-normalization.md`):
1. **Track 1 (Structured Agent Stream)**:
   - When a Herdr pane contains a recognized `agent_session` (OpenCode, AGY, Claude Code, Codex, Pi), Pigeon's `AgentSessionAdapter` reads the agent's native local storage (SQLite or JSONL) incrementally.
   - Pushes standardized `NormalizedTurn` streams to the mobile client with accordion folding for reasoning/thinking, structured tool call cards, and table horizontal overflow protection.
2. **Track 2 (PTY Raw Terminal Fallback)**:
   - When a pane runs a generic CLI shell (`bash`, `zsh`, `htop`, `vim`, etc.), or has no structured session, Pigeon shows the classified screen cards. The raw screen text (`pane_state.rawScreen`) is always available in the terminal sheet.
3. **Voice Input Policy**:
   - In-app microphone audio recording is deliberately avoided. Pigeon relies 100% on the mobile device's system keyboard voice input (Gboard, WeChat input method, iOS Dictation). The composer enforces strict IME composition protection (`isComposing`) to prevent accidental submission while voice candidate text is streaming.

### 4.5 Mobile Presence and Notification Milestone
- Application-level heartbeats (`ping` every 15s; server replies `pong`).
- Web Push is partly implemented (`push.md` status): the daemon side, triggers and presence suppression are in place; the client subscription, service-worker handlers and delivery are not.

### 4.6 Local CLI Admin Channel
Pigeon daemon listens on an isolated local Unix socket:
- Path: `$XDG_RUNTIME_DIR/pigeon.sock` (mode `0600`, or fallback `~/.local/state/pigeon/admin.sock`).
- CLI subcommands (`pigeon pair`, `pigeon devices`, `pigeon devices revoke <id>`, `pigeon status`) talk directly to the running daemon over this socket to query pairing tokens and instantly sever revoked connections.

### 4.7 Configuration Management and Bidirectional Persistence
Pigeon uses a centralized, structured JSON configuration file to support pre-configured environments and seamless multi-device roaming:
1. **Standard Storage Path**:
   - Location: `$XDG_CONFIG_HOME/pigeon/config.json` (defaults to `~/.config/pigeon/config.json`).
   - If the configuration file does not exist upon daemon startup, Pigeon automatically generates a default `config.json` with standard presets.
   - A file that is not valid JSON, or not a JSON object, stops startup with an error naming the file. It is never overwritten with defaults, so hand edits are not lost.
   - Values written by older builds are upgraded on load and the file is rewritten: the old `模型` key macro becomes the text `/model`, and a Herdr or admin socket path equal to one an older build wrote automatically is removed, so the environment decides again. A path the user set to anything else is kept.
2. **Configuration Namespaces**:
   - `server`: Daemon-level settings (`port`, `host`, `insecureDev`, `publicBaseUrl`). CLI flags override them at runtime without changing the file. The Herdr socket path, admin socket path and state directory are derived from the environment (`HERDR_SOCKET_PATH`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, `HOME`) at every start, and a fresh config does not contain them. A value set by hand in `server` still wins.
   - `client`: Mobile client preferences (`themeKey`, `themeMode`, `themeId`, `confirmCtrlC`, `defaultView`, `macros`).
3. **Partial Patch & Deep-Merge Persistence**:
   - Mobile clients synchronize settings via `config_patch` messages carrying only the modified delta (e.g. `{ "client": { "themeKey": "monokai-pro" } }`).
   - The daemon validates the patch (`protocol.md` §6.3), deep-merges it, and writes the file atomically before replying. A write failure is reported to the client.
   - All unmodified configuration fields (including server networking and other client settings) are strictly preserved across sessions and updates.
4. **Multi-Device State Broadcast**:
   - Upon successful pairing or connection handshake (`welcome`), the client receives the current `client` configuration via `config_sync` / `welcome.payload.clientConfig`.
   - When any device updates configuration, the daemon broadcasts `config_updated` to all active sessions, keeping multiple mobile devices in lockstep.

## 5. Trust Boundaries and Error Semantics

- **Client Inputs (Untrusted)**: Every WebSocket frame is validated in `src/server/ws-validate.ts` before dispatch, and every HTTP body is validated in its route. Malformed payloads are rejected with explicit error codes, and nothing is executed.
- **Terminal & Agent Output (Untrusted)**: Text emitted by coding agents and CLI commands is untrusted content.
  - HTML tags are stripped and sanitized via a strict sanitizer (e.g. DOMPurify).
  - URL schemes are restricted to a whitelist (`https:`, `http:`, `mailto:`). Schemes like `javascript:`, `data:`, `blob:`, `file:` are strictly blocked.
  - Terminal OSC 8/52 sequences and window title escape sequences are stripped prior to card parsing.
  - Markdown links must include `rel="noopener noreferrer" target="_blank"`.
- **Content Security Policy (CSP)**:
  ```http
  default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; object-src 'none';
  ```
  `script-src 'unsafe-inline'` is required by the single-file bundle, whose script is inline. Markdown sanitizing is what keeps agent output from becoming script.
- **Errors**: Errors the specs list as expected (Herdr offline, stale prompt, invalid frame) are reported through their documented codes. Anything else fails loudly: it is logged with a stack trace and answered with `ERR_INTERNAL`, never swallowed.
- **Herdr Socket (Trusted Internal)**: Communication with the local Herdr daemon is considered internal and trusted, but Pigeon parses all Herdr responses defensively, ignoring unknown fields to ensure forward compatibility.
