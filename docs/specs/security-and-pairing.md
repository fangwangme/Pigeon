# Security and Device Pairing Specification

## 1. Threat Model and Security Philosophy

Pigeon grants remote control capabilities over local terminal panes and shell environments. Consequently, security boundaries must be strictly defended even on private local networks:

- **Zero Unauthenticated Trust**: There is no "LAN bypass" or "unauthenticated local subnet" mode. Every HTTP API call and WebSocket connection requires a valid, verified device credential.
- **Physical Proximity Pairing**: Initial pairing requires physical or console access to the machine running the daemon.

## 2. Pairing Workflow (QR Code Only)

To prevent manual input errors, brute-force enumeration, and accidental disclosure:

1. **Generation**:
   - Running `pigeon pair` (or upon initial `pigeon start`) generates a cryptographically secure 128-bit random token encoded in Base32 (26 characters).
   - The CLI renders an ASCII QR code in the terminal encoding:
     `https://<publicBaseUrl>/pair#code=<BASE32_TOKEN>`
   - **No manual code entry**: Pairing is completed exclusively by scanning this QR code with the mobile camera. The app offers no field to type a code (user decision, 2026-10-25).
2. **Pairing Token Security**:
   - Time-to-Live (TTL): By default for personal Tailscale/LAN remote control, pairing links are non-expiring (permanent until manually rotated via `pigeon pair`). Ephemeral tokens with explicit TTL can be requested on demand.
   - Brute-Force Limit: After 5 failed attempts against the active token (counted globally, not per IP), the token is revoked. A new one needs `pigeon pair` on the machine.
   - Verification: Constant-time comparison (`crypto.timingSafeEqual`) to prevent timing side-channel attacks.
   - Credential Exchange: Scanned URL Fragment `#code=` exchanged for a 1-year persistent session cookie `__Host-pigeon_session`.
3. **URL Fragment Confidentiality**:
   - The `#code=...` fragment is **never transmitted across the wire** to the server in HTTP request headers or logged in reverse proxy access logs.
   - It is read client-side via JavaScript (`location.hash`) on the landing page.
4. **Credential Exchange**:
   - The landing page sends `POST /api/pair`:
     ```json
     { "code": "<BASE32_TOKEN>", "deviceName": "My Phone" }
     ```
   - The body is validated (`code` a string of at most 64 characters, optional `deviceName` a string of at most 128). A malformed body gets HTTP 400.
   - The server verifies the token, generates a unique server-side `deviceId` (UUID v4), and sanitizes `deviceName` (max 32 characters, stripping ANSI and control characters).
   - The server sets a session cookie:
     ```http
     Set-Cookie: __Host-pigeon_session=<SESSION_TOKEN>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=31536000
     ```
   - Before sending the code, the landing page executes `history.replaceState(null, '', '/')` to purge the token from browser history.
5. **Unpaired app**: When `GET /api/auth/status` says the browser is not paired, the app shows pairing guidance (scan the QR code printed by `pigeon pair`) instead of connecting.

## 3. Unauthenticated Endpoint Whitelist

The HTTP server answers only the routes below. Every other path is 404, and nothing is served from the filesystem: the HTML is the single-file bundle compiled into the binary.
- **Permitted Unauthenticated** (no user or terminal data):
  - `GET /`, `/index.html` and `/pair`: the same single-file app shell. It holds no data until a paired WebSocket is open, and it must load in order to run the pairing exchange.
  - `GET /manifest.webmanifest`, `/sw.js`, `/icon.svg`, `/icon-192.png`, `/icon-512.png`: PWA install assets.
  - `POST /api/pair`: the rate-limited token exchange.
  - `GET /api/auth/status`: whether this browser's cookie is a valid session.
  - `GET /api/version` and `GET /api/push/vapid-public-key`: public constants.
- **Strictly Authenticated**:
  - `POST /api/push/subscribe` (HTTP 401 without a session).
  - WebSocket upgrades (`/ws`) must present a valid session cookie; otherwise the upgrade is rejected with HTTP 401. A session token in the query string is not accepted.

## 4. Host and Origin Validation

To protect against Cross-Site WebSocket Hijacking (CSWSH) and DNS Rebinding attacks:

Both checks run on the WebSocket upgrade, before the session check:
- **Origin Check**: The `Origin` header must be present and must equal, exactly (scheme, host and port), the origin of `publicBaseUrl`. In `--insecure-dev`, the origins `http://{localhost,127.0.0.1,[::1]}` on the daemon port and on the Vite dev port 5173 are also accepted, as is the LAN host on port 5173. Anything else is HTTP 403.
- **Host Whitelist**: The host name in `Host`, compared without its port and with IPv6 brackets kept, must be `localhost`, `127.0.0.1`, `[::1]`, or the host of `publicBaseUrl`. Anything else is HTTP 403. This defeats DNS rebinding.
- **Proxy Headers**: `X-Forwarded-*` headers are ignored.

## 5. Local Admin Channel & Storage Security

- **Admin IPC Socket**: Daemon listens on `$XDG_RUNTIME_DIR/pigeon.sock`, or `<stateDir>/admin.sock` without `XDG_RUNTIME_DIR` (mode `0600`). The path is resolved from the environment at every start.
  - If the socket already answers, another daemon is running and startup fails. A stale socket file nobody answers on is replaced. A daemon removes only a socket it created.
  - `pigeon start` reuses the active pairing token for its QR code; `pigeon pair` rotates it (`--ephemeral` for a single-use, 10-minute token).
  - `pigeon pair` communicates with this socket to request a new QR code token.
  - `pigeon devices revoke <id>` dispatches a revocation command over this socket, instructing the running daemon to drop the target's session and sever its active WebSocket connection immediately.
- **Disk Storage**:
  - Device registry is saved to `<stateDir>/devices.json` (`$XDG_STATE_HOME/pigeon` or `~/.local/state/pigeon`) with permissions `0600`, written atomically.
  - Session tokens are stored solely as SHA-256 hashes.
  - A registry that cannot be parsed stops startup with an error naming the file. It is never silently replaced, because that would unpair every device.
- **Bind Address**: The daemon listens dual-stack on every interface (user decision, 2026-10-25), unless `server.host` in `config.json` pins one address. Being reachable is not being trusted: every WebSocket still needs an allowed Host, the exact Origin and a session cookie (§3, §4).
- **Development Mode (`--insecure-dev`)**:
  - Listens on every interface (dual-stack) over plain HTTP. The pairing link uses the first private LAN IPv4 found on a physical interface, or `--public-url`.
  - Session cookie drops the `__Host-` prefix and `Secure` attribute, Web Push is disabled, and the console emits high-visibility security warnings.
