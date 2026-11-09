# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-11-09

### Added
- **Install from npm**: Pigeon is published as `@fangwangme/pigeon` and runs with `npx @fangwangme/pigeon` or `bunx @fangwangme/pigeon`, or after `npm install -g @fangwangme/pigeon` / `bun add -g @fangwangme/pigeon`. It ships prebuilt standalone binaries for macOS and Linux on arm64 and x64, so neither Bun nor Node is needed to run it; the package manager installs only the binary for your machine. On other platforms, or when the binary package was skipped, `pigeon` exits with a message saying how to reinstall (#9).
- **Release automation**: pushing a `v*` tag builds the four platform binaries, attaches them to a GitHub Release whose notes come from this changelog, and publishes the npm packages. The launcher package is published only after every platform package resolves on the registry, and a failed release can be rerun to finish (#9).
- **CI**: pull requests and pushes to `main` run the test suite and the full build (#9).
