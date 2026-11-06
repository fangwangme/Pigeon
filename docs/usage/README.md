# Running Pigeon Day to Day

How to run Pigeon on your computer and phone, manage paired devices, and ship fixes to your phone while using it. The contracts behind each step live in [`docs/specs/`](../specs/).

## Prerequisites

- The Herdr desktop app (`herdr-app`) open on this machine. Pigeon reads workspaces and tabs from the App window socket (`$HERDR_APP_HOME/herdr-app.sock`, defaulting to `~/.config/herdr-app/herdr-app.sock`) and drives terminals through Herdr Core (`$HC_TERMINAL_SOCKET`, defaulting to `$XDG_RUNTIME_DIR/herdr-core/default.sock`). When the Herdr window is closed, the phone shows Herdr offline even though Herdr Core keeps terminals running. The older terminal-only `herdr` is not supported.
- Tailscale on this machine and on the phone, both logged into the same tailnet. Tailscale provides a trusted HTTPS origin, which PWA installation, the service worker, and Web Push require (`architecture.md` §4.2).
- Chrome (or another modern Chromium browser) on Android.

## One-time setup

1. Expose the daemon port over HTTPS inside your tailnet:
   ```bash
   tailscale serve --bg 4100
   ```
   This proxies `https://<machine>.<tailnet>.ts.net` to local port `4100`. If `tailscale` asks for root, run `sudo tailscale set --operator=$USER` once.
2. Optional: pin the address in `~/.config/pigeon/config.json` (or `$XDG_CONFIG_HOME/pigeon/config.json`):
   ```json
   {
     "server": {
       "publicBaseUrl": "https://<machine>.<tailnet>.ts.net"
     }
   }
   ```
   Without this setting, the daemon queries `tailscale status --json` at every start.
3. Build and install the binary onto your `PATH`:
   ```bash
   bun install
   bun run build
   install -m 755 dist/pigeon ~/.local/bin/pigeon
   ```
4. Run it as a `systemd` user service so it restarts automatically after a crash. Save this as `~/.config/systemd/user/pigeon.service`:
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
   journalctl --user -u pigeon -f   # follow daemon logs
   ```
5. Pair your phone: run `pigeon pair` in a terminal and scan the QR code with Chrome on the phone. Once paired, open Chrome's menu and choose **Add to Home screen** to install the PWA.

## Paired devices

- `pigeon devices` lists every paired browser, and `pigeon devices revoke <deviceId>` cuts one off immediately. You can also view and remove paired devices from **Settings → Devices and pairing** on the phone (`protocol.md` §4.12).
- `pigeon pair` rotates the active pairing link (`--ephemeral` creates a single-use link that expires in 10 minutes). Browsers that are already paired stay paired.
- `pigeon status` prints the active session count and `publicBaseUrl`.
- Revoke any sessions left over from development before relying on Pigeon day to day.

## The use-and-fix loop

1. Use Pigeon on your phone. When something is wrong, note what you did and what you saw.
2. Fix it in a worktree, run `bun test`, and deploy the new build:
   ```bash
   bun run build && install -m 755 dist/pigeon ~/.local/bin/pigeon && systemctl --user restart pigeon
   ```
3. The phone reconnects automatically. When the restarted daemon serves a different client build (`welcome.buildId`), the app shows an **`Update available · Reload`** banner (in Chinese, **`有新版本 · 重新加载`**); tap it to load the new client (`protocol.md` §3.2). Because a standalone PWA has no browser reload button, this banner is how updates reach an installed phone app.

## Without Tailscale

`pigeon start --insecure-dev` serves plain HTTP on your local network and puts your machine's private LAN address into the pairing link. Use it only on a trusted network to try things out: anyone on that network who gets the pairing link can control your terminals, and without HTTPS there is no service worker, no PWA installation, and no Web Push.
