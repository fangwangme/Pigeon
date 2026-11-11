<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/icon-dark.svg">
    <img src="public/icon-light.svg" width="120" height="120" alt="Pigeon — bionic AI messenger pigeon carrying a >_ terminal envelope">
  </picture>
</p>

# Pigeon

Pigeon puts the coding agents running in [Herdr](https://herdr.dev) on your phone. Instead of pinching and zooming a terminal, you get a mobile web app for **Claude Code**, **Codex**, **OpenCode**, **Antigravity**, and **pi**. Check which agent is working or waiting on you, read its changes, answer prompts with a tap, queue your next message, or start and resume sessions from the couch.

A small daemon runs alongside Herdr on your computer and serves the app over your Tailscale network. Everything compiles into a single binary.

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
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/session-dark.png">
    <img src="docs/images/session-light.png" width="260" alt="Follow along in a clean chat feed with tasks and tool calls">
  </picture>
</p>
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/prompt-dark.png">
    <img src="docs/images/prompt-light.png" width="260" alt="Approve command permissions and answer questions with a tap">
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/diff-dark.png">
    <img src="docs/images/diff-light.png" width="260" alt="Inspect per-file additions, deletions, and unified patch diffs">
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/queue-dark.png">
    <img src="docs/images/queue-light.png" width="260" alt="Queue follow-up prompts while an agent works, with instant undo">
  </picture>
</p>
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/commands-dark.png">
    <img src="docs/images/commands-light.png" width="260" alt="Trigger slash commands and project skills right from the composer">
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

Install Pigeon globally with **npm**:

```bash
npm install -g @fangwangme/pigeon
```

Or with **bun**:

```bash
bun add -g @fangwangme/pigeon
```

Or run it directly without installing:

```bash
npx @fangwangme/pigeon
```

```bash
bunx @fangwangme/pigeon
```

Then expose it to your tailnet:

```bash
tailscale serve --bg 4100
```

And start the daemon (prints a pairing QR code):

```bash
pigeon start
```

Scan the QR code with Chrome on your phone, then open the browser menu and choose **Add to Home screen** to install the app.

Prebuilt binaries are published for macOS (Apple Silicon and Intel) and Linux (x64 and arm64); npm or bun picks the one for your machine. On other platforms, [build from source](#build-from-source). See [Requirements](#requirements) for Herdr, Tailscale, and the phone browser.

## What it does

- **Every workspace at a glance.** Browse your Herdr workspaces and tabs with live status (`waiting for you`, `working`, `done`, `idle`, or plain terminal) and unread dots for sessions that finished while you were away. Open **All agents** to see every active agent across workspaces grouped by state, or search and filter by status, agent, or name.
- **Conversations, not terminal scrollback.** Prompts, Markdown replies, collapsible reasoning, grouped tool calls, file diffs, and task lists read like a chat thread, backed by each agent's own session log. If a pane doesn't have a session log yet, Pigeon parses the terminal screen into clean cards instead.
- **Answer prompts with a tap.** When an agent pauses for permission, asks a question, or waits on a plan, a prompt card takes the place of the reply box. Numbered choices become tap buttons; arrow-key menus and `y/n` prompts open the terminal sheet so Pigeon never guesses keystrokes.
- **Keep the work moving.** Reply at any time—if the agent is still working, your message queues until the turn finishes (with one-tap undo). Attach photos or files from your phone, insert `/` commands and skills from your project or user config, or stop a turn mid-flight.
- **A real terminal when you need one.** Peek at any pane's live screen and send arrow keys, `Enter`, `Esc`, `Tab`, or `Ctrl+C`. Plain shell tabs open straight to the terminal view and let you run commands from the reply box.
- **Start, resume, and manage tabs.** Launch an agent or shell in a new Herdr tab, or pick up a past Claude Code, Codex, OpenCode, or pi session where you left off. Pick the model and reasoning effort for Claude Code or Codex (and switch models mid-session in Claude Code). Rename or close tabs and switch between panes without disturbing focus on your computer.
- **Light, dark, English, or Chinese.** Follow your system theme or pick light or dark with a shared accent color, plus a per-phone **Reduce transparency** toggle if you prefer solid panels over glass. Available in English and Simplified Chinese.

### Visual identity

<p align="center">
  <img src="public/icon-dark.svg" width="128" height="128" alt="Pigeon icon — Dark Mode">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="public/icon-light.svg" width="128" height="128" alt="Pigeon icon — Light Mode">
</p>

Pigeon's emblem is a faceted bionic messenger pigeon in flight—sculpted from warm titanium-ceramic armor plates, a glowing hexagonal AI optical visor, and solar-orange wings traced with a neural pulse circuit—carrying a green `>_` terminal envelope beneath its beak. It captures what Pigeon does at a glance: an autonomous courier ferrying prompts, approvals, and replies between your phone and the terminal coding agents on your desk, with dedicated **Dark** (`public/icon-dark.svg`) and **Light** (`public/icon-light.svg`) palettes that adapt across the README, browser favicon (`public/icon.svg`), pairing screen, and new-session view.

## How it works

```
Phone (Chrome PWA) ──HTTPS / WSS over Tailscale──▶ pigeon daemon ──Unix sockets──▶ Herdr App + Herdr Core
                                                        ├── reads agent session logs on disk
                                                        └── local admin socket ◀── pigeon CLI
```

- **Two local sockets to Herdr.** The daemon talks to the **Herdr App** (`herdr-app.sock`) to list, create, rename, and close tabs, and to **Herdr Core** (`herdr-core`) to subscribe to terminal status events, read screens, and send input.
- **Live session logs.** From the foreground process and working directory Herdr Core reports, the daemon pairs each agent pane with the agent's own session file on disk (JSONL or SQLite) and tails it as new turns arrive.
- **QR pairing.** Scan the QR code printed in your terminal to pair a phone. The one-time code travels in the URL fragment (`#code=...`, so it never appears in HTTP headers or server logs) and is exchanged for an `HttpOnly` session cookie. You can view or revoke paired phones anytime from Settings or `pigeon devices`.

The full design and contracts live in [`docs/specs/`](docs/specs/).

## Requirements

- The [Herdr](https://herdr.dev) desktop app (`herdr-app` + `herdr-core`) running on your computer with its window open. (The older terminal-only `herdr` TUI is not supported.)
- [Node.js](https://nodejs.org) or [Bun](https://bun.sh) to install from npm, or Bun to build from source.
- [Tailscale](https://tailscale.com) on both your computer and your phone, signed into the same tailnet, so the phone gets a trusted HTTPS address for Web Push and PWA install. See the [Tailscale Setup Guide](docs/usage/tailscale.md) for step-by-step HTTPS configuration, firewall rules, and mobile pairing.
- Chrome on Android, or Safari / Chrome on iOS.

## Pairing and devices

While the daemon is running, you can manage pairing and devices from another terminal (or from **Settings** in the app):

- Rotate the pairing link and print a new QR code:
  ```bash
  pigeon pair
  ```
- Print a single-use link that expires in 10 minutes:
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
- Show active session count and public URL:
  ```bash
  pigeon status
  ```
- Rebuild the token usage and cost cache from scratch:
  ```bash
  pigeon rebuild-cache
  ```

## Build from source

```bash
bun install
bun run build
tailscale serve --bg 4100
./dist/pigeon start
```

To put `pigeon` on your `PATH`, keep it running with `systemd`, and push updates to your phone as you work, see [`docs/usage/README.md`](docs/usage/README.md). For HTTPS certificates and remote access setup, see the [`Tailscale Setup Guide`](docs/usage/tailscale.md).

## Status

Pigeon is early and moving fast. Web Push key generation, subscriptions, triggers, and presence checks are in place, but push delivery to the browser isn't wired up yet (the notification toggles in Settings stay disabled for now). Run `bun test` to build the client, type-check the repo, and run the test suite.
