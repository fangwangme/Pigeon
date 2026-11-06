# Pigeon

Pigeon puts the coding agents running in Herdr on your phone. You can see which agent is working and which is waiting for you, read what it did, answer its prompts, send the next message, or start a new session, all from the browser on your phone.

A small daemon runs next to Herdr on your computer. It serves a phone-first web app over your Tailscale network, and the whole thing ships as one binary.

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

- **Every workspace at a glance.** Herdr's workspaces and tabs, each with its agent's state: working, waiting for you, done or idle. All agents also appear in one list, grouped by state.
- **Readable sessions.** Pigeon reads the agent's own session log and shows prompts, answers, tool calls, file diffs and todos as a conversation. It supports Claude Code, Codex, OpenCode, Antigravity and pi.
- **Answer prompts.** When an agent asks for permission or a choice, its options become buttons. Anything Pigeon cannot render, you can handle in the terminal view.
- **Keep the work going.** Send messages (queued while the agent works), `/` commands and skills, photos and files, and switch the model. You can also stop the agent.
- **Raw terminal when you need it.** View any pane's screen and send arrow keys, Enter, Esc, Tab or Ctrl+C.
- **New and past sessions.** Start an agent in any workspace, or resume one of its past sessions in a new tab. Rename or close tabs.
- **Your look, your language.** Light, dark or follow the system, with an accent color. The UI is in English or Chinese, following the phone's language unless you pick one.

## How it works

```
Phone (PWA) ──HTTPS / WebSocket over Tailscale──▶ pigeon daemon ──Unix sockets──▶ Herdr app + Herdr Core
                                                      └── reads agent session logs on disk
```

- The daemon talks to the Herdr desktop app for workspaces and tabs, and to Herdr Core for the terminals.
- It reads each agent's session files to build the transcript.
- The phone pairs once by scanning a QR code, and each paired browser can be revoked.

The full design is in [`docs/specs/`](docs/specs/).

## Requirements

- The Herdr desktop app running on your computer.
- [Bun](https://bun.sh) to build.
- Tailscale on the computer and the phone, so the phone gets an HTTPS address.
- Chrome on Android. Other mobile browsers are not tested yet.

## Quick start

```bash
bun install
bun run build                        # builds dist/pigeon
tailscale serve --bg 4100            # HTTPS for the daemon inside your tailnet
./dist/pigeon start                  # prints a pairing QR code
```

Scan the QR code with your phone, then use "Add to Home screen" to install the app. Pair another phone later with `pigeon pair`. List paired devices with `pigeon devices`, and revoke one with `pigeon devices revoke <id>`.

To run it as a service and ship fixes to your phone while you use it, see [`docs/usage/README.md`](docs/usage/README.md).

## Status

Pigeon is early and changes quickly. Push notifications are designed but not delivered yet. Use `bun test` to run every check.
