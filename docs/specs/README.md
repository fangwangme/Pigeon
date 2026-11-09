# Pigeon Specifications

Specs describe what the system does and why. They are the authoritative standard every change is written and reviewed against.

## Specification Index

1. [`architecture.md`](architecture.md) — System topology, Bun daemon and Solid.js PWA, single-binary distribution and update flow, Tailscale Serve HTTPS access, dual-track session rendering, configuration persistence and multi-device sync, and trust boundaries / CSP.
2. [`protocol.md`](protocol.md) — Typed JSON message protocol over WebSocket (handshake, heartbeat, safe prompt answering, prompt queueing, session/model/tab/device commands, server events, error codes) and HTTP file uploads (`POST /api/uploads`).
3. [`herdr-adapter.md`](herdr-adapter.md) — Herdr integration contract: the Herdr App and Herdr Core channels, event subscription plus viewed-pane polling, agent states, tab and agent launch, prompting and answering, screen parse rules, and per-agent skills and commands.
4. [`security-and-pairing.md`](security-and-pairing.md) — Security model: QR-code-only pairing via URL fragment (`#code=...`), Base32 token, HttpOnly cookies, Origin/Host validation, and local admin IPC socket.
5. [`mobile-ui-and-themes.md`](mobile-ui-and-themes.md) — Mobile UX: workspace and all-agents lists, the conversation page, prompt cards, composer, new and resumed sessions, settings, light/dark themes with accent, Liquid Glass, and English/Chinese localization.
6. [`push.md`](push.md) — Web Push notification subsystem (VAPID keypair, presence-based push suppression, and privacy-preserving alerts).
7. [`agent-session-normalization.md`](agent-session-normalization.md) — Binding panes to agent sessions, the Claude Code, Codex, Pi, OpenCode, and AGY record formats, the NormalizedTurn model, todos, and session diffs.
8. [`quota-and-usage.md`](quota-and-usage.md) — Subscription quota for Claude Code, Codex and Antigravity (credential refresh, pace and level), and token usage and estimated cost for every agent (sources, pricing, ranges, comparison, heatmap layout).

## Core Rules for Spec Integrity
- **Spec Lead**: Any behavior change updates the spec first in the change's own branch.
- **Trust Boundaries**: Validate external input only at the trust boundaries named in these specs. Internal callers and types are trusted.
- **Fail Loudly**: Unexpected errors not documented in these specs must fail loudly without speculative fallbacks or swallowed exceptions.
