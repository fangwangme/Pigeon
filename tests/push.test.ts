import { afterEach, describe, expect, test } from "bun:test";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigManager } from "../src/server/config-manager";
import { PigeonDaemon } from "../src/server/daemon";
import { FakeHerdr, freePort, tempDir, type FakePane } from "./helpers/fixtures";

// Issue #19 acceptance: push.md §3 (subscription storage), §4 (trigger), §5 (delivery: RFC 8291 + RFC 8292).
const PUBLIC = "https://pigeon.example.ts.net";
const PANES: FakePane[] = [
  { paneId: "p1", app: "claude-code", state: "idle", program: "claude" },
  { paneId: "p2", app: "codex", state: "idle", program: "codex" },
];

interface PushRequest {
  headers: Headers;
  body: Buffer;
}

let cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

/** A push service stand-in that records every request and answers with `status`. */
function fakePushService() {
  const service = { requests: [] as PushRequest[], status: 201 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      service.requests.push({ headers: req.headers, body: Buffer.from(await req.arrayBuffer()) });
      return new Response(null, { status: service.status });
    },
  });
  cleanup.push(() => server.stop(true));
  return { service, endpoint: `http://127.0.0.1:${server.port}/push/abc` };
}

async function startDaemon(dir: string, herdr: FakeHerdr) {
  const daemon = new PigeonDaemon({
    configManager: new ConfigManager(join(dir, "config.json"), { HOME: dir }),
    port: freePort(),
    publicBaseUrl: PUBLIC,
    herdrAppSocketPath: herdr.appSocketPath,
    herdrCoreSocketPath: herdr.coreSocketPath,
    adminSocketPath: join(dir, "admin.sock"),
    devicesFilePath: join(dir, "devices.json"),
    vapidPath: join(dir, "vapid.json"),
    pushSubscriptionsPath: join(dir, "push-subscriptions.json"),
    embeddedHtml: "<!doctype html><title>Pigeon</title>",
  });
  await daemon.start();
  return daemon;
}

function pair(daemon: PigeonDaemon) {
  const { token } = daemon.pairingManager.createPairingToken();
  const { sessionToken, deviceId } = daemon.pairingManager.exchangeToken(token, "Phone") as { sessionToken: string; deviceId: string };
  return { cookie: `${daemon.pairingManager.getCookieName()}=${sessionToken}`, deviceId };
}

/** The browser's side of a subscription: its key pair and auth secret (RFC 8291 §2). */
function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, p256dh: ecdh.getPublicKey().toString("base64url"), authB64: auth.toString("base64url") };
}

/** Decrypts one aes128gcm push message the way the browser does (RFC 8291 §3.4, RFC 8188 §2). */
function decrypt(body: Buffer, keys: ReturnType<typeof browserKeys>): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const serverPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const secret = keys.ecdh.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), keys.ecdh.getPublicKey(), serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, keys.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (padded[end] === 0) end--;
  expect(padded[end]).toBe(2); // the last record's delimiter
  return padded.subarray(0, end).toString("utf-8");
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

describe("push delivery (push.md §3–§5)", () => {
  test("a stored subscription gets an encrypted, VAPID-signed message; 410 and revocation remove it", async () => {
    const dir = tempDir("push");
    const herdr = new FakeHerdr(dir);
    herdr.serve(PANES);
    await herdr.listen();
    cleanup.push(() => herdr.close());
    const { service, endpoint } = fakePushService();
    const keys = browserKeys();

    // Subscribe on one daemon run.
    const first = await startDaemon(dir, herdr);
    const { cookie, deviceId } = pair(first);
    const res = await fetch(`http://127.0.0.1:${first.config.port}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.authB64 }, events: { blocked: true, done: false } }),
    });
    expect(res.status).toBe(200);
    first.stop();
    expect(readFileSync(join(dir, "push-subscriptions.json"), "utf-8")).toContain(deviceId);

    // The subscription survives the restart and receives the blocked transition.
    const daemon = await startDaemon(dir, herdr);
    cleanup.push(() => daemon.stop());
    herdr.emitEvent("status", "p1", { status: { state: "blocked", app: "claude-code" } });
    await until(() => service.requests.length === 1);
    const req = service.requests[0]!;
    expect(req.headers.get("content-encoding")).toBe("aes128gcm");
    expect(Number(req.headers.get("ttl"))).toBeGreaterThan(0);
    const auth = req.headers.get("authorization") ?? "";
    expect(auth).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const jwt = JSON.parse(Buffer.from(auth.split("t=")[1]!.split(".")[1]!, "base64url").toString("utf-8"));
    expect(jwt.aud).toBe(new URL(endpoint).origin);
    expect(auth.split("k=")[1]).toBe(daemon.pushManager.getPublicKey());
    expect(JSON.parse(decrypt(req.body, keys))).toMatchObject({ event: "blocked", agent: "claude", paneId: "p1" });

    // The push service says the subscription is gone: it is deleted.
    service.status = 410;
    herdr.emitEvent("status", "p2", { status: { state: "blocked", app: "codex" } });
    await until(() => service.requests.length === 2);
    await until(() => !readFileSync(join(dir, "push-subscriptions.json"), "utf-8").includes(endpoint));

    // Subscribing again, then revoking the device, removes its subscription too.
    service.status = 201;
    const again = pair(daemon);
    await fetch(`http://127.0.0.1:${daemon.config.port}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: again.cookie },
      body: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.authB64 }, events: { blocked: true, done: false } }),
    });
    expect(readFileSync(join(dir, "push-subscriptions.json"), "utf-8")).toContain(again.deviceId);
    daemon.pairingManager.revokeDevice(again.deviceId);
    const stored = existsSync(join(dir, "push-subscriptions.json")) ? readFileSync(join(dir, "push-subscriptions.json"), "utf-8") : "";
    expect(stored).not.toContain(again.deviceId);
  });
});
