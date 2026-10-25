# Web Push Notification Specification

## 1. Overview and Scope

Pigeon provides a Web Push notification subsystem to alert developers when an AI coding agent running in the background requires human intervention (e.g. state transitions from `working` to `blocked`).

This allows developers to pocket their mobile phone while a long-running agent performs autonomous tasks, receiving an instant haptic push notification the moment an authorization prompt or question dialog appears.

**Status (v0.1)**: Keys, subscriptions, triggers and presence suppression are implemented. **Delivery to the browser push service (RFC 8291 encryption and VAPID JWT) is not implemented yet**: a trigger computes whether it would be suppressed and reports `delivered: false`. Nothing in the UI claims that notifications work.

## 2. Push Delivery Constraints

- **Secure Context Required**: In accordance with W3C standards, Web Push operates exclusively over HTTPS (via Tailscale Serve or verified reverse proxies). On insecure HTTP (`--insecure-dev`), Web Push is disabled.
- **Client Platform**: Chrome / modern Chromium mobile browsers natively support Web Push without requiring home-screen installation.

## 3. Subscription Protocol

1. **VAPID Keys**: On first start, the daemon generates a P-256 keypair in `<stateDir>/vapid.json` (mode `0600`). The public key is the 65-byte uncompressed point in base64url, which is the form `PushManager.subscribe({ applicationServerKey })` accepts. A key file from older builds that holds an SPKI-encoded key is regenerated.
2. **Subscription Handshake**:
   - The client fetches the VAPID public key via `GET /api/push/vapid-public-key`.
   - The browser asks for notification permission and creates a `PushSubscription`.
   - The client sends it with `POST /api/push/subscribe` (session cookie required). The body must have a string `endpoint` and string `keys.p256dh` and `keys.auth`, or the request gets HTTP 400.
   - The daemon keeps subscriptions in memory, keyed by endpoint. Persisting them belongs with implementing delivery.

## 4. Notification Triggers and Presence Suppression

To prevent duplicate or irritating notifications:
1. **Trigger Condition**: Herdr reports a pane's agent status changing into `blocked` from any other status (`herdr-adapter.md` §3.2).
2. **Presence Suppression**: The notification is suppressed while any live connection reports (`presence_update`, `protocol.md` §2.1) that it is visible and viewing that pane. Presence is tracked per connection and dropped when the connection closes; a report older than the staleness window no longer counts.
3. **De-duplication**: At most one trigger per pane per 60 seconds.
4. **Payload Privacy**:
   - By default, the notification body contains **no raw command text** (e.g. `codex · x2 in Pigeon requires confirmation`).
   - Including command text is an opt-in toggle in `~/.config/pigeon/config.json`.
5. **Deep Linking**: Tapping the notification opens or focuses the Pigeon PWA and navigates directly to the targeted workspace, tab, and pane.
