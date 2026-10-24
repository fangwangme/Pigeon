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
   - **No manual code entry**: Pairing is completed exclusively by scanning this QR code with the mobile camera.
2. **Pairing Token Security**:
   - Time-to-Live (TTL): By default for personal Tailscale/LAN remote control, pairing links are non-expiring (permanent until manually rotated via `pigeon pair`). Ephemeral tokens with explicit TTL can be requested on demand.
   - Brute-Force Limit: Maximum 5 failed attempts per IP and globally, after which the token is revoked immediately.
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
   - The server verifies the token, generates a unique server-side `deviceId` (UUID v4), and sanitizes `deviceName` (max 32 characters, stripping ANSI and control characters).
   - The server sets a session cookie:
     ```http
     Set-Cookie: __Host-pigeon_session=<SESSION_TOKEN>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=31536000
     ```
   - The landing page executes `history.replaceState(null, '', '/')` to purge the token from browser history.

## 3. Unauthenticated Endpoint Whitelist

To eliminate unauthenticated attack surface, the HTTP server enforces an explicit route whitelist:
- **Permitted Unauthenticated**:
  - `GET /pair` (HTML landing page)
  - `GET /pair.js`, `GET /pair.css` (minimal assets required for the pair page)
  - `POST /api/pair` (rate-limited token exchange endpoint)
- **Strictly Authenticated**:
  - All other HTTP routes (`/api/*`, `/index.html`)
  - WebSocket upgrade requests (`/ws`) must present a valid `__Host-pigeon_session` cookie; otherwise, the upgrade is rejected with HTTP 401.

## 4. Host and Origin Validation

To protect against Cross-Site WebSocket Hijacking (CSWSH) and DNS Rebinding attacks:

- **Origin Check**: During the WebSocket HTTP upgrade handshake, the daemon verifies that the `Origin` header matches the configured `publicBaseUrl`. If mismatched, the handshake is aborted with HTTP 403.
- **Host Whitelist**: The `Host` header must match either `127.0.0.1`, `localhost`, or the host derived from `publicBaseUrl`.
- **Proxy Headers**: `X-Forwarded-*` headers are ignored unless `trustProxy` is explicitly enabled in `~/.config/pigeon/config.json` and the incoming connection originates strictly from loopback or configured CIDRs.

## 5. Local Admin Channel & Storage Security

- **Admin IPC Socket**: Daemon listens on `$XDG_RUNTIME_DIR/pigeon.sock` (mode `0600`).
  - `pigeon pair` communicates with this socket to request a new QR code token.
  - `pigeon devices revoke <id>` dispatches a revocation command over this socket, instructing the running daemon to drop the target's session and sever its active WebSocket connection immediately.
- **Disk Storage**:
  - Device registry is saved to `~/.local/state/pigeon/devices.json` with permissions `0600`.
  - Session tokens are stored solely as SHA-256 hashes.
- **Development Mode (`--insecure-dev`)**:
  - Binds to `0.0.0.0:4100` over plain HTTP.
  - Session cookie drops the `__Host-` prefix and `Secure` attribute, Web Push is disabled, and the console emits high-visibility security warnings.
