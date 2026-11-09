# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6] - 2026-11-09

### Added
- **Subscription quota dashboard**: view Claude, Codex, and Antigravity subscription usage windows, time-based pace, reset times, and reset credits in a mobile-optimized card layout with live dot indicators (#13).
- **Token usage dashboard**: view multi-agent token consumption and estimated costs with presets (Today, 7D, 30D, Year, All, Custom), responsive heatmap visualizations (strip, week-rows, week-columns with zoom and scroll), daily breakdowns, and model details (#13).
- **Settings integration**: customize quota provider visibility, remaining vs used bar direction, and dashboard button visibility (#13).

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
