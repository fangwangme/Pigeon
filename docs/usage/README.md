# Running Pigeon Day to Day

How to set up Pigeon for daily use, manage paired phones, and ship changes to your phone while you use it. For the design and protocol specs, see [`docs/specs/`](../specs/).

## Prerequisites

- The Herdr desktop app (`herdr-app`) running with its window open. Pigeon gets workspaces and tabs from the App socket (`$HERDR_APP_HOME/herdr-app.sock`, or `~/.config/herdr-app/herdr-app.sock` by default) and talks to terminals through Herdr Core (`$HC_TERMINAL_SOCKET`, or `$XDG_RUNTIME_DIR/herdr-core/default.sock` by default). Closing the Herdr window leaves Herdr Core's terminals alive, but Pigeon will show Herdr as offline until the window is open again. The older terminal-only `herdr` TUI is not supported.
- Tailscale on both this machine and your phone, signed into the same tailnet. Tailscale gives Pigeon a trusted HTTPS origin, which browsers require for PWA installation, service workers, and Web Push.
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

- `pigeon devices` lists every paired browser, and `pigeon devices revoke <deviceId>` disconnects one right away. You can also view and remove paired phones from **Settings → Devices and pairing** in the app.
- `pigeon pair` rotates the pairing link and prints a fresh QR code (`--ephemeral` makes a single-use link that expires in 10 minutes). Phones that are already paired stay connected.
- `pigeon status` shows the active session count and public URL.
- Clean up any test sessions left over from development before using Pigeon day to day.

## Updating while you use it

1. When you spot something to fix on your phone, make the change in a git worktree and run `bun test`.
2. Build, install, and restart the service:
   ```bash
   bun run build && install -m 755 dist/pigeon ~/.local/bin/pigeon && systemctl --user restart pigeon
   ```
3. Your phone reconnects on its own. When the restarted daemon serves a newer client build, the app shows an **`Update available · Reload`** banner (**`有新版本 · 重新加载`** in Chinese). Tap it to reload into the new build—standalone PWAs don't have a browser refresh button, so this banner is how updates reach an installed app.

## Without Tailscale

`pigeon start --insecure-dev` serves plain HTTP on your local network and puts your machine's private LAN address into the pairing link. Use it only on a trusted network to try things out: anyone on that network who gets the pairing link can control your terminals, and without HTTPS there is no service worker, no PWA installation, and no Web Push.
