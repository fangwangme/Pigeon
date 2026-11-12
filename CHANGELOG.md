# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.10] - 2026-11-12

### Added
- **Mobile PWA layout**: Opaque status bar so the home-screen app reaches the screen's bottom edge, bottom bar safe-area offset, compact home header, and edge swipe-back gesture across sub-pages (#21).
- **In-app image viewer**: Full-screen lightbox viewer for uploaded image thumbnails in transcript and composer previews without navigating away from the PWA (#21).
- **Launch-time model picker**: Pinned model card displaying model details, thinking level chips or fallback indicator, search filtering when over five models, and manual per-agent catalog refresh (#21).
- **Dynamic model catalog**: Claude models from the Models API, fetched at most once a day automatically and persisted; OpenCode labels and effort levels from its models cache; removed runtime `agent_set_model` command (#21).
- **Transcript questions**: Structured questions (`AskUserQuestion`) directly source from session transcript, block pane status, and allow terminal handling (#21).
- **Queue error pause**: Automatic queue pausing upon agent error items with manual `queue_resume` continuation (#21).
- **Antigravity resume & history**: Support resuming AGY sessions via `--conversation <id>` and list workspace conversations from conversation summaries (#21).
- **Past session model tags**: Sessions list carries last-used model and displays model tags in resume list (#21).
- **Instance-isolated PWA icons**: Formal/production instance (port 4100) serves light icons while test instances (non-4100) serve dark icons for visual distinction on mobile home screen (#21).
- **Daemon logging**: Persistent daemon logging to `pigeon.log` with truncation on startup (#21).

### Fixed
- **Mobile PWA layout on iOS 26**: The home-screen app no longer asks for a translucent status bar, which shortened the page and blurred its top; while a text field has focus the page follows the visual viewport, so the composer sits directly above the keyboard (#21).

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
