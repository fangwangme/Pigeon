# System Architecture Specification

## 1. Overview and Purpose

Pigeon is a mobile-first remote control and mirror client for developers who run AI coding agents inside [Herdr](https://herdr.dev).

Rather than exposing a raw VT100 character-grid terminal over SSH/Mosh—which suffers from severe keyboard overlap, lack of semantic state awareness, and IME/speech-to-text conflicts on mobile devices—Pigeon operates as an intelligent local bridge daemon (`pigeon`) that connects to Herdr's local IPC interface and serves a structured, touch- and voice-optimized Progressive Web App (PWA) to mobile phones.

## 2. Target Platform and Browser Support

- **Targets** (user decision, 2026-11-11): iOS Safari and the iOS home-screen PWA (iOS 16.4 or later), which is the user's phone, and Chrome / modern Chromium-based mobile browsers.
- **iOS specifics**: Web Push on iOS works only in the home-screen PWA, and the phone says so (`push.md` §2). Pigeon adds no gesture bypasses or cookie-partition workarounds.

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
`pigeon start` needs no flags (user decision, 2026-11-11). Without `--public-url` or `server.publicBaseUrl`, it takes the first access mode whose address exists:

| Mode | Address | Secure | Listens on |
| :--- | :--- | :--- | :--- |
| Tailscale Serve | `https://<.Self.DNSName>` (from `tailscale status --json`), when `tailscale serve` proxies to `127.0.0.1:<port>` | yes | `127.0.0.1` |
| Tailscale IP | `http://<first .Self.TailscaleIPs IPv4>:<port>` | no | every interface |
| LAN | `http://<first private IPv4 of a physical interface>:<port>` | no | every interface |
| Localhost | `http://localhost:<port>` | no | every interface |

- A configured URL (`--public-url`, `server.publicBaseUrl`) wins over every mode; it is secure when its scheme is `https`, and the daemon then listens on every interface.
- `--insecure-dev` skips the two Tailscale modes, starts in LAN mode, and also accepts the Vite dev server's origins (`security-and-pairing.md` §4).
- **Secure mode** satisfies the browser's Secure Context (`window.isSecureContext`): Service Worker registration, PWA installation and Web Push work. Tailscale Serve provides the trusted `.ts.net` certificate and reaches the phone on Wi-Fi and cellular alike.
- **Plain HTTP modes** print a prominent warning at start: the phone gets no Service Worker, no PWA installation and no Web Push, and in LAN mode the traffic is not encrypted. Session cookies drop `Secure` and the `__Host-` prefix (`security-and-pairing.md` §5).
- The start output names the chosen address first, then every other address found, each with its mode.
- `server.host` in `config.json` pins the listen address in every mode.
- The resolution is one function, `resolveAccess({ configured?, insecureDev, port }, probes) → { publicBaseUrl, secure, bindHost, alternatives }` in `src/server/daemon.ts`. `probes` has `tailscaleServeDns`, `tailscaleIp` and `lanIp`, each `() => string | null`; tests pass their own. `bindHost` is `"127.0.0.1"` for Tailscale Serve and `""` (every interface, dual-stack) otherwise.

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
- Web Push is delivered in secure mode (`push.md`).

### 4.6 Local CLI Admin Channel
Pigeon daemon listens on an isolated local Unix socket:
- Path: `$XDG_RUNTIME_DIR/pigeon.sock` (mode `0600`, or fallback `~/.local/share/pigeon/admin.sock`).
- CLI subcommands (`pigeon pair`, `pigeon devices`, `pigeon devices revoke <id>`, `pigeon status`, `pigeon rebuild-cache`) talk directly to the running daemon over this socket to query pairing tokens and instantly sever revoked connections. `pigeon rebuild-cache` rebuilds the usage database directly when no daemon is running, and uses an extended timeout (up to 2 minutes) when querying a running daemon.
- **Instances by port** (user decision, 2026-11-11): the production instance is the daemon started without `--port`, or with `--port` equal to `server.port` of the production `config.json` (4100 unless the user changed it). It keeps its state in `<data>/pigeon/` and its admin socket at `pigeon.sock`. A daemon started with any other `--port <n>` is a test instance: its whole state directory is `<data>/pigeon-<n>/` (config, devices, queue, VAPID keys, push subscriptions, uploads) and its admin socket is `pigeon-<n>.sock`. `<data>` is `$XDG_DATA_HOME`, else `~/.local/share`. The admin subcommands follow the same rule for `--port <n>`.
- **Shared usage data**: the usage database, the price cache and the Antigravity usage cache always live in `<data>/pigeon/`, so a test instance shows the real usage (user decision, 2026-11-11). Both instances may scan into `usage.db`; SQLite's WAL mode and a busy timeout serialize the writers. `pigeon rebuild-cache --port <n>` for a test instance refuses without `--yes`, because it rebuilds the database production uses.
- `resolveInstancePaths({ env, port, productionPort })` in `src/server/config-manager.ts` is the one place these paths are derived. It returns `stateDir`, `configPath`, `adminSocketPath`, `devicesPath`, `queuePath`, `vapidPath`, `pushSubscriptionsPath`, `uploadsDir` (instance) and `usageDbPath`, `pricingCachePath` (shared).
- **`pigeon status`** prints: whether the Herdr App and Core answer; for every pane with queued prompts or a non-idle status, its status, queue length and queue state (`protocol.md` §4.2); the last usage scan's time and duration; and each agent source's last error with its time (§5).

### 4.7 Configuration Management and Bidirectional Persistence
Pigeon uses a centralized, structured JSON configuration file to support pre-configured environments and seamless multi-device roaming:
1. **Standard Storage Path**:
   - Location: `$XDG_DATA_HOME/pigeon/config.json` (defaults to `~/.local/share/pigeon/config.json`), falling back to `$XDG_CONFIG_HOME/pigeon/config.json`. A test instance (§4.6) uses `config.json` in its own state directory.
   - If the configuration file does not exist upon daemon startup, Pigeon automatically generates a default `config.json` with standard presets, including the instance's `server.port`.
   - **Port** (user decision, 2026-11-11): the daemon listens on `server.port`, or `--port`. A port already in use stops startup with an error that names the port and, when `ss` or `lsof` reveals it, the process holding it. The daemon never moves to another port, because paired phones and `tailscale serve` point at this one. To use another port, the user edits `server.port`.
   - A file that is not valid JSON, or not a JSON object, stops startup with an error naming the file. It is never overwritten with defaults, so hand edits are not lost.
2. **Configuration Namespaces**:
   - `server`: Daemon-level settings (`port`, `host`, `insecureDev`, `publicBaseUrl`). CLI flags override them at runtime without changing the file. The Herdr App and Herdr Core socket paths (`herdrAppSocketPath`, `herdrCoreSocketPath`), the admin socket path and the state directory are derived from the environment (`HERDR_APP_HOME`, `HC_TERMINAL_SOCKET`, `XDG_RUNTIME_DIR`, `XDG_DATA_HOME`, `HOME`) at every start, and a fresh config does not contain them. A value set by hand in `server` still wins.
   - `client`: Settings shared by all paired phones: appearance (`themeMode`, `accent`) and the quota & usage settings (`quotaUsageEnabled`, `quotaProviders`, `quotaDisplay`, `quotaButton`, `quotaShowAccount`, `usageScanMode`, `usageScanInterval`; `quota-and-usage.md` §1.1, §2.5, `mobile-ui-and-themes.md` §11.4). An absent `quotaProviders` is computed at every start from the providers logged in on this computer and is not written until the user changes it. Per-browser conveniences (filters, collapsed groups, unread marks, drafts, reduced transparency) stay in that browser's `localStorage`.
3. **Partial Patch & Deep-Merge Persistence**:
   - Mobile clients synchronize settings via `config_patch` messages carrying only the modified delta (e.g. `{ "client": { "accent": "green" } }`).
   - The daemon validates the patch (`protocol.md` §6.3), deep-merges it, and writes the file atomically before replying. A write failure is reported to the client.
   - All unmodified configuration fields (including server networking and other client settings) are strictly preserved across sessions and updates.
4. **Multi-Device State Broadcast**:
   - Upon successful pairing or connection handshake (`welcome`), the client receives the current `client` configuration via `config_sync` / `welcome.payload.clientConfig`.
   - When any device updates configuration, the daemon broadcasts `config_updated` to all active sessions, keeping multiple mobile devices in lockstep.

### 4.8 Version and Environment
- `package.json` is the only version source. The build embeds it, and `welcome.serverVersion` (`protocol.md` §3.2) and `GET /api/version` report it.
- `welcome.environment` is `{ kind, port }`: `kind` is `dev` when the daemon runs from source rather than as a compiled binary, `test` for a compiled test instance (§4.6), else `production`. Settings shows the version as `0.1.8`, `0.1.8 (dev)` or `0.1.8 (test:4101)` (`mobile-ui-and-themes.md` §8.1).

## 5. Trust Boundaries and Error Semantics

- **Client Inputs (Untrusted)**: Every WebSocket frame is validated in `src/server/ws-validate.ts` before dispatch, and every HTTP body is validated in its route. Malformed payloads are rejected with explicit error codes, and nothing is executed.
- **Terminal & Agent Output (Untrusted)**: Text emitted by coding agents and CLI commands is untrusted content.
  - HTML tags are stripped and sanitized via a strict sanitizer (e.g. DOMPurify). `style`, `form`, `input`, `button`, `textarea` and `select` are removed with their content, so agent output cannot restyle the page or imitate a prompt card.
  - URL schemes are restricted to a whitelist (`https:`, `http:`, `mailto:`). Schemes like `javascript:`, `data:`, `blob:`, `file:` are strictly blocked.
  - Terminal OSC 8/52 sequences and window title escape sequences are stripped prior to card parsing.
  - Markdown links must include `rel="noopener noreferrer" target="_blank"`.
- **Content Security Policy (CSP)**:
  ```http
  default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none';
  ```
  `script-src 'unsafe-inline'` is required by the single-file bundle, whose script is inline. Markdown sanitizing is what keeps agent output from becoming script.
- **Errors**: Errors the specs list as expected (Herdr offline, stale prompt, invalid frame) are reported through their documented codes. Anything else fails loudly: it is logged with a stack trace and answered with `ERR_INTERNAL`, never swallowed.
- **Agent source boundary**: the work Pigeon does on each agent's own files — session binding, session reading, skill scanning, usage scanning — runs per agent and per source inside one error boundary. A failure there (a locked database or a changed schema, a file removed between listing and reading, an unparseable plugin list) degrades only that source: the pane stays unbound or keeps its last turns, the skill list lacks that source, the scan skips that file. It is logged with its stack at most once a minute per source and error kind, and shown in `pigeon status` (§4.6). It never stops a topology broadcast, the prompt queue, or another source. Outside these boundaries the fail-loudly rule above applies; inside them, an error is skipped silently only where a spec names the skip (an unparseable session record, `agent-session-normalization.md` §1).
- **Debug globals**: the production bundle defines none (no `window.__pigeon`); a development build may.
- **External APIs and Agent Files (Untrusted)**: Quota endpoints, price lists, the Antigravity language server, `agy -p /usage` output, and the agents' credential and session files are validated before use. Their expected failures are reported per provider or per source (`quota-and-usage.md` §2.6, §3.1, §3.3), never as `ERR_INTERNAL`. Credential handling is `security-and-pairing.md` §6.
- **Herdr Socket (Trusted Internal)**: Communication with the local Herdr daemon is considered internal and trusted, but Pigeon parses all Herdr responses defensively, ignoring unknown fields to ensure forward compatibility.
