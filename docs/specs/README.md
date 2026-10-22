# Pigeon Specifications

Specs describe what the system does and why. They are the authoritative standard every change is written and reviewed against.

## Specification Index

1. [`architecture.md`](architecture.md) — System topology, Bun runtime daemon, Solid.js PWA, single-binary distribution, Tailscale serve HTTPS access, and line-pattern card classifier.
2. [`protocol.md`](protocol.md) — Typed JSON message protocol over WebSocket (heartbeat, `interaction_respond` safe answering, commands, server events, error codes).
3. [`herdr-adapter.md`](herdr-adapter.md) — Herdr 0.9.5 integration contract: event-driven subscription (`events.subscribe`), complete 5-state machine, Agent profile registry, and `/model` menu lifecycle.
4. [`security-and-pairing.md`](security-and-pairing.md) — Security model: QR-code-only pairing via URL fragment (`#code=...`), Base32 token, HttpOnly cookies, Origin/Host validation, and local admin IPC socket.
5. [`mobile-ui-and-themes.md`](mobile-ui-and-themes.md) — Mobile UX on Chromium (sub-pane chips, double-tap `Ctrl+C` safeguard, IME composition safety, 44px hit targets, semantic tokens, and 6 preset theme packs).
6. [`push.md`](push.md) — Web Push notification subsystem (VAPID keypair, presence-based push suppression, and privacy-preserving alerts).

## Core Rules for Spec Integrity
- **Spec Lead**: Any behavior change updates the spec first in the change's own branch.
- **Trust Boundaries**: Validate external input only at the trust boundaries named in these specs. Internal callers and types are trusted.
- **Fail Loudly**: Unexpected errors not documented in these specs must fail loudly without speculative fallbacks or swallowed exceptions.
