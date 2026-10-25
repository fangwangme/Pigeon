import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPairSync } from "node:crypto";

export interface PushSubscriptionData {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface ClientPresence {
  isVisible: boolean;
  viewingPaneId: string | null;
  lastUpdated: number;
}

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url — the form `PushManager.subscribe` expects. */
  publicKey: string;
  /** PKCS#8 PEM. */
  privateKey: string;
}

const PRESENCE_STALE_MS = 60_000;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Presence tracking, VAPID keys and push subscriptions.
 *
 * Web Push delivery (RFC 8291 payload encryption + RFC 8292 VAPID JWT) is not implemented yet:
 * `sendNotification` reports `delivered: false` instead of pretending to send.
 */
export class PushManager {
  private vapidKeys: VapidKeys;
  private subscriptions = new Map<string, PushSubscriptionData>(); // endpoint -> subscription
  private presence = new Map<string, ClientPresence>(); // connectionId -> presence

  constructor(private vapidPath: string) {
    this.vapidKeys = this.loadOrCreateVapidKeys();
  }

  private loadOrCreateVapidKeys(): VapidKeys {
    if (existsSync(this.vapidPath)) {
      const data = JSON.parse(readFileSync(this.vapidPath, "utf-8"));
      // Files from older builds stored an SPKI DER key, which browsers reject; regenerate those.
      if (typeof data.publicKey === "string" && /^[A-Za-z0-9_-]{87}$/.test(data.publicKey) && data.privateKey) {
        chmodSync(this.vapidPath, 0o600);
        return data;
      }
    }

    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "jwk" } as any,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }) as unknown as { publicKey: { x: string; y: string }; privateKey: string };

    const point = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(publicKey.x, "base64url"),
      Buffer.from(publicKey.y, "base64url"),
    ]);
    const keys: VapidKeys = { publicKey: base64url(point), privateKey };

    mkdirSync(dirname(this.vapidPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.vapidPath, JSON.stringify(keys, null, 2), { encoding: "utf-8", mode: 0o600 });
    chmodSync(this.vapidPath, 0o600);
    return keys;
  }

  public getPublicKey(): string {
    return this.vapidKeys.publicKey;
  }

  public addSubscription(sub: PushSubscriptionData): void {
    this.subscriptions.set(sub.endpoint, sub);
  }

  public getSubscriptionsCount(): number {
    return this.subscriptions.size;
  }

  public updatePresence(connectionId: string, isVisible: boolean, viewingPaneId: string | null): void {
    this.presence.set(connectionId, { isVisible, viewingPaneId, lastUpdated: Date.now() });
  }

  public removePresence(connectionId: string): void {
    this.presence.delete(connectionId);
  }

  /** Suppressed while any live connection is visibly showing the target pane. */
  public shouldSuppressPush(targetPaneId: string): boolean {
    const now = Date.now();
    for (const p of this.presence.values()) {
      if (now - p.lastUpdated > PRESENCE_STALE_MS) continue;
      if (p.isVisible && p.viewingPaneId === targetPaneId) return true;
    }
    return false;
  }

  public sendNotification(
    targetPaneId: string,
    _notification: { title: string; body: string }
  ): { suppressed: boolean; delivered: false } {
    return { suppressed: this.shouldSuppressPush(targetPaneId), delivered: false };
  }
}
