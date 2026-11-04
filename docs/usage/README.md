# Running Pigeon Day to Day

How to run Pigeon on your own machine and phone, and how to ship a fix to the phone while you use it. The behavior behind each step is in `docs/specs/`.

## Prerequisites

- The Herdr desktop app (`herdr-app`) open on this machine. Pigeon reads spaces and tabs from its window (`~/.config/herdr-app/herdr-app.sock`) and drives the terminals through Herdr Core (`$XDG_RUNTIME_DIR/herdr-core/default.sock`). With the window closed, the phone shows Herdr offline although the terminals keep running. The old terminal `herdr` is not supported.
- Tailscale on this machine and on the phone, both logged into the same tailnet. Tailscale gives the phone an HTTPS address, which the PWA install, the service worker and (later) Web Push need (`architecture.md` §4.2).
- Chrome on Android.

## One-time setup

1. Expose the daemon port over HTTPS inside the tailnet. With Tailscale 1.52 or newer:
   ```bash
   tailscale serve --bg 4100
   ```
   This proxies `https://<machine>.<tailnet>.ts.net` to `http://127.0.0.1:4100`. If `tailscale` asks for root, run `sudo tailscale set --operator=$USER` once.
2. Optional: pin the address in `~/.config/pigeon/config.json` (`"server": { "publicBaseUrl": "https://<machine>.<tailnet>.ts.net" }`). Without it, the daemon asks `tailscale status` at every start.
3. Build and install the binary:
   ```bash
   bun install
   bun run build
   install -m 755 dist/pigeon ~/.local/bin/pigeon
   ```
4. Run it as a user service, so it survives logout and restarts after a crash. Save this as `~/.config/systemd/user/pigeon.service`:
   ```ini
   [Unit]
   Description=Pigeon bridge for Herdr

   [Service]
   ExecStart=%h/.local/bin/pigeon start
   Restart=on-failure
   RestartSec=3

   [Install]
   WantedBy=default.target
   ```
   Then enable and start it:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now pigeon
   journalctl --user -u pigeon -f   # daemon log
   ```
5. Pair the phone: run `pigeon pair` in a terminal and scan the QR code with Chrome on the phone. Then use Chrome's "Add to Home screen" to install the PWA.

## Paired devices

- `pigeon devices` lists every paired browser. `pigeon devices revoke <deviceId>` cuts one off at once.
- `pigeon pair` replaces the pairing link. Browsers that already paired stay paired.
- Revoke the sessions left over from development before relying on the phone day to day.

## The use-and-fix loop

1. Use Pigeon on the phone. When something is wrong, note what you did and what you saw.
2. Fix it in a worktree, run `bun test`, then ship the new build:
   ```bash
   bun run build && install -m 755 dist/pigeon ~/.local/bin/pigeon && systemctl --user restart pigeon
   ```
3. The phone reconnects by itself. When the daemon now serves a different client build, the phone shows "有新版本可用 · 点击刷新"; tap it to load the new client (`protocol.md` §3.2). A standalone PWA has no reload button, so this banner is how an update reaches it.

## Without Tailscale

`pigeon start --insecure-dev` serves plain HTTP on the LAN and puts the LAN address in the pairing link. Use it only on a trusted network, and only to try things out: anyone on that network who gets the pairing link can control your terminals, and without HTTPS there is no service worker, no PWA install and no push.
