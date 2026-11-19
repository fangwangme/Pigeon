# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.18] - 2026-11-19

### Added
- **Home pull-to-refresh**: Pulling down at the top of Home now shows a refresh indicator and replaces the WebSocket with one fresh connection at once, including while offline (#37).

### Fixed
- **Agent-assigned session titles in tab labels**: A Herdr tab named after the agent it launches (`OpenCode`, `Claude Code`, …) now falls back to the bound session's title instead of showing only the agent name; a name the user gave the tab still wins (`protocol.md` §5.3, #37).
- **Resumed OpenCode panes stay on their session**: The daemon reads `opencode -s/--session` from the foreground argv as an exact binding signal and pins an explicitly resumed pane, so writing another session in the same folder no longer switches the transcript or its title (`agent-session-normalization.md` §2.0, §2.1, #37).
- **Markdown content stays inside the page**: Wide images fit the message column, raw `<pre>` blocks scroll inside their own box, and inline `style` attributes from agent HTML are dropped, so a session page can no longer be dragged sideways (`mobile-ui-and-themes.md` §3.2, #37).

## [0.1.17] - 2026-11-18

### Added
- **Antigravity artifact review card & `interaction_dismiss`**: Recognized completed `write_file` / `edit_file` calls with `ArtifactMetadata.RequestFeedback: true` inside the session's Antigravity brain directory as reviewable `pendingPlan` cards (**Full text**, **Proceed**, and **Skip `✕`**), added `interaction_dismiss` to clear the active card across viewers and downgrade reported status from `blocked` to `idle` until the pane's next Core status or interaction change, and restricted artifact interactions to turns where Herdr reports `blocked` (#35).
- **Copy terminal ID**: Added **Copy terminal ID** (`activePaneId`) with monospace subtitle to the session `⋯` menu (#35).
- **Interactive finger-tracking edge swipe-back**: Upgraded left-edge (`<= 44px`) back gestures across non-Home routes and full-screen sheets to track the finger in real time, revealing the `inert` parent page underneath with parallax and edge shadow and completing or springing back by drag distance or flick velocity, without false blocks on non-overflowing or left-resting horizontal containers or open overlays (#35).

### Fixed
- **Composer replies on unstructured `blocked` panes**: Passed `force: true` on `terminal.send` when Herdr reports `blocked` without structured choice options so free-text replies and Antigravity artifact feedback send immediately, while keeping `ERR_AGENT_BLOCKED` protection when numbered options or a pending question await a pick (#35).
- **Keyboard toast placement & localized command errors**: Positioned `.toast` notices above the open software keyboard (`[data-keyboard="open"]`) and rejected `request()` calls with localized `errorText` messages instead of raw server strings (#35).
- **Cleaner year & multi-month heatmaps**: Displayed day numbers only on the first row (Monday) in `week-columns` usage heatmaps (`year`, `all`, and ranges over six weeks) while keeping day numbers on all rows in `strip` and `week-rows` (`30d`) (#35).
- **Port-isolated session cookies for test instances**: Named session cookies `__Host-pigeon_session_<port>` (or `pigeon_session_<port>`) on non-production ports while keeping `__Host-pigeon_session` on production, prevented `resolveProductionPort` from reading `pigeon-<port>/config.json` as the production port, and checked HTTP status before parsing `/api/auth/status` JSON so concurrent instances on the same Tailscale hostname never overwrite each other's login session (#35).
- **Local-time log timestamps**: Formatted `pigeon.log` entries, `--debug` client connection timelines, and `pigeon status` timestamps in local ISO 8601 time (`YYYY-MM-DDTHH:mm:ss.sss±HH:MM`) instead of UTC (#35).
- **`--debug` RPC & background refresh diagnostics**: Logged sanitized `debug rpc` timings, payload sizes, and error codes (plus `debug usage scan` / `debug quota fetch` durations and client `rpc_error` events in `client_diag`) without exposing prompt text or credentials (#35).
- **Off-event-loop usage worker, incremental OpenCode cursor & report cache**: Moved usage scans/rebuilds into a compiled Bun `Worker` (`scan-worker.ts`), added `rowid` + `time_updated` incremental scanning for `opencode.db` and scalar report caching in `UsageService`, and avoided double aggregation in `getUsageReport` so WebSocket traffic and heartbeats never stall (#35).
- **2 s WebSocket reconnect & wakeup reliability**: Shortened `CONNECTING`, pairing check, and wakeup ping timeouts from 10 s / 5 s / 3 s to 2 s, guarded periodic heartbeat checks while a wakeup probe is in flight, and replaced stale `CONNECTING` sockets immediately on `online` and wake-from-hidden transitions (#35).
- **Usage error/retry recovery & Herdr startup timeout tolerance**: Rendered localized error + **重试 / Retry** states instead of infinite spinners on failed Usage report/day/model sheets, automatically reloaded open unloaded sheets after WebSocket reconnect, and tolerated `HerdrClient.connect()` startup snapshot timeouts without aborting daemon startup (#35).

### Changed
- **Codebase audit, deduplication & spec sync**: Removed dead server/client/CSS symbols (`unread`, `metaIndex`, `withFallback`, `TurnBuilder.touch()`, duplicate `pricing.json` fallback, dead `reasoning` turn item branch), removed silent error swallowing in session/usage stores and Codex/Pi/Claude/AGY scanners, consolidated shared helpers (`formatModelNameWithRecipes`, `readListingJsonLines`, `extractBlocksText`, `readTailscaleSelf`, `UsageOverlay`/`UsageBottomSheet`, `windowStatusColor`), pruned redundant tests with proper store reset isolation, and synchronized `docs/specs/` and `README*` with shipped behavior (#35).

## [0.1.16] - 2026-11-18

### Fixed
- **Antigravity thinking output tokens & cache writes**: SQLite `.db` and Desktop Language Server usage scanning now both count total `output_tokens` (`#3`, falling back to thinking `#9` + visible response `#10` when `#3` is absent) and `cache_write_tokens` (`#4`) (#33).
- **Antigravity orchestrator & worker model resolution**: Both `.db` and Desktop `.pb` cache scanners now read and persist `modelDisplayName` (`#21`, resetting cached `.pb` watermarks when migrating legacy `cache.db` tables), strip `-xhigh` / `-minimal` and parenthesized role/tier tags such as `(Orchestrator)`, inherit same-session sibling identity only when a step omits its own concrete model, and resolve unversioned Gemini family labels (`Orchestrator (Carbon)`, `Orchestrator (Argon)`, `Gemini Flash`) to the highest-version first-party `models.dev` release on or before the record's date (#33).

## [0.1.15] - 2026-11-17

### Changed
- **Heartbeat timeout back to 15 s**: The client now gives a connection up after 15 s without a `pong` instead of 10 s, so a briefly lossy network no longer kills a live connection and forces a slower full reconnect (#31).

### Added
- **Debug mode for connection timing**: `pigeon start --debug` turns on debug logging for that run only (nothing is persisted). The log then records HTTP requests, refused WebSocket upgrades, bootstrap timing and size, and the phone's own connection timeline (page load, visibility, every attempt with outcome and duration), which the phone keeps locally and hands over once it reaches a daemon in debug mode (#31).

### Fixed
- **Fast first connection after reopening the app**: The client opens the WebSocket at once and checks pairing only after a socket fails before opening, retries after 0, 0.5, 1, 2, then 3 s, and retries immediately when the network comes back or the app becomes visible (#31).
- **App opens without waiting for the network**: The service worker serves the cached app shell first and refreshes it in the background; the page knows its own build, so an older cached shell still shows the update banner. The daemon serves the page compressed (br or gzip) (#31).

## [0.1.14] - 2026-11-17

### Changed
- **Daemon-owned quota & usage refresh schedule**: Replaced per-service client-gated refresh timers and `usageScanMode` (`realtime` / `scheduled`) with a single daemon-level timer at `client.usageScanInterval` (default changed from `5m` to `15m`) that refreshes enabled items together regardless of connected phones, drops `usageScanMode` on load and rejects it in `config_patch`, turns the Quota and Usage page Refresh buttons into per-item on-demand refreshes (`quota_get { refresh: true }`, `usage_get { force: true }`), adds stale cache self-refresh on open/visibility/interval, and simplifies Settings to show only the shared refresh interval (#29).

### Fixed
- **Fast WebSocket reconnect without stuck Syncing**: Implemented single-flight `initWebSocket`, 5 s pairing-check and 10 s `CONNECTING` attempt timeouts, immediate first reconnect after an open socket drops (3 s thereafter), wakeup `ping` with a 3 s `pong` deadline replacing any scheduled reconnect, close code/reason logging on both client and daemon (with connection lifetime), clearing `paneSyncing` on socket teardown, and clearing the missing pane's view before switching to the server's substituted focused pane when `pane_bootstrap` carries `requestedPaneId` (#29).
- **Pricing fetch timeout**: Increased the per-source network timeout in `PricingManager` from 2.5 s to 30 s so slow upstream catalogs finish without leaving all usage records unpriced (#29).
- **Faster WebSocket heartbeat detection**: Reduced client heartbeat interval from 15 s to 5 s and `pong` timeout from 30 s to 10 s so dead links are detected and replaced sooner (#29).

## [0.1.13] - 2026-11-16

### Added
- **Home activity ordering & fold option**: Added per-pane `lastActivityAt` tracking (later of bound session's latest turn timestamp and last observed agent status change), Herdr vs recent activity ordering on Home (computed on entry and held while on Home, showing workspace relative activity age), and an opt-in switch to group workspaces without agents into one expandable row at the bottom of Home (#27).
- **Agent launch defaults**: Added `launch_defaults` WebSocket command and `ModelCatalog.launchDefaults` to read per-workspace/user default model and thinking level for Claude, Codex, pi, and Antigravity, preselecting them on the New Session page without sending `--model`/effort flags while untouched (#27).

### Changed
- **Split Home & All Agents filter sheets**: Replaced the shared filter sheet with a Home sort/display sheet and an All Agents grouping/status/agent sheet, dropping the `terminal` status chip and `showTerminals` / `showIdle` switches while migrating older stored filters cleanly (#27).
- **Model picker confirm flow**: Kept model and thinking choices local to the picker sheet until the header checkmark confirm button is tapped (discarding on close, scrim tap, or swipe down), moved catalog refresh beside search (or to the list end when search is absent), tagged the agent default model, and added **Restore agent default** (#27).
- **All Agents model subtitle**: Styled the model label on All Agents rows as plain muted text matching Home instead of an accent badge (#27).
- **Usage heatmap cells**: The week-column layout (ranges over six weeks) uses fixed 24px cells labeled with their dates; the zoom controls are removed and it scrolls sideways by drag (#27).

## [0.1.12] - 2026-11-15

### Added
- **AGY session normalization, `ask_question` submission & media serving**: Supported Antigravity (`agy`) error records, context compaction checkpoints, pending `ask_question` cards (including live-checked `questionSteps` submission and `Write-in...` text) and `exit_plan_mode` interaction cards, background command status updates until finish/cancel system messages, pasted `.user_uploaded` image thumbnails via `GET /api/agent-media/agy/<sessionId>/<name>`, full-width question mark prompts, AGY footer status-line filtering, and fallback to composer reply hints when a transcript question lacks checked keys (#25).
- **Sub-agent listing & read-only detail view**: Listed child sub-agents across Claude Code, Antigravity, and OpenCode on `normalized_turns` / `turns_delta` (with running indicator capsule beside todos and `⋯` menu sheet), opened each sub-agent's own read-only conversation on demand via `detail_get` `kind: "subagent"`, and excluded child conversations from parent session binding (#25).
- **User prompt copy button**: Added a right-aligned copy button underneath user messages with text (#25).

### Changed
- **Unified agent error warnings**: Rendered agent error items in amber (`--warn`) across all agents with consecutive-error folding (`count` / `×N`), covering Antigravity `ERROR_MESSAGE`, OpenCode `data.error` (excluding `aborted`), and Pi `stopReason: "error"` (#25).
- **Prompt duplicate guard**: Deduplicated identical prompt text and attachment IDs sent to the same pane within a configurable window (default 60 s, returning `ack` `{ duplicate: true }` and clearing the draft with a toast instead of delivering twice) (#25).
- **Account details hidden by default**: Changed `quotaShowAccount` default to `false` so subscription plan and account labels stay hidden on Quota and Settings pages until explicitly enabled (#25).
- **Split quota & usage switches with background-only refresh & unified entry**: Replaced `quotaUsageEnabled` with independent `quotaEnabled` (default `false`) and `usageEnabled` (default `true`) switches sharing `usageScanInterval` (default `5m`), running background refreshes only while paired phones are connected (with catch-up on connect or toggle-on and silent `quota_updated` / `usage_updated` pushes), making `quota_get` strictly cache-read-only, dropping legacy `quotaUsageEnabled` on config load, sharing one `(quotaEnabled || usageEnabled) && quotaButton` entry button (opening Usage when only `usageEnabled` is true and Quota otherwise, showing the quota status dot only when `quotaEnabled` is true), and keeping both Quota/Usage tabs reachable with an amber notice and Settings shortcut on a disabled tab (#25).

### Fixed
- **Antigravity model detection**: Restricted `Model Selection` setting-change parsing to `USER_INPUT` records and also read `PLANNER_RESPONSE.model` in record order, preventing quoted setting text inside tool outputs from overriding the session model (#25).
- **Claude Code task notifications & permission card payloads**: Filtered out `task-notification` records from user prompts, and displayed `pendingInteraction.payload` lines inside permission cards when the pending tool call is neither a command nor a diff (#25).

## [0.1.11] - 2026-11-14

### Changed
- **Stage-based pricing periods & full backfill**: Replaced duplicate daily pricing snapshots with a `model_price_periods` timeline (seeded at `0000-01-01` and split only on observed price changes), refreshed `PricingManager` on a 24-hour TTL with first-party provider priority, and backfilled `unpriced = 1` records across all agents (#23). The old `daily_pricing_snapshots` table is dropped without migration: history keeps its stored costs, but a later `pigeon rebuild-cache` reprices it from the periods, seeded from the current price.
- **Read-only OAuth credentials**: Stopped refreshing or writing external agent credentials; expired Codex and Antigravity credentials now surface clear read-only re-login prompts (#23).
- **Usage & Quota UI polish**: Separated `--fig-*` figure tokens, bolded numeric values (`font-weight: 600`) against faint labels on Usage views, gave the dark theme the light theme's heatmap scale (darker always means more), ordered every provider's quota windows by category and then 5h before 7d, made the Quota/Usage switch show its selection, normalized Antigravity tier model matching and `"Claude/GPT"` grouping, showed the Antigravity account of the source that answered, and displayed Anthropic account info alongside dynamic `limits[]` and `extra_usage` (#23).
- **Seen status follows the desktop**: a finished session opened in desktop Herdr shows as idle on the phone, and one opened on the phone is marked seen on the desktop (#23).
- **Streaming & hot-path efficiency**: Reconciled WebSocket snapshot/turn updates, switched transcript blocks to `<Index>`, added single-pane snapshot updates on status changes, added bounded LRU caching for Markdown rendering, and removed write transactions from `pane-cache` loads (#23).

### Fixed
- **Codex & agent session normalization**: Filtered Codex subagent rollouts, handled Codex `0.169.0` `item_completed` (`CommandExecution` / `FileChange`) and `write_stdin` records without duplicating wrapped exec calls, fixed AGY upload-only attachment turns and empty tool outputs, added `>64KB` Claude tail title parsing, reused a single read-only SQLite connection in OpenCode and picked up its streaming message updates, deduplicated Codex messages by id, and made fallback timestamps deterministic (#23).
- **Reliability & offline resilience**: Preserved offline queued prompts (`sending: false`) with automatic drain upon Herdr reconnect snapshot (a prompt sent at once that Herdr did not receive is reported, not queued), isolated per-source adapter/plugin failures without dropping bound sessions or their last turns or throwing on `ENOENT`, sent the missing Enter when an agent leaves a prompt with attachments in its input box, throttled `codex debug models` refreshes to 24 hours, recovered `PaneStore` file watchers after atomic renames, cleared push dedupe keys when delivery fails, distinguished JSON parse errors from internal errors on the admin socket, and scoped Claude question-menu parsing to Claude panes (#23).
- **Mobile UI fixes**: Non-overlapping code block copy header (`.cb-hdr`), wrapped message tables, working dot pulse with reduced-motion support, per-pane scroll restoration, tool-row chevron alignment, a chevron on every row of the tool sheet, and tool details that no longer freeze the page before their input loads (#23).

## [0.1.10] - 2026-11-12

### Added
- **Mobile PWA layout**: Opaque status bar so the home-screen app reaches the screen's bottom edge, bottom bar safe-area offset, compact home header, and edge swipe-back gesture across sub-pages (#21).
- **In-app image viewer**: Full-screen lightbox viewer for uploaded image thumbnails in transcript and composer previews without navigating away from the PWA (#21).
- **Launch-time model picker**: Pinned model card displaying model details, thinking level chips or fallback indicator, search filtering when over five models, and manual per-agent catalog refresh (#21).
- **Dynamic model catalog**: Claude models from the Models API, fetched at most once a day automatically and persisted; OpenCode labels and effort levels from its models cache; removed runtime `agent_set_model` command (#21).
- **Questions answered in the card**: Claude's `AskUserQuestion`, from the transcript or read from its on-screen menu, is answered entirely in the card, including multi-select questions and the user's own text (其他（自己输入）); prompt cards never hand off to the terminal, and optionless prompts show a dialog that only closes (#21).
- **Queue error pause**: Automatic queue pausing upon agent error items with manual `queue_resume` continuation (#21).
- **Queue sends everything at once**: When the turn ends, every queued message goes out together as one prompt (#21).
- **Compaction line**: Claude's compaction summary shows as one tinted line on the agent's side, expandable, instead of a user message (#21).
- **OpenCode last-used model hint**: The new session page names the model and effort OpenCode will start on (#21).
- **Antigravity resume & history**: Support resuming AGY sessions via `--conversation <id>` and list workspace conversations from conversation summaries (#21).
- **Past session model tags**: Sessions list carries last-used model and displays model tags in resume list (#21).
- **Instance-isolated PWA icons**: Formal/production instance (port 4100) serves light icons while test instances (non-4100) serve dark icons for visual distinction on mobile home screen (#21).
- **Daemon logging**: Persistent daemon logging to `pigeon.log` with truncation on startup (#21).

### Fixed
- **Mobile PWA layout on iOS 26**: The home-screen app no longer asks for a translucent status bar, which shortened the page and blurred its top; while a text field has focus the page follows the visual viewport, so the composer sits directly above the keyboard; a double tap no longer zooms the page (#21).
- **Code block copy**: The copy button sits above its scrolling block and falls back to a selected textarea, always with a toast (#21).

## [0.1.9] - 2026-11-11

### Added
- **Pane data bundling**: `pane_bootstrap` bundles pane state, queue, and lightweight turns (`toLightTurn`, `toLightStats`) into a single turnaround message on pane switch and resume (#19).
- **On-demand detail loading**: `detail_get` lazily loads full tool call arguments, outputs, reasoning text, and file diffs on demand (#19).
- **Push notification delivery**: RFC 8291 aes128gcm payload encryption and RFC 8292 VAPID authorization for Web Push with service worker background notification handling and window focus/navigation (#19).
- **Composer clipboard paste**: image paste support in Composer with automatic attachment upload and preview thumbnails (#19).
- **Transcript attachment thumbnails**: chat turns render uploaded attachments as clickable image thumbnails linking to `GET /api/uploads/:id` for full-size viewing (#19).
- **Unified quota & usage control model**: unified scheduled vs realtime scan modes across quota and usage, with scheduled background timer caches and 60-second cooldown protection on realtime queries (#19).
- **Environment indication**: daemon reports runtime environment (production, dev, test) in welcome handshake and displays environment in Settings (#19).

### Fixed
- **Herdr fault isolation**: write commands cleanly fail with `ERR_UPSTREAM_OFFLINE` when Herdr is offline instead of timing out; status events of unknown shapes log warnings and schedule background snapshot reconciliation (#19).
- **Tailscale and multi-interface access**: whitelist all detected network interfaces (Tailscale IP, LAN IP, MagicDNS) in `allowedHosts` and `allowedOrigins` to allow WebSocket connections across VPN and local interfaces in all modes (#19).
- **CLI prompt submission**: Antigravity prompts use single-line space separation for attachment paths and drop `@` mention prefix to prevent TUI autocomplete and multiline editor stalls (#19).
- **Usage scan timestamp format**: display scan completion times with full second precision (`HH:mm:ss`) (#19).
- **Queue robustness**: terminal creation timestamp matching prevents stale restored queue items from executing on reused pane IDs across reboots (#19).
- **Screen card classification**: plain text and input prompt lines are no longer falsely classified as cursor menus (#19).
- **Partial character reads**: multi-byte characters split across chunk boundaries in session JSONL transcripts are decoded intact (#19).
- **Markdown DOMPurify sanitization**: strictly forbid form, input, button, textarea, select, and style elements to prevent script and styling injection (#19).

## [0.1.8] - 2026-11-10

### Added
- **Quota & Usage master switch**: toggle both Subscription Quota and Token Usage Dashboard features with one click via `client.quotaUsageEnabled` (#17).
- **Entry masking**: hides header gauge buttons (Home & All Agents) and Settings sub-options, and redirects quota/usage routes to Home when disabled (#17).
- **Resource preservation**: retains existing configuration settings and aggregated `usage.db` records when disabled; immediately scans on re-enabling (#17).
- **Query gating**: stops background scanning timers and external provider queries, cleanly rejecting client requests with `ERR_FEATURE_DISABLED` when disabled (#17).
- **Skeleton loading templates & animations**: Quota and Usage pages render structured pulsing skeleton cards and active loading spinners before data arrives, protecting against false-alarm empty states (#17).
- **Server-side timestamp tracking**: Quota and Usage headers truthfully report actual server-side fetch (`fetchedAt`) and scan completion (`scannedAt`) timestamps instead of client query times (#17).

## [0.1.7] - 2026-11-10

### Fixed
- **Prompt queue on restart**: restored queued prompts on an already idle pane are dispatched immediately on startup instead of waiting for a status transition (#15).
- **Prompt queue turn 0 clearing**: the first prompt of a fresh session clears its sending state as soon as its initial turn appears in transcript deltas (#15).
- **Rebuild cache timeout**: `pigeon rebuild-cache` against a running daemon uses an extended timeout (up to 2 minutes) to avoid 5-second socket timeouts on large repositories (#15).
- **Usage rebuild concurrency**: `UsageService.rebuild()` serializes with background scans and prevents background timers during standalone CLI execution (#15).
- **Pricing retry & fallback**: pricing manager uses stale cache (>24h) as offline fallback when network is unreachable, and retries on subsequent background scans rather than locking into an unpriced state (#15).
- **SQLite scanner error handling**: locked or corrupted agent databases log a warning without recording fingerprints in `scan_file_state`, allowing future scans to retry (#15).
- **Antigravity argument parser**: `cleanArgValue` no longer strips outer quotes from non-JSON code arguments (#15).

## [0.1.6] - 2026-11-09

### Added
- **Subscription quota dashboard**: view Claude, Codex, and Antigravity subscription usage windows, time-based pace, reset times, and reset credits in a mobile-optimized card layout with live dot indicators (#13).
- **Token usage dashboard**: view multi-agent token consumption and estimated costs with presets (Today, 7D, 30D, Year, All, Custom), responsive heatmap visualizations (strip, week-rows, week-columns with zoom and scroll), daily breakdowns, and model details (#13).
- **Settings integration**: customize quota provider visibility, remaining vs used bar direction, and dashboard button visibility (#13).
- **CLI**: `pigeon rebuild-cache` rebuilds the usage database; the admin commands take `--port` to reach a daemon on another port, which keeps its own admin socket, paired devices and prompt queue (#13).

### Changed
- **Prompt queue**: survives a daemon restart, can be edited in place, and keeps a sent prompt as "sending" until it reaches the transcript (#13).
- **Conversation page**: the cached transcript stays current across reloads, and a pane without a structured session no longer stays on "Reading this pane…" (#13).

## [0.1.5] - 2026-11-09

### Added
- **README: Installation**: a new section right below the screenshots shows how to install Pigeon from npm (`npm install -g @fangwangme/pigeon`, `bun add -g`, or `npx` / `bunx` without installing) and start it (#11).

### Changed
- **Releases publish to npm through Trusted Publishing**: the release workflow authenticates to npm with a short-lived GitHub Actions OIDC credential instead of a stored npm token, and npm attaches provenance to each published package (#11).

## [0.1.4] - 2026-11-09

### Added
- **Install from npm**: Pigeon is published as `@fangwangme/pigeon` and runs with `npx @fangwangme/pigeon` or `bunx @fangwangme/pigeon`, or after `npm install -g @fangwangme/pigeon` / `bun add -g @fangwangme/pigeon`. It ships prebuilt standalone binaries for macOS and Linux on arm64 and x64, so neither Bun nor Node is needed to run it; the package manager installs only the binary for your machine. On other platforms, or when the binary package was skipped, `pigeon` exits with a message saying how to reinstall (#9).
- **Release automation**: pushing a `v*` tag builds the four platform binaries, attaches them to a GitHub Release whose notes come from this changelog, and publishes the npm packages. The launcher package is published only after every platform package resolves on the registry, and a failed release can be rerun to finish (#9).
- **CI**: pull requests and pushes to `main` run the test suite and the full build (#9).
