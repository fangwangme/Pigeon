# Web Push Notification Specification

## 1. Overview and Scope

Pigeon alerts the user's phone when an agent needs them (its status changes into `blocked`) and, when the user turns it on, when an agent finishes (`done`). The phone can stay in a pocket while a long task runs.

Delivery uses the standard Web Push protocol: RFC 8291 message encryption (`aes128gcm`, RFC 8188) and RFC 8292 VAPID authentication, implemented with `node:crypto` (user decision, 2026-10-25: no `web-push` dependency).

## 2. Push Delivery Constraints

- **Secure context required**: Web Push works only in secure mode (`architecture.md` §4.2). In the plain HTTP modes there is no Service Worker, and the Settings switches say why (`mobile-ui-and-themes.md` §8.1).
- **iOS**: iOS 16.4 or later delivers Web Push only to the home-screen PWA. In a Safari tab the switches say to add the app to the home screen first. Permission is requested from the user's tap on a switch, as iOS requires.
- **Chromium**: Chrome and modern Chromium mobile browsers deliver to a browser tab as well.

## 3. Subscription Protocol

1. **VAPID keys**: on first start, the daemon generates a P-256 keypair in `vapid.json` in the instance's state directory (mode `0600`). The public key is the 65-byte uncompressed point in base64url, the form `PushManager.subscribe({ applicationServerKey })` accepts.
2. **Handshake**:
   - Turning a push switch on fetches `GET /api/push/vapid-public-key`, asks for notification permission, calls `PushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, and sends the result with `POST /api/push/subscribe` (session cookie required).
   - The body is `{ "endpoint", "keys": { "p256dh", "auth" }, "events": { "blocked": bool, "done": bool } }`. `endpoint` must be an absolute `https:` or `http:` URL, `keys.p256dh` the base64url of a 65-byte point, `keys.auth` the base64url of 16 bytes, and `events` two booleans, or the request gets HTTP 400 (trust boundary).
   - Turning every switch off sends `POST /api/push/unsubscribe` with the endpoint and calls `PushSubscription.unsubscribe()`.
3. **Storage**: subscriptions are stored in `push-subscriptions.json` in the instance's state directory (mode `0600`, written atomically), keyed by endpoint, each with the `deviceId` of the session that posted it and its `events`. A device has at most one subscription; a new one replaces it. Revoking a device (`security-and-pairing.md` §5, `protocol.md` §4.12) deletes its subscription. A file that cannot be parsed stops startup with an error naming it.

## 4. Notification Triggers and Presence Suppression

1. **Triggers**: Herdr reports a pane's agent status changing into `blocked` from any other status (`herdr-adapter.md` §3.2, including changes found by a snapshot, §3.1); and changing into `done`, for subscriptions whose `events.done` is on. `events.blocked` likewise gates the first trigger.
2. **Presence suppression**: a notification is not sent while any live connection reports (`presence_update`, `protocol.md` §2.1) that it is visible and viewing that pane. Presence is tracked per connection and dropped when the connection closes; a report older than the staleness window no longer counts.
3. **De-duplication**: at most one notification per pane and event per 60 seconds.
4. **Payload privacy**:
   - The push message carries data, not text: `{ "event", "agent", "workspace", "tab", "paneId" }`. The service worker composes the title and body in the language the phone last used (`mobile-ui-and-themes.md` §10), e.g. title `Claude Code 等你确认`, body `Pigeon · auth tests`.
   - It never carries command or prompt text.
5. **Deep linking**: tapping the notification focuses an open Pigeon window, or opens one, and navigates to that pane.

## 5. Delivery

- **Request**: `POST <endpoint>` with the encrypted payload as the body and the headers `Content-Encoding: aes128gcm`, `Content-Type: application/octet-stream`, `TTL: 3600`, `Urgency: high`, and `Authorization: vapid t=<JWT>, k=<public key>`.
- **Encryption** (RFC 8291): a fresh P-256 key pair and a 16-byte salt per message; ECDH with the subscription's `p256dh`; HKDF with its `auth` secret; one `aes128gcm` record (record size 4096) with the padding delimiter.
- **VAPID JWT** (RFC 8292): ES256 over `{ "aud": <endpoint origin>, "exp": <now + 12 h>, "sub": <publicBaseUrl origin> }`. The daemon caches a JWT per audience until one hour before it expires.
- **Responses**: 2xx is delivered. 404 or 410 means the subscription is gone: it is deleted. Any other status or a network failure is logged with the push service's host and status, and the notification is dropped (no retry: a late "waiting for you" is noise).
- Delivery runs off the status-event path, so a slow push service never delays the queue or viewers.

## 6. Settings

The phone's settings (`mobile-ui-and-themes.md` §8.1) show one switch per event: **等你确认** (`blocked`, on by default once push is allowed) and **完成时** (`done`). They belong to this device's subscription. When push cannot work here (plain HTTP mode, iOS outside the home-screen app, permission denied), the switches are disabled with a note saying which.
