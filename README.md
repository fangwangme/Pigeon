<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/icon-dark.svg">
    <img src="public/icon-light.svg" width="120" height="120" alt="Pigeon — bionic messenger pigeon carrying a >_ terminal envelope">
  </picture>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

# Pigeon

Pigeon puts the coding agents running in [Herdr](https://herdr.dev) on your phone. Instead of pinching and zooming a tiny terminal over SSH, you get a mobile web app for **Claude Code**, **Codex**, **OpenCode**, **Antigravity**, and **pi**. Check which agent is working or waiting on you, read its diffs and replies, answer prompts with a tap, queue your next message, or start and resume sessions from anywhere.

A lightweight daemon runs alongside Herdr on your computer and serves the app over your Tailscale network. Everything compiles into a single binary.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/home-dark.png">
    <img src="docs/images/home-light.png" width="260" alt="See every workspace and active agent status at a glance">
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/agents-dark.png">
    <img src="docs/images/agents-light.png" width="260" alt="Track who is waiting, working, or done across all projects">
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/commands-dark.png">
    <img src="docs/images/commands-light.png" width="260" alt="Trigger slash commands and project skills right from the composer">
  </picture>
</p>
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/diff-dark.png">
    <img src="docs/images/diff-light.png" width="260" alt="Inspect commands and tool execution history with file diffs">
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/quota-dark.png">
    <img src="docs/images/quota-light.png" width="260" alt="Track rate-limit windows, pace, and reset times across providers">
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/usage-dark.png">
    <img src="docs/images/usage-light.png" width="260" alt="Inspect token usage, estimated costs, and daily activity trends">
  </picture>
</p>

## Installation

Install globally with **bun**:

```bash
bun add -g @fangwangme/pigeon
```

Or run it directly without installing:

```bash
bunx @fangwangme/pigeon
```

*(Also works with **npm**: `npm install -g @fangwangme/pigeon` or `npx @fangwangme/pigeon`.)*

Start the daemon:

```bash
pigeon start
```

`pigeon start` automatically checks or configures `tailscale serve` (proxying HTTPS port `8443` to local port `4100`) and prints a pairing QR code in your terminal. Scan it with Chrome on Android or Safari / Chrome on iOS, then choose **Add to Home Screen** to install the PWA.

Prebuilt binaries are published for macOS (Apple Silicon and Intel) and Linux (`x64` and `arm64`). On other platforms, [build from source](#build-from-source). See [Requirements](#requirements) and the [Tailscale Setup Guide](docs/usage/tailscale.md) for networking details.

## What it does

- **Every workspace at a glance.** Browse Herdr workspaces and tabs with live status dots (`Needs you`, `Working`, green `Done` when finished, gray `Idle` once viewed, or plain shell). Open **All agents** to group sessions by urgency status or by workspace, and filter by status, agent, or name.
- **Conversations, not raw scrollback.** Prompts, Markdown replies, collapsible thinking blocks, grouped tool calls, file diffs, and task lists render like a chat thread from each agent's own session log. When a pane has no session log yet, Pigeon parses the live terminal screen into structured cards instead.
- **Answer prompts with a tap.** When an agent stops for permission, asks a question, or waits on a plan, an interactive prompt card replaces the reply box. Question menus and numbered choices become native tap controls directly inside the card.
- **Keep work moving.** Reply anytime—if the agent is still busy, your message joins a persistent queue and goes out together when the turn finishes (with edit and cancel controls). Attach images or files from your phone, insert `/` commands and project skills, or interrupt a turn mid-flight.
- **A real terminal when you need one.** Peek at any pane's live screen and send `Enter`, `Esc`, `Tab`, `Ctrl+C`, or arrow keys. Plain shell panes open straight into terminal view.
- **Readable models, clean icons, and account context.** Displays each agent's brand icon and friendly model labels (falling back cleanly to the short ID after `/`), while keeping workspace paths readable on narrow screens.
- **Subscription quota, Web Push, and token usage.** Monitor live rate-limit windows, pace, and reset countdowns across Claude Code, Codex, and Antigravity (reading local credentials strictly read-only without mutating your tokens). Get background Web Push alerts when an agent blocks or finishes, inspect token consumption and period-accurate cost estimates in **Usage**, or turn all quota/usage collection off with one toggle in Settings.
- **Start, resume, and manage sessions.** Launch any supported agent or shell in a new Herdr tab, resume past conversations across Claude Code, Codex, Antigravity, OpenCode, and pi, choose models and thinking levels at launch, and rename or close tabs without touching focus on your computer.
- **Standalone PWA with automatic theme & language support.** Installable on iOS and Android with light, dark, and system themes, customizable accent color, a per-phone **Reduce transparency** toggle, and English / Simplified Chinese UI. Uses dedicated dark and light app emblems (`public/icon-dark.svg` / `public/icon-light.svg`) to help distinguish test instances on your home screen.

## How it works

```
Phone (Chrome / Safari PWA) ──HTTPS / WSS over Tailscale──▶ pigeon daemon ──Unix sockets──▶ Herdr App + Herdr Core
                                                                ├── reads agent session logs on disk (JSONL / SQLite)
                                                                ├── reads Antigravity Language Server RPC (optional, loopback)
                                                                └── local admin socket ◀── pigeon CLI
```

- **Tailscale HTTPS tunnel.** On startup, `pigeon start` configures `tailscale serve` (`https://<machine>.<tailnet>.ts.net:8443` → `127.0.0.1:4100`) so the phone connects over end-to-end encrypted HTTPS/WSS inside your private tailnet—unlocking PWA installation and Web Push without exposing public ports.
- **Local sockets to Herdr.** The daemon talks to **Herdr App** (`herdr-app.sock`) to manage workspaces and tabs, and to **Herdr Core** (`herdr-core`) for pane status events, screen reads, and input.
- **Disk session logs & local RPC.** Tails each agent's session logs (JSONL / SQLite) incrementally as turns arrive, and queries local loopback services (such as the Antigravity Language Server) for live quota data when running.
- **Fragment-based QR pairing.** Pairing codes travel in the URL fragment (`#code=...`), so they never appear in HTTP request headers or proxy logs, and exchange for an `HttpOnly` session cookie. Review or revoke paired devices anytime from **Settings** or `pigeon devices`.

Full architecture, protocol, and normalization specs live in [`docs/specs/`](docs/specs/).

## Requirements

- The [Herdr](https://herdr.dev) desktop app (`herdr-app` + `herdr-core`) running with its window open. *(The older terminal-only `herdr` TUI is not supported.)*
- [Bun](https://bun.sh) (recommended) or [Node.js](https://nodejs.org) to install; Bun to build from source.
- [Tailscale](https://tailscale.com) signed into the same tailnet on both your computer and your phone (see the [Tailscale Setup Guide](docs/usage/tailscale.md)).
- Chrome on Android, or Safari / Chrome on iOS.

## Pairing and CLI

While the daemon is running, you can manage pairing, status, and caches from another terminal (all admin subcommands also accept `--port <n>` for non-default instances):

- Rotate the pairing link and print a new QR code:
  ```bash
  pigeon pair
  ```
- Create a single-use pairing link that expires in 10 minutes:
  ```bash
  pigeon pair --ephemeral
  ```
- List paired browsers:
  ```bash
  pigeon devices
  ```
- Revoke a paired browser immediately:
  ```bash
  pigeon devices revoke <id>
  ```
- Show Herdr connection state, public URL, active sessions, queues, last usage scan, and source errors:
  ```bash
  pigeon status
  ```
- Rebuild the local token usage and cost cache from disk logs:
  ```bash
  pigeon rebuild-cache
  ```

## Build from source

```bash
bun install
bun run build
./dist/pigeon start
```

Or install `pigeon` onto your `PATH`:

```bash
install -m 755 dist/pigeon ~/.local/bin/pigeon
```

To run `pigeon` as a `systemd` user service and push updates seamlessly as you work, see [`docs/usage/README.md`](docs/usage/README.md).

## Development

- Run type-checking and the full automated test suite:
  ```bash
  bun test
  ```
- Run a development server on isolated test port `4101` (with Vite frontend dev proxy on `5173`):
  ```bash
  bun run dev:server   # daemon on :4101 (Tailscale HTTPS :18443)
  bun run dev          # Vite dev server on :5173
  ```
