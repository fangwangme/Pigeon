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
│  - Native-style conversation UI (transcripts)          │
│  - Workspace → tab lists, all-agents view               │
│  - IME-safe composer, prompt cards, uploads             │
└────────────────────────────┬────────────────────────────┘
                             │ HTTPS + WSS (Tailscale Serve / Insecure Dev)
                             │ Wire Protocol: Typed JSON Message Protocol
┌────────────────────────────▼────────────────────────────┐
│                  Pigeon Bridge Daemon                   │
│  - Runtime: Bun                                         │
│  - Herdr Adapter (App + Core, events.subscribe)         │
│  - Session Store & Agent Log Readers (PaneStore)        │
│  - Line Pattern Card Classifier (150-250ms Debounce)   │
│  - Pairing & Security Guard (QR Code Only)              │
│  - Web Push Notification Subsystem                      │
│  - Local Admin Socket ($XDG_RUNTIME_DIR/pigeon.sock)    │
└─────────────▲──────────────────────────────┬────────────┘
              │ Admin IPC (0600)             │ Unix sockets: herdr-app.sock (spaces, tabs)
┌─────────────▼─────────────┐                │   + herdr-core default.sock (terminals, events)
│     Pigeon CLI Admin      │ ┌──────────────▼─────────────┐
│ (pigeon pair/devices/...) │ │ Herdr App  (window: spaces,│
└───────────────────────────┘ │            tabs, panes)    │
                              │ Herdr Core (hc: terminals, │
                              │   status, screen, input)   │
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
   The app shell is fetched network-first, so a daemon rebuilt with a new client usually leaves `sw.js` unchanged. The page therefore also compares the `buildId` of each `welcome` with the first one it saw (`protocol.md` §3.2). On a mismatch it shows the same banner, and tapping it reloads the page. A standalone PWA has no reload button, so this is how a rebuilt daemon reaches an open phone.
5. **Type Checking**: The whole repository (daemon, client, tests, scripts) is one strict TypeScript project (`tsconfig.json`), and `bun test` fails on any `tsc --noEmit` error.

### 4.2 Access Layer & Networking
- **Primary Deployment Mode**: **Tailscale Serve** (`tailscale serve https / http://127.0.0.1:4100`).
  - Provides an automated, trusted `.ts.net` HTTPS certificate.
  - Grants instant mobile access both on local Wi-Fi and remotely on mobile cellular networks.
  - Satisfies the browser's **Secure Context (`window.isSecureContext`)** prerequisite, enabling Service Worker registration, PWA installation, and Web Push notifications.
  - Automatically derives `publicBaseUrl` from `tailscale status --json` (using `.Self.DNSName`).
- **Development Mode (`--insecure-dev`)**:
  - Explicit flag required for non-Tailscale local network testing (`http://192.168.x.x:4100`).
  - Serves plain HTTP (the daemon listens on every interface in every mode, `security-and-pairing.md` §5), displays a prominent terminal security warning, issues non-Secure session cookies, and explicitly disables Web Push (as browsers reject Service Worker push on non-localhost HTTP).

### 4.3 Robust Herdr Adapter Strategy
Herdr has no global "output changed" event. Pigeon combines events, snapshots and targeted polling (details in `herdr-adapter.md` §3):
1. **Topology**: Herdr Core terminal events trigger a debounced snapshot (Herdr App `ls` and `status` joined with Core `terminal.list`). A snapshot also runs every 30 seconds as reconciliation.
2. **Viewed Pane Reading**: The panes that phones are viewing are read with Core `terminal.read` once per second (only the visible screen for full-screen programs). A read whose screen (same SHA-256) and Herdr status are both unchanged is dropped before classification.
3. **Agent Status**: Pigeon subscribes to every Core terminal's events, so a transition into `blocked` is seen at once, even for panes nobody is viewing.

### 4.4 Dual-Track Session Rendering (Structured Stream vs Terminal Fallback)
Pigeon implements a **Dual-Track Architecture** (detailed in `agent-session-normalization.md`):
1. **Track 1 (Structured Agent Stream)**:
   - Pigeon binds each agent pane to the agent's own session records from the process facts Herdr Core reports (`agent-session-normalization.md` §2.0), and reads those records (SQLite or JSONL) incrementally for Claude Code, Codex, Pi, OpenCode and AGY.
   - Pushes standardized `NormalizedTurn` streams, which the phone renders as a conversation (`mobile-ui-and-themes.md` §3).
2. **Track 2 (PTY Raw Terminal Fallback)**:
   - When a pane runs a generic CLI shell (`bash`, `zsh`, `htop`, `vim`, etc.), or has no structured session, Pigeon shows the classified screen cards. The raw screen text (`pane_state.rawScreen`) is always available in the terminal sheet.
3. **Voice Input Policy** (user decision, 2026-11-06):
   - Pigeon records no audio. Voice input is the phone's system dictation. Bridging the phone's microphone to an agent's own voice mode, or recognizing speech on the computer, is out of scope for now. The composer's IME protection keeps dictation from sending early (`mobile-ui-and-themes.md` §1.2).

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
2. **Configuration Namespaces**:
   - `server`: Daemon-level settings (`port`, `host`, `insecureDev`, `publicBaseUrl`). CLI flags override them at runtime without changing the file. The Herdr App and Herdr Core socket paths (`herdrAppSocketPath`, `herdrCoreSocketPath`), the admin socket path and the state directory are derived from the environment (`HERDR_APP_HOME`, `HC_TERMINAL_SOCKET`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, `HOME`) at every start, and a fresh config does not contain them. A value set by hand in `server` still wins.
   - `client`: Appearance shared by all paired phones (`themeMode`, `accent`). Per-browser conveniences (filters, collapsed groups, unread marks, drafts, reduced transparency) stay in that browser's `localStorage`.
3. **Partial Patch & Deep-Merge Persistence**:
   - Mobile clients synchronize settings via `config_patch` messages carrying only the modified delta (e.g. `{ "client": { "accent": "green" } }`).
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
