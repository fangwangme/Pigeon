# Web Push Notification Specification

## 1. Overview and Scope

Pigeon provides a Web Push notification subsystem to alert developers when an AI coding agent running in the background requires human intervention (e.g. state transitions from `working` to `blocked`).

This allows developers to pocket their mobile phone while a long-running agent performs autonomous tasks, receiving an instant haptic push notification the moment an authorization prompt or question dialog appears.

## 2. Push Delivery Constraints

- **Secure Context Required**: In accordance with W3C standards, Web Push operates exclusively over HTTPS (via Tailscale Serve or verified reverse proxies). On insecure HTTP (`--insecure-dev`), Web Push is disabled.
- **Client Platform**: Chrome / modern Chromium mobile browsers natively support Web Push without requiring home-screen installation.

## 3. Subscription Protocol

1. **VAPID Keys**: Upon first startup, the Pigeon daemon generates an application server VAPID keypair (`~/.local/state/pigeon/vapid.json`, mode `0600`).
2. **Subscription Handshake**:
   - The client fetches the VAPID public key via `GET /api/push/vapid-key`.
   - The browser prompts for notification permissions and requests a `PushSubscription` from the browser vendor's push service.
   - The client transmits the subscription via WebSocket:
     ```json
     {
       "type": "push_subscribe",
       "id": "cmd_201",
       "payload": {
         "endpoint": "https://fcm.googleapis.com/fcm/send/...",
         "keys": {
           "p256dh": "BNc...",
           "auth": "tB..."
         }
       }
     }
     ```
   - The daemon stores the subscription mapped to the verified `deviceId` in `~/.local/state/pigeon/push.json` (mode `0600`).

## 4. Notification Triggers and Presence Suppression

To prevent duplicate or irritating notifications:
1. **Trigger Condition**: An agent transitions from a non-blocked state (`working` or `idle`) into the `blocked` state.
2. **Presence Suppression**: The notification is dispatched **only if** there is no active WebSocket client with `isVisible === true` currently viewing the targeted `paneId`.
3. **De-duplication**: Repeated triggers for the same `interactionId` within 60 seconds are suppressed.
4. **Payload Privacy**:
   - By default, the notification body contains **no raw command text** (e.g. `codex · x2 in Pigeon requires confirmation`).
   - Including command text is an opt-in toggle in `~/.config/pigeon/config.json`.
5. **Deep Linking**: Tapping the notification opens or focuses the Pigeon PWA and navigates directly to the targeted workspace, tab, and pane.
