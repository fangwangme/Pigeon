# Tailscale Setup and Networking Guide

This guide walks you through setting up [Tailscale](https://tailscale.com) for Pigeon, enabling trusted HTTPS with automatic SSL certificates, configuring local firewalls, and connecting your phone from cellular or external networks.

---

## Why Tailscale?

Pigeon is designed to pair your desktop AI coding agents with your phone wherever you are. Modern mobile browsers (iOS Safari, Android Chrome) enforce strict security boundaries:
- **Web Push Notifications**: Background push notifications require a secure context (`window.isSecureContext` / `https://`). Unencrypted `http://` connections completely disable Web Push.
- **PWA Installation**: Adding Pigeon to your phone's Home Screen for a fullscreen, address-bar-free app experience requires HTTPS.
- **Zero Public Port Exposure**: Tailscale creates an end-to-end encrypted wireguard mesh network (tailnet). You never need to open ports on your home router or expose your computer to the public internet.

---

## Prerequisites

1. **Install Tailscale** on both your computer and mobile phone:
   - Linux: `curl -fsSL https://tailscale.com/install.sh | sh`
   - iOS: [Tailscale on the App Store](https://apps.apple.com/app/tailscale/id1470499037)
   - Android: [Tailscale on Google Play](https://play.google.com/store/apps/details?id=com.tailscale.ipn)
2. **Sign into the same Tailscale account** on both devices so they join the same tailnet.
3. Verify on your computer:
   ```bash
   tailscale status
   ```
   Both your machine and phone should appear in the peer list.

---

## Step 1: Enable HTTPS & MagicDNS in Tailscale Console

Tailscale provides free, auto-renewed Let's Encrypt SSL certificates for your machine's MagicDNS name (`https://<node-name>.<tailnet>.ts.net`).

1. Open your **[Tailscale Admin Console → DNS Settings](https://login.tailscale.com/admin/dns)**:
   - Ensure **MagicDNS** is **Enabled**.
   - Under **HTTPS Certificates**, click **Enable HTTPS Certificates**.
2. Enable **Tailscale Serve** on your tailnet:
   - Visit: **[https://login.tailscale.com/f/serve](https://login.tailscale.com/f/serve)** and click **Enable**.

---

## Step 2: Grant Tailscale Operator Permissions (Linux)

By default, modifying Tailscale Serve configuration requires `sudo`. To allow your normal user account to manage Serve seamlessly:

```bash
sudo tailscale set --operator=$USER
```

---

## Step 3: Configure Linux Firewall (UFW)

If you have a local firewall active (such as `ufw` on Linux), incoming traffic on the Tailscale virtual interface might be blocked by default:

```bash
# Allow all incoming connections on the Tailscale network interface
sudo ufw allow in on tailscale0
```

> **Why this is needed**: Tailscale peers communicate using CGNAT addresses (`100.64.0.0/10`). If UFW only allows local subnets (e.g., `192.168.1.0/24`), connections from your phone over Tailscale will be silently dropped.

---

## Step 4: Start Tailscale Serve (HTTPS Reverse Proxy)

Tailscale Serve listens on standard port 443 with a trusted SSL certificate and forwards decrypted traffic to Pigeon's local port `4100`:

```bash
tailscale serve --bg 4100
```

Verify that the proxy is active:
```bash
tailscale serve status
```

You should see output similar to:
```text
https://<machine>.<tailnet>.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:4100
```

---

## Step 5: Start Pigeon and Pair Your Phone

Start Pigeon in production mode:

```bash
pigeon start
```

Pigeon automatically queries `tailscale status --json`, detects that Tailscale Serve is proxying to port `4100`, binds securely to loopback `127.0.0.1`, and prints the pairing QR code:

```text
Pairing URL: https://<machine>.<tailnet>.ts.net/pair#code=...
```

1. **On your phone**: Open the **Tailscale App** and ensure the VPN switch is **Connected**.
2. **Scan the QR Code**: Use your phone's camera or browser to open the pairing URL.
3. **Install PWA**:
   - **iOS Safari**: Tap the **Share** button → **Add to Home Screen**.
   - **Android Chrome**: Tap the menu (⋮) → **Add to Home screen** / **Install app**.
4. **Enable Notifications**: In Pigeon Settings, enable notification toggles for task completion and input approvals.

---

## Development and Test Instances (Port 4101)

When running development or test instances on port `4101`:
```bash
bun ./src/cli/index.ts start --port 4101
```

- Port `4101` automatically falls back to **Tailscale IP mode** (`http://<tailscale-ip>:4101`) or MagicDNS HTTP without conflicting with production port 443.
- Both Tailscale IP and MagicDNS hostnames are accepted by Pigeon's WebSocket host/origin security gates.

---

## Troubleshooting & FAQ

### 1. Connection Refused on `https://<machine>.<tailnet>.ts.net`
- Verify Tailscale Serve is running: `tailscale serve status`.
- If `No serve config` appears, run `tailscale serve --bg 4100`.
- Verify the Pigeon daemon is running: `pigeon status` or `curl -I http://127.0.0.1:4100`.

### 2. "Cannot establish a secure connection" / SSL Protocol Error
- This occurs if you attempt to access an HTTP port using `https://` (for example, navigating to `https://100.120.x.x:4101`).
- For port 4100 (Serve mode), use `https://<machine>.<tailnet>.ts.net` without port.
- For plain HTTP ports, ensure the URL scheme is `http://`, not `https://`.

### 3. Phone cannot reach computer / Timeout
- Open the **Tailscale App** on your phone. iOS often disconnects VPN tunnels after prolonged sleep or low-power mode; ensure the status says **Connected**.
- Check if your Linux firewall blocks Tailscale traffic: run `sudo ufw allow in on tailscale0`.
- Test connectivity from computer to phone: `tailscale ping <phone-name-or-ip>`.
