import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigManager } from "../src/server/config-manager";
import { PigeonDaemon, resolvePublicBaseUrl } from "../src/server/daemon";
import { PairingManager, generateBase32Token } from "../src/server/pairing";
import { PushManager } from "../src/server/push";
import { tempDir } from "./helpers/fixtures";

function pairingIn(dir: string, publicBaseUrl = "https://pigeon.example.ts.net") {
  return new PairingManager({ publicBaseUrl, adminSocketPath: join(dir, "admin.sock"), devicesFilePath: join(dir, "devices.json") });
}

describe("pairing (security-and-pairing.md §2)", () => {
  test("pairing codes are 26 Base32 characters", () => {
    expect(generateBase32Token(16)).toMatch(/^[A-Z2-7]{26}$/);
  });

  test("the pairing link opens /pair with the code in the fragment", () => {
    const { token, url } = pairingIn(tempDir("pair")).createPairingToken();
    expect(url).toBe(`https://pigeon.example.ts.net/pair#code=${token}`);
  });

  test("a single-use code is consumed by the first pairing", () => {
    const p = pairingIn(tempDir("pair"));
    const { token } = p.createPairingToken({ singleUse: true });
    const ok = p.exchangeToken(token, "Phone");
    expect(ok.success).toBe(true);
    expect(p.validateSession(ok.sessionToken)?.deviceName).toBe("Phone");
    expect(p.exchangeToken(token, "Phone").success).toBe(false);
  });

  test("the default code is permanent and pairs several devices", () => {
    const p = pairingIn(tempDir("pair"));
    const { token, permanent, expiresAt } = p.createPairingToken();
    expect([permanent, expiresAt]).toEqual([true, 0]);
    expect(p.exchangeToken(token, "Phone").success).toBe(true);
    expect(p.exchangeToken(token, "Tablet").success).toBe(true);
  });

  test("five wrong codes revoke the active code", () => {
    const p = pairingIn(tempDir("pair"));
    const { token } = p.createPairingToken();
    for (let i = 0; i < 5; i++) p.exchangeToken("AAAAAAAAAAAAAAAAAAAAAAAAAA", "x");
    expect(p.exchangeToken(token, "Phone").success).toBe(false);
  });

  test("paired devices survive a restart and the registry is mode 0600", () => {
    const dir = tempDir("pair");
    const first = pairingIn(dir);
    const { token } = first.createPairingToken();
    const ok = first.exchangeToken(token, "Phone");
    expect(statSync(join(dir, "devices.json")).mode & 0o777).toBe(0o600);
    const second = pairingIn(dir);
    expect(second.getActiveToken()?.token).toBe(token);
    expect(second.validateSession(ok.sessionToken)?.deviceName).toBe("Phone");
  });

  test("a corrupt device registry stops startup and is left untouched", () => {
    const dir = tempDir("pair");
    writeFileSync(join(dir, "devices.json"), "{not json");
    expect(() => pairingIn(dir)).toThrow(/not valid JSON/);
    expect(readFileSync(join(dir, "devices.json"), "utf-8")).toBe("{not json");
  });
});

describe("admin channel (security-and-pairing.md §5)", () => {
  test("a second daemon cannot take over a live admin socket", async () => {
    const dir = tempDir("admin");
    const first = pairingIn(dir);
    await first.startAdminSocket();
    try {
      await expect(pairingIn(dir).startAdminSocket()).rejects.toThrow(/already running/);
    } finally {
      first.stopAdminSocket();
    }
  });

  test("the admin socket is mode 0600", async () => {
    const dir = tempDir("admin");
    const p = pairingIn(dir);
    await p.startAdminSocket();
    expect(statSync(join(dir, "admin.sock")).mode & 0o777).toBe(0o600);
    p.stopAdminSocket();
  });
});

describe("configuration file (architecture.md §4.7)", () => {
  test("a fresh config holds the defaults but not the environment-derived socket paths", () => {
    const dir = tempDir("cfg");
    const cfg = new ConfigManager(join(dir, "config.json"), { HOME: dir, HERDR_APP_HOME: "/app-home", XDG_RUNTIME_DIR: "/run/u" });
    expect(cfg.getServerConfig().herdrAppSocketPath).toBe("/app-home/herdr-app.sock");
    expect(cfg.getServerConfig().herdrCoreSocketPath).toBe("/run/u/herdr-core/default.sock");
    const stored = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
    expect(stored.server.herdrAppSocketPath).toBeUndefined();
    expect(stored.server.herdrCoreSocketPath).toBeUndefined();
    expect(stored.server.port).toBe(4100);
  });

  test("a client patch is written to disk and keeps other settings", () => {
    const dir = tempDir("cfg");
    const path = join(dir, "config.json");
    new ConfigManager(path, { HOME: dir }).patchClientConfig({ accent: "green" });
    const reloaded = new ConfigManager(path, { HOME: dir });
    expect(reloaded.getClientConfig().accent).toBe("green");
    expect(reloaded.getClientConfig().themeMode).toBe("system");
    expect(reloaded.getServerConfig().port).toBe(4100);
  });

  test("an unparseable config stops startup and is left untouched", () => {
    const dir = tempDir("cfg");
    writeFileSync(join(dir, "config.json"), "{ broken");
    expect(() => new ConfigManager(join(dir, "config.json"), { HOME: dir })).toThrow(/not valid JSON/);
    expect(readFileSync(join(dir, "config.json"), "utf-8")).toBe("{ broken");
  });

  test("client keys this version no longer has are removed on load", () => {
    const dir = tempDir("cfg");
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ client: { themeKey: "gruvbox", macros: [], showMacroDock: true, confirmCtrlC: true, themeMode: "dark" } }));
    expect(new ConfigManager(path, { HOME: dir }).getClientConfig()).toEqual({ themeMode: "dark", accent: "blue" });
    expect(JSON.parse(readFileSync(path, "utf-8")).client).toEqual({ themeMode: "dark" });
  });

  test("the old terminal Herdr socket path is dropped; a hand-set admin path is kept", () => {
    const dir = tempDir("cfg");
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ server: { herdrSocketPath: "/srv/herdr.sock", adminSocketPath: "/srv/my-admin.sock" } }));
    const cfg = new ConfigManager(path, { HOME: dir, XDG_RUNTIME_DIR: join(dir, "run") });
    expect(cfg.getServerConfig().adminSocketPath).toBe("/srv/my-admin.sock");
    const stored = JSON.parse(readFileSync(path, "utf-8"));
    expect(stored.server.herdrSocketPath).toBeUndefined();
    expect(stored.server.adminSocketPath).toBe("/srv/my-admin.sock");
  });
});

describe("push keys and presence (push.md §3, §4)", () => {
  test("the VAPID public key is an uncompressed P-256 point and the key file is mode 0600", () => {
    const path = join(tempDir("push"), "vapid.json");
    const key = Buffer.from(new PushManager(path).getPublicKey(), "base64url");
    expect(key.length).toBe(65);
    expect(key[0]).toBe(0x04);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a key file in the old SPKI format is replaced", () => {
    const path = join(tempDir("push"), "vapid.json");
    writeFileSync(path, JSON.stringify({ publicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE", privateKey: "x" }));
    expect(Buffer.from(new PushManager(path).getPublicKey(), "base64url").length).toBe(65);
  });

  test("a notification is suppressed only while some connection visibly shows that pane", () => {
    const push = new PushManager(join(tempDir("push"), "vapid.json"));
    push.updatePresence("c1", true, "p1");
    push.updatePresence("c2", false, "p2");
    expect(push.sendNotification("p1", { title: "t", body: "b" }).suppressed).toBe(true);
    expect(push.sendNotification("p2", { title: "t", body: "b" }).suppressed).toBe(false);
    push.removePresence("c1");
    expect(push.shouldSuppressPush("p1")).toBe(false);
  });
});

describe("reachable address (architecture.md §4.2)", () => {
  test("Tailscale's name is used when no URL is configured", () => {
    expect(resolvePublicBaseUrl({ insecureDev: false, port: 4100 }, () => "box.tail.ts.net")).toBe("https://box.tail.ts.net");
  });

  test("without Tailscale or a configured URL, startup fails with guidance", () => {
    expect(() => resolvePublicBaseUrl({ insecureDev: false, port: 4100 }, () => null)).toThrow(/--public-url/);
  });

  test("a configured URL wins and loses its trailing slash", () => {
    expect(resolvePublicBaseUrl({ configured: "https://x.example/", insecureDev: false, port: 4100 }, () => null)).toBe("https://x.example");
  });
});

describe("HTTP and WebSocket gate (security-and-pairing.md §3, §4)", () => {
  const PUBLIC = "https://pigeon.example.ts.net";
  const port = 41000 + Math.floor(Math.random() * 2000);
  const base = `http://127.0.0.1:${port}`;
  let daemon: PigeonDaemon;

  beforeAll(async () => {
    const dir = tempDir("daemon");
    daemon = new PigeonDaemon({
      configManager: new ConfigManager(join(dir, "config.json"), { HOME: dir }),
      port,
      publicBaseUrl: PUBLIC,
      herdrAppSocketPath: join(dir, "no-app.sock"),
      herdrCoreSocketPath: join(dir, "no-core.sock"),
      adminSocketPath: join(dir, "admin.sock"),
      devicesFilePath: join(dir, "devices.json"),
      vapidPath: join(dir, "vapid.json"),
      embeddedHtml: "<!doctype html><title>Pigeon</title>",
    });
    await daemon.start();
  });

  afterAll(() => daemon.stop());

  const upgrade = (headers: Record<string, string>, path = "/ws") =>
    fetch(`${base}${path}`, {
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": Buffer.from("pigeon-test-nonce").toString("base64"), "Sec-WebSocket-Version": "13", ...headers },
    });
  const pairedCookie = () => {
    const { token } = daemon.pairingManager.createPairingToken();
    const { sessionToken } = daemon.pairingManager.exchangeToken(token, "Phone");
    return `${daemon.pairingManager.getCookieName()}=${sessionToken}`;
  };

  test("an upgrade without a session cookie is 401", async () => {
    expect((await upgrade({ Host: "pigeon.example.ts.net", Origin: PUBLIC })).status).toBe(401);
  });

  test("a session token in the query string is not accepted", async () => {
    const token = pairedCookie().split("=")[1];
    expect((await upgrade({ Host: "pigeon.example.ts.net", Origin: PUBLIC }, `/ws?token=${token}`)).status).toBe(401);
  });

  test("a foreign Origin is 403 even with a valid session", async () => {
    expect((await upgrade({ Host: "pigeon.example.ts.net", Origin: "https://evil.example", Cookie: pairedCookie() })).status).toBe(403);
  });

  test("the right host on another port is a different origin and is 403", async () => {
    expect((await upgrade({ Host: "pigeon.example.ts.net", Origin: `${PUBLIC}:8443`, Cookie: pairedCookie() })).status).toBe(403);
  });

  test("a missing Origin is 403", async () => {
    expect((await upgrade({ Host: "pigeon.example.ts.net", Cookie: pairedCookie() })).status).toBe(403);
  });

  test("a forged Host is 403 (DNS rebinding)", async () => {
    expect((await upgrade({ Host: "evil.example", Origin: PUBLIC, Cookie: pairedCookie() })).status).toBe(403);
  });

  test("an IPv6 loopback Host passes the Host check", async () => {
    expect((await upgrade({ Host: `[::1]:${port}`, Origin: PUBLIC })).status).toBe(401);
  });

  test("pairing sets an HttpOnly, SameSite=Strict, Secure cookie for one year", async () => {
    const { token } = daemon.pairingManager.createPairingToken();
    const res = await fetch(`${base}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: token, deviceName: "Phone" }) });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    for (const part of ["HttpOnly", "SameSite=Strict", "Secure", "Max-Age=31536000"]) expect(cookie).toContain(part);
  });

  test("a malformed pairing body is 400", async () => {
    const res = await fetch(`${base}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: 42 }) });
    expect(res.status).toBe(400);
  });

  test("the app shell is served at / and /pair; unknown paths are 404", async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/pair`)).status).toBe(200);
    expect((await fetch(`${base}/review`)).status).toBe(404);
  });

  const upload = (headers: Record<string, string>, body: Uint8Array | string = "hello") =>
    fetch(`${base}/api/uploads`, { method: "POST", headers: { "Content-Type": "text/plain", "X-Pigeon-Filename": encodeURIComponent("my notes.txt"), ...headers }, body });

  test("an upload needs a session, the exact Origin and an allowed Host (protocol.md §7)", async () => {
    expect((await upload({ Origin: PUBLIC })).status).toBe(401);
    expect((await upload({ Origin: "https://evil.example", Cookie: pairedCookie() })).status).toBe(403);
    expect((await upload({ Origin: PUBLIC, Host: "evil.example", Cookie: pairedCookie() })).status).toBe(403);
  });

  test("an upload is stored privately and answered with its id", async () => {
    const res = await upload({ Origin: PUBLIC, Cookie: pairedCookie() });
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info).toMatchObject({ name: "my_notes.txt", size: 5, mime: "text/plain" });
    expect(info.id).toMatch(/^up_[0-9a-f]{16}$/);
  });

  test("an empty, unnamed or oversized upload is refused", async () => {
    const cookie = pairedCookie();
    expect((await upload({ Origin: PUBLIC, Cookie: cookie }, "")).status).toBe(400);
    expect((await fetch(`${base}/api/uploads`, { method: "POST", headers: { Origin: PUBLIC, Cookie: cookie }, body: "x" })).status).toBe(400);
    expect((await upload({ Origin: PUBLIC, Cookie: cookie }, new Uint8Array(20 * 1024 * 1024 + 1))).status).toBe(413);
  });

  test("push subscription requires a session", async () => {
    const res = await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});
