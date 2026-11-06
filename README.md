# Pigeon

Pigeon puts the coding agents running in [Herdr](https://herdr.dev) on your phone. Instead of pinching and zooming a raw terminal, you get a touch-first web app for **Claude Code**, **Codex**, **OpenCode**, **Antigravity**, and **pi**—see which agent is working and which is waiting on you, read what it did, answer its prompts, queue the next message, or start and resume sessions from your phone's browser.

A small daemon runs alongside Herdr on your computer, talks to Herdr over local Unix sockets, and serves the Progressive Web App (PWA) over your Tailscale network. Everything ships as a single compiled binary.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/home-dark.png">
    <img src="docs/images/home-light.png" width="200" alt="Home: every Herdr workspace with its tabs and agent status">
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/session-dark.png">
    <img src="docs/images/session-light.png" width="200" alt="A Claude Code session: the prompt, grouped tool calls and the answer">
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/answer-dark.png">
    <img src="docs/images/answer-light.png" width="200" alt="The agent's answer rendered as Markdown, with the reply box">
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/agents-dark.png">
    <img src="docs/images/agents-light.png" width="200" alt="All agents grouped by status">
  </picture>
</p>
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/commands-dark.png">
    <img src="docs/images/commands-light.png" width="200" alt="Typing / lists the agent's commands and skills">
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/resume-dark.png">
    <img src="docs/images/resume-light.png" width="200" alt="Resume a past session in a new tab">
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-dark.png">
    <img src="docs/images/settings-light.png" width="200" alt="Settings: appearance, language and paired devices">
  </picture>
</p>

## What it does

- **Every workspace at a glance.** Browse Herdr's workspaces and tabs with live status (`waiting for you`, `working`, `done`, `idle`, or plain terminal) and unread indicators for sessions that finished while you were away. Open **All agents** to see every active agent across workspaces grouped by state, or search and filter by status, agent, or name.
- **Conversations, not terminal scrollback.** Pigeon binds each agent pane to the agent's on-disk session log and renders prompts, Markdown replies, collapsible reasoning, grouped tool calls, file diffs, and task lists as a conversation. When a pane has no bound session log, Pigeon falls back to structured cards parsed from the terminal screen.
- **One-tap prompt cards.** When an agent pauses for permission, a multi-question prompt, or plan approval, a prompt card replaces the composer. Numbered choices on screen become tap buttons; prompts without numbered options (such as arrow-key menus or `y/n` prompts) open the terminal view instead of guessing keystrokes.
- **Keep the work moving.** Send messages (queued automatically by the daemon while the agent is working, with one-tap undo), attach photos or files from your phone, and insert project, user, plugin, or built-in `/` commands and skills. Stop a running turn at any time.
- **Raw terminal when you need it.** Inspect any pane's live screen and send `↑`, `↓`, `←`, `→`, `Enter`, `Esc`, `Tab`, or `Ctrl+C`. Plain shell tabs open directly in the terminal view and accept command lines from the composer.
- **New and resumed sessions.** Start an agent or shell in a new Herdr tab, or resume a past Claude Code, Codex, OpenCode, or pi session in a new tab. For agents that expose model lists (Claude Code and Codex), choose a model and reasoning effort at launch—or switch models mid-session in Claude Code. Rename or close tabs, and switch panes in multi-pane tabs, without moving desktop focus.
- **Your look, your language.** Light, dark, or system theme with a shared accent color and a per-phone **Reduce transparency** toggle for the Liquid Glass controls. The UI is in English or Simplified Chinese, following your browser language unless you pick one.

## How it works

```
Phone (Chrome PWA) ──HTTPS / WSS over Tailscale──▶ pigeon daemon ──Unix sockets──▶ Herdr App + Herdr Core
                                                        ├── reads agent session logs on disk
                                                        └── local admin socket ◀── pigeon CLI
```

- **Herdr bridge:** The daemon talks to the **Herdr App** (`herdr-app.sock`) for workspaces and tabs—listing, creating, renaming, and closing—and to **Herdr Core** (`herdr-core`) for terminal status events, screen reads, and input.
- **Session log binding:** Using the foreground process and working directory reported by Herdr Core, the daemon matches each agent pane to its local session store (JSONL or SQLite) and watches it for incremental updates.
- **QR-only pairing:** Your phone pairs by scanning a QR code printed in the terminal (`#code=...` in the URL fragment, never sent in HTTP headers or logs) in exchange for an `HttpOnly` session cookie. Paired browsers can be listed and revoked from the phone's Settings screen or via `pigeon devices`.

The full design and contracts live in [`docs/specs/`](docs/specs/).

## Requirements

- The [Herdr](https://herdr.dev) desktop app (`herdr-app` + `herdr-core`) running on your computer with its window open. (The older terminal-only `herdr` TUI is not supported.)
- [Bun](https://bun.sh) to build from source.
- [Tailscale](https://tailscale.com) on both the computer and the phone, logged into the same tailnet, so the phone gets an HTTPS origin.
- Chrome (or another modern Chromium browser) on Android. iOS Safari is not supported yet.

## Quick start

```bash
bun install
bun run build                        # builds the single binary at dist/pigeon
tailscale serve --bg 4100            # serves local port 4100 over HTTPS in your tailnet
./dist/pigeon start                  # starts the daemon and prints a pairing QR code
```

Scan the QR code with Chrome on your phone, then open the browser menu and choose **Add to Home screen** to install the app.

While the daemon is running, you can manage pairing and devices from another terminal (or directly in the app's **Settings**):

```bash
./dist/pigeon pair                   # rotate the pairing link and print a new QR code
./dist/pigeon pair --ephemeral       # print a single-use link that expires in 10 minutes
./dist/pigeon devices                # list paired browsers
./dist/pigeon devices revoke <id>    # revoke a paired browser immediately
./dist/pigeon status                 # show active session count and public URL
```

To install `pigeon` on your `PATH`, run it as a `systemd` user service, and ship updates to your phone while you use it, see [`docs/usage/README.md`](docs/usage/README.md).

## Status

Pigeon is early and changes quickly. Web Push keys, subscriptions, triggers, and presence suppression are built, but push delivery to the browser is not connected yet (the notification switches in Settings stay disabled until it lands). Run `bun test` to build the client, type-check the codebase, and run the test suite.
