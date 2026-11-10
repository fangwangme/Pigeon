# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
