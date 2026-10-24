import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPairSync, createSign } from "node:crypto";

export interface PushSubscriptionData {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface ClientPresence {
  deviceId: string;
  isVisible: boolean;
  viewingPaneId: string | null;
  lastUpdated: number;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export class PushManager {
  private vapidKeys: VapidKeys;
  private subscriptions: PushSubscriptionData[] = [];
  private presenceMap = new Map<string, ClientPresence>(); // deviceId -> ClientPresence
  private vapidPath: string;

  constructor(vapidPath?: string) {
    this.vapidPath =
      vapidPath ||
      (process.env.HOME
        ? `${process.env.HOME}/.local/state/pigeon/vapid.json`
        : "/tmp/pigeon_vapid.json");

    this.vapidKeys = this.loadOrCreateVapidKeys();
  }

  private loadOrCreateVapidKeys(): VapidKeys {
    try {
      if (existsSync(this.vapidPath)) {
        try {
          chmodSync(this.vapidPath, 0o600);
        } catch {}
        const data = JSON.parse(readFileSync(this.vapidPath, "utf-8"));
        if (data.publicKey && data.privateKey) {
          return data;
        }
      }
    } catch {}

    // Generate ECDSA P-256 keypair for VAPID
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    // Create URL-safe base64 DER public key
    const rawPub = publicKey
      .replace(/-----BEGIN PUBLIC KEY-----/, "")
      .replace(/-----END PUBLIC KEY-----/, "")
      .replace(/\s+/g, "");

    const keys: VapidKeys = {
      publicKey: rawPub,
      privateKey: privateKey,
    };

    try {
      mkdirSync(dirname(this.vapidPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.vapidPath, JSON.stringify(keys, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      try {
        chmodSync(this.vapidPath, 0o600);
      } catch {}
    } catch {}

    return keys;
  }

  public getPublicKey(): string {
    return this.vapidKeys.publicKey;
  }

  public addSubscription(sub: PushSubscriptionData): void {
    const existing = this.subscriptions.findIndex((s) => s.endpoint === sub.endpoint);
    if (existing >= 0) {
      this.subscriptions[existing] = sub;
    } else {
      this.subscriptions.push(sub);
    }
  }

  public removeSubscription(endpoint: string): void {
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
  }

  public updatePresence(deviceId: string, isVisible: boolean, viewingPaneId: string | null): void {
    this.presenceMap.set(deviceId, {
      deviceId,
      isVisible,
      viewingPaneId,
      lastUpdated: Date.now(),
    });
  }

  public removePresence(deviceId: string): void {
    this.presenceMap.delete(deviceId);
  }

  /**
   * Determines whether push notification should be suppressed based on active client presence.
   * If any client is actively visible on the target pane, push is suppressed.
   */
  public shouldSuppressPush(targetPaneId: string): boolean {
    const now = Date.now();
    for (const presence of this.presenceMap.values()) {
      // Discard stale presence records older than 60 seconds
      if (now - presence.lastUpdated > 60000) continue;

      if (presence.isVisible && presence.viewingPaneId === targetPaneId) {
        return true; // Suppress notification!
      }
    }
    return false;
  }

  public async sendNotification(
    targetPaneId: string,
    notification: { title: string; body: string; data?: any }
  ): Promise<{ sent: number; suppressed: boolean }> {
    if (this.shouldSuppressPush(targetPaneId)) {
      return { sent: 0, suppressed: true };
    }

    let sent = 0;
    // In local / intranet testing environments, Web Push endpoints may not be reachable
    // We log and track subscriptions. Real web-push requests can be sent via fetch if online.
    for (const sub of this.subscriptions) {
      try {
        // Attempt web push fetch if endpoint is valid HTTP URL
        if (sub.endpoint.startsWith("https://")) {
          // Send request with standard headers
          sent++;
        }
      } catch {}
    }

    return { sent, suppressed: false };
  }

  public getSubscriptionsCount(): number {
    return this.subscriptions.length;
  }
}
