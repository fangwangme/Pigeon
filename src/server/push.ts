import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  createCipheriv,
  createECDH,
  createSign,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  events?: { blocked?: boolean; done?: boolean };
  deviceId?: string;
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

/** `push.md` §4: data only; the service worker writes the text in the phone's language. */
export interface PushMessage {
  event: "blocked" | "done";
  agent: string | null;
  workspace: string;
  tab: string;
  paneId: string;
}

const PRESENCE_STALE_MS = 60_000;

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function encryptPayload(payload: string, subKeys: { p256dh: string; auth: string }): Buffer {
  const clientPublicKey = Buffer.from(subKeys.p256dh, "base64url");
  const clientAuth = Buffer.from(subKeys.auth, "base64url");

  const serverEcdh = createECDH("prime256v1");
  serverEcdh.generateKeys();
  const serverPublicKey = serverEcdh.getPublicKey();

  const salt = randomBytes(16);
  const secret = serverEcdh.computeSecret(clientPublicKey);

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    clientPublicKey,
    serverPublicKey,
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, clientAuth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));

  // RFC 8188 §2: one record of aes128gcm ends with delimiter \x02
  const plaintext = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])]);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertextWithTag = Buffer.concat([encrypted, tag]);

  const recordSize = 4096;
  const recordSizeBuf = Buffer.alloc(4);
  recordSizeBuf.writeUInt32BE(recordSize, 0);

  const idLenBuf = Buffer.from([serverPublicKey.length]);

  return Buffer.concat([
    salt,
    recordSizeBuf,
    idLenBuf,
    serverPublicKey,
    ciphertextWithTag,
  ]);
}

/**
 * Presence tracking, VAPID keys, push subscriptions and RFC 8291 + RFC 8292 delivery.
 */
export class PushManager {
  private vapidKeys: VapidKeys;
  private subscriptions = new Map<string, PushSubscriptionData>(); // endpoint -> subscription
  private presence = new Map<string, ClientPresence>(); // connectionId -> presence
  private cachedVapidTokens = new Map<string, { token: string; exp: number }>();

  constructor(
    private vapidPath: string,
    private subscriptionsPath?: string,
    private publicBaseUrl?: string
  ) {
    this.vapidKeys = this.loadOrCreateVapidKeys();
    this.loadSubscriptions();
  }

  private loadOrCreateVapidKeys(): VapidKeys {
    if (existsSync(this.vapidPath)) return JSON.parse(readFileSync(this.vapidPath, "utf-8"));

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

  private loadSubscriptions(): void {
    if (!this.subscriptionsPath || !existsSync(this.subscriptionsPath)) return;
    let data: any;
    try {
      data = JSON.parse(readFileSync(this.subscriptionsPath, "utf-8"));
    } catch (e) {
      throw new Error(`Failed to parse push subscriptions file '${this.subscriptionsPath}': ${e instanceof Error ? e.message : String(e)}`);
    }
    if (data && typeof data === "object") {
      for (const [endpoint, sub] of Object.entries(data)) {
        if (sub && typeof sub === "object") {
          this.subscriptions.set(endpoint, sub as PushSubscriptionData);
        }
      }
    }
  }

  private saveSubscriptions(): void {
    if (!this.subscriptionsPath) return;
    try {
      const obj: Record<string, PushSubscriptionData> = {};
      for (const [endpoint, sub] of this.subscriptions.entries()) {
        obj[endpoint] = sub;
      }
      mkdirSync(dirname(this.subscriptionsPath), { recursive: true, mode: 0o700 });
      const tmp = `${this.subscriptionsPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: "utf-8", mode: 0o600 });
      chmodSync(tmp, 0o600);
      const { renameSync } = require("node:fs");
      renameSync(tmp, this.subscriptionsPath);
    } catch (err) {
      console.error("[pigeon] Failed to save push subscriptions:", err);
    }
  }

  public getPublicKey(): string {
    return this.vapidKeys.publicKey;
  }

  public addSubscription(sub: PushSubscriptionData): void {
    if (sub.deviceId) {
      for (const [endpoint, existing] of Array.from(this.subscriptions.entries())) {
        if (existing.deviceId === sub.deviceId) {
          this.subscriptions.delete(endpoint);
        }
      }
    }
    this.subscriptions.set(sub.endpoint, sub);
    this.saveSubscriptions();
  }

  public removeSubscription(endpoint: string): void {
    if (this.subscriptions.delete(endpoint)) {
      this.saveSubscriptions();
    }
  }

  public removeSubscriptionByDevice(deviceId: string): void {
    let changed = false;
    for (const [endpoint, sub] of Array.from(this.subscriptions.entries())) {
      if (sub.deviceId === deviceId) {
        this.subscriptions.delete(endpoint);
        changed = true;
      }
    }
    if (changed) {
      this.saveSubscriptions();
    }
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

  private getVapidToken(audience: string): string {
    const now = Math.floor(Date.now() / 1000);
    const cached = this.cachedVapidTokens.get(audience);
    if (cached && cached.exp - now > 3600) {
      return cached.token;
    }

    const header = { typ: "JWT", alg: "ES256" };
    const exp = now + 12 * 3600;
    const sub = this.publicBaseUrl ? new URL(this.publicBaseUrl).origin : "mailto:pigeon@example.com";
    const payload = {
      aud: audience,
      exp,
      sub,
    };

    const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signInput = `${encodedHeader}.${encodedPayload}`;

    const signer = createSign("SHA256");
    signer.update(signInput);
    const signature = signer.sign({
      key: this.vapidKeys.privateKey,
      dsaEncoding: "ieee-p1363",
    });

    const token = `${signInput}.${signature.toString("base64url")}`;
    this.cachedVapidTokens.set(audience, { token, exp });
    return token;
  }

  public sendNotification(message: PushMessage): { suppressed: boolean; delivered: boolean } {
    if (this.shouldSuppressPush(message.paneId)) {
      return { suppressed: true, delivered: false };
    }

    const targetSubs = Array.from(this.subscriptions.values()).filter((sub) => {
      if (sub.events) {
        if (message.event === "blocked" && sub.events.blocked === false) return false;
        if (message.event === "done" && !sub.events.done) return false;
      } else {
        if (message.event === "done") return false;
      }
      return true;
    });

    if (targetSubs.length === 0) {
      return { suppressed: false, delivered: false };
    }

    const payloadText = JSON.stringify(message);

    for (const sub of targetSubs) {
      void (async () => {
        try {
          const body = encryptPayload(payloadText, sub.keys);
          const aud = new URL(sub.endpoint).origin;
          const vapidToken = this.getVapidToken(aud);
          const res = await fetch(sub.endpoint, {
            method: "POST",
            headers: {
              "Content-Encoding": "aes128gcm",
              "Content-Type": "application/octet-stream",
              TTL: "3600",
              Urgency: "high",
              Authorization: `vapid t=${vapidToken}, k=${this.vapidKeys.publicKey}`,
            },
            body: new Uint8Array(body),
          });
          const host = new URL(sub.endpoint).host;
          if (res.status === 404 || res.status === 410) {
            this.removeSubscription(sub.endpoint);
          } else if (!res.ok) {
            console.error(`[pigeon] push delivery to ${host} failed: ${res.status}`);
          }
        } catch (err) {
          try {
            const host = new URL(sub.endpoint).host;
            console.error(`[pigeon] push delivery to ${host} failed:`, err);
          } catch {
            console.error("[pigeon] push delivery failed:", err);
          }
        }
      })();
    }

    return { suppressed: false, delivered: true };
  }
}
