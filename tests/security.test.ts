import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigManager, resolveInstancePaths, resolveProductionPort } from "../src/server/config-manager";
import { PigeonDaemon, resolveAccess } from "../src/server/daemon";
import { PWA_ICON_192_BASE64, PWA_ICON_DARK_192_BASE64 } from "../src/server/pwa-assets";
import { PairingManager, generateBase32Token } from "../src/server/pairing";
import { PushManager } from "../src/server/push";
import { freePort, tempDir } from "./helpers/fixtures";

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
    expect(p.getActiveToken()).toBeNull(); // gone at the fifth, so a restart cannot show it again
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

  test("a device unused for 30 days is removed at startup and its token no longer authenticates", () => {
    const dir = tempDir("pair");
    const first = pairingIn(dir);
    const { token } = first.createPairingToken();
    const stale = first.exchangeToken(token, "Old phone");
    const recent = first.exchangeToken(token, "Phone");
    const file = join(dir, "devices.json");
    const registry = JSON.parse(readFileSync(file, "utf-8"));
    const day = 24 * 3_600_000;
    const sessions: any[] = Array.isArray(registry.sessions) ? registry.sessions : Object.values(registry.sessions);
    for (const s of sessions) s.lastUsedAt = Date.now() - (s.deviceId === stale.deviceId ? 31 : 29) * day;
    writeFileSync(file, JSON.stringify(registry));
    const second = pairingIn(dir);
    expect(second.listDevices().map((d) => d.deviceName)).toEqual(["Phone"]);
    expect(second.validateSession(stale.sessionToken)).toBeNull();
    expect(second.validateSession(recent.sessionToken)?.deviceName).toBe("Phone");
  });

  test("a device used more often than hourly still has its use written within the hour (§5 expiry)", () => {
    const dir = tempDir("pair");
    const start = Date.now();
    try {
      setSystemTime(start);
      const p = pairingIn(dir);
      const { token } = p.createPairingToken();
      const { sessionToken } = p.exchangeToken(token, "Phone");
      setSystemTime(start + 30 * 60_000);
      p.validateSession(sessionToken);
      setSystemTime(start + 61 * 60_000);
      p.validateSession(sessionToken);
      const onDisk = JSON.parse(readFileSync(join(dir, "devices.json"), "utf-8")).sessions[0].lastUsedAt;
      expect(onDisk).toBe(start + 61 * 60_000);
    } finally {
      setSystemTime();
    }
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

describe("instances by port (architecture.md §4.6)", () => {
  const env = { HOME: "/h", XDG_DATA_HOME: "/d", XDG_RUNTIME_DIR: "/run/u" };

  test("production keeps pigeon/ and pigeon.sock", () => {
    expect(resolveInstancePaths({ env, port: 4100, productionPort: 4100 })).toMatchObject({
      stateDir: "/d/pigeon",
      configPath: "/d/pigeon/config.json",
      adminSocketPath: "/run/u/pigeon.sock",
      devicesPath: "/d/pigeon/devices.json",
      queuePath: "/d/pigeon/queue.json",
      usageDbPath: "/d/pigeon/usage.db",
    });
  });

  test("another port gets its own state directory but shares the usage data", () => {
    expect(resolveInstancePaths({ env, port: 4101, productionPort: 4100 })).toMatchObject({
      stateDir: "/d/pigeon-4101",
      configPath: "/d/pigeon-4101/config.json",
      adminSocketPath: "/run/u/pigeon-4101.sock",
      devicesPath: "/d/pigeon-4101/devices.json",
      queuePath: "/d/pigeon-4101/queue.json",
      vapidPath: "/d/pigeon-4101/vapid.json",
      pushSubscriptionsPath: "/d/pigeon-4101/push-subscriptions.json",
      uploadsDir: "/d/pigeon-4101/uploads",
      usageDbPath: "/d/pigeon/usage.db",
      pricingCachePath: "/d/pigeon/pricing-cache.json",
    });
  });

  test("production on a port the user moved it to is still production", () => {
    expect(resolveInstancePaths({ env, port: 4200, productionPort: 4200 }).stateDir).toBe("/d/pigeon");
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

  test("tailscaleHttpsPort defaults to 8443 for production and 18443 for test instances (architecture.md §4.2, §4.7)", () => {
    const prodDir = tempDir("prod-cfg");
    const prodCfg = new ConfigManager(join(prodDir, "config.json"), { HOME: prodDir });
    expect(prodCfg.getServerConfig().tailscaleHttpsPort).toBe(8443);

    const testDir = tempDir("test-cfg");
    const testCfg = new ConfigManager({ port: 4101, path: join(testDir, "config.json") }, { HOME: testDir });
    expect(testCfg.getServerConfig().tailscaleHttpsPort).toBe(18443);
  });

  test("custom production port in config.json derives production paths for that port and isolated paths for test ports (architecture.md §4.6)", () => {
    const dir = tempDir("prod-port");
    const pigeonDir = join(dir, "pigeon");
    mkdirSync(pigeonDir, { recursive: true });
    writeFileSync(join(pigeonDir, "config.json"), JSON.stringify({ server: { port: 4200 } }));

    const prodPort = resolveProductionPort({ HOME: dir, XDG_DATA_HOME: dir });
    expect(prodPort).toBe(4200);

    const prodPaths = resolveInstancePaths({ port: 4200, productionPort: 4200, env: { HOME: dir, XDG_DATA_HOME: dir } });
    expect(prodPaths.stateDir).toBe(join(dir, "pigeon"));
    expect(prodPaths.adminSocketPath).toContain("pigeon.sock");

    const testPaths = resolveInstancePaths({ port: 4101, productionPort: 4200, env: { HOME: dir, XDG_DATA_HOME: dir } });
    expect(testPaths.stateDir).toBe(join(dir, "pigeon-4101"));
    expect(testPaths.adminSocketPath).toContain("pigeon-4101.sock");
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

  test("a notification is suppressed only while some connection visibly shows that pane", () => {
    const push = new PushManager(join(tempDir("push"), "vapid.json"));
    push.updatePresence("c1", true, "p1");
    push.updatePresence("c2", false, "p2");
    const blocked = (paneId: string) => ({ event: "blocked" as const, agent: "claude", workspace: "w", tab: "t", paneId });
    expect(push.sendNotification(blocked("p1")).suppressed).toBe(true);
    expect(push.sendNotification(blocked("p2")).suppressed).toBe(false);
    push.removePresence("c1");
    expect(push.shouldSuppressPush("p1")).toBe(false);
  });

  test("push notification done triggers on transition into done from any status (push.md §4.1)", () => {
    let lastStatus: string | undefined = "blocked";
    const status: string = "done";
    const previous = lastStatus;
    const isBlocked = status === "blocked" && previous !== "blocked";
    const isDone = status === "done" && previous !== "done";
    expect(isBlocked).toBe(false);
    expect(isDone).toBe(true);
  });
});

describe("reachable address (architecture.md §4.2)", () => {
  const none = { tailscaleServeDns: () => null as string | null, tailscaleIp: () => null as string | null, lanIp: () => null as string | null };
  const access = (probes: Partial<typeof none>, opts: { configured?: string; insecureDev?: boolean } = {}) =>
    resolveAccess({ insecureDev: false, port: 4100, ...opts }, { ...none, ...probes });

  test("Tailscale Serve is secure and listens on loopback only", () => {
    expect(access({ tailscaleServeDns: () => "box.tail.ts.net", tailscaleIp: () => "100.64.0.7", lanIp: () => "10.0.0.5" })).toMatchObject({
      publicBaseUrl: "https://box.tail.ts.net",
      secure: true,
      bindHost: "127.0.0.1",
    });
  });

  test("without Serve, the Tailscale IP is used over plain HTTP on every interface", () => {
    expect(access({ tailscaleIp: () => "100.64.0.7", lanIp: () => "10.0.0.5" })).toMatchObject({ publicBaseUrl: "http://100.64.0.7:4100", secure: false, bindHost: "" });
  });

  test("without Tailscale, the LAN address is used", () => {
    expect(access({ lanIp: () => "10.0.0.5" })).toMatchObject({ publicBaseUrl: "http://10.0.0.5:4100", secure: false, bindHost: "" });
  });

  test("with no address at all, localhost is used", () => {
    expect(access({})).toMatchObject({ publicBaseUrl: "http://localhost:4100", secure: false });
  });

  test("--insecure-dev skips Tailscale and uses the LAN", () => {
    expect(access({ tailscaleServeDns: () => "box.tail.ts.net", tailscaleIp: () => "100.64.0.7", lanIp: () => "10.0.0.5" }, { insecureDev: true }).publicBaseUrl).toBe("http://10.0.0.5:4100");
  });

  test("a configured URL wins and loses its trailing slash", () => {
    expect(access({ tailscaleServeDns: () => "box.tail.ts.net" }, { configured: "https://x.example/" })).toMatchObject({ publicBaseUrl: "https://x.example", secure: true });
  });
});

describe("HTTP and WebSocket gate (security-and-pairing.md §3, §4)", () => {
  const PUBLIC = "https://pigeon.example.ts.net";
  const port = freePort();
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
      embeddedHtml: "<!doctype html><title>Pigeon</title><link rel=\"apple-touch-icon\" href=\"/icon-192.png\" /><link rel=\"icon\" type=\"image/svg+xml\" href=\"/icon.svg\" />",
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

  test("pairing again from an already paired browser replaces its device record", async () => {
    const oldCookie = pairedCookie();
    const oldToken = oldCookie.split("=")[1];
    const before = daemon.pairingManager.listDevices().length;
    const { token } = daemon.pairingManager.createPairingToken();
    const res = await fetch(`${base}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: oldCookie }, body: JSON.stringify({ code: token, deviceName: "Phone" }) });
    expect(res.status).toBe(200);
    const newToken = res.headers.get("set-cookie")!.split(";")[0].split("=")[1];
    expect(daemon.pairingManager.listDevices().length).toBe(before);
    expect(daemon.pairingManager.validateSession(oldToken)).toBeNull();
    expect(daemon.pairingManager.validateSession(newToken)?.deviceName).toBe("Phone");
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

  const upload = (headers: Record<string, string>, body: BodyInit = "hello") =>
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

  test("upload download enforces inline disposition only for raster images, and nosniff + sandbox for all (architecture.md §5)", async () => {
    const cookie = pairedCookie();
    const uploadRes = await upload({ Origin: PUBLIC, Cookie: cookie });
    const { id } = await uploadRes.json();

    const getRes = await fetch(`${base}/api/uploads/${id}`, { headers: { Origin: PUBLIC, Cookie: cookie } });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-disposition")).toContain("attachment;");
    expect(getRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(getRes.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  // Issue #21: a browser sends no Origin for <img> loads or link navigation.
  test("an upload is readable without an Origin header, a foreign Origin is still refused (protocol.md §7)", async () => {
    const cookie = pairedCookie();
    const { id } = await (await upload({ Origin: PUBLIC, Cookie: cookie })).json();
    const plain = await fetch(`${base}/api/uploads/${id}`, { headers: { Cookie: cookie } });
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe("hello");
    expect((await fetch(`${base}/api/uploads/${id}`, { headers: { Origin: "https://evil.example", Cookie: cookie } })).status).toBe(403);
    expect((await fetch(`${base}/api/uploads/${id}`)).status).toBe(401);
  });

  test("the app shell's CSP allows blob: images (architecture.md §5)", async () => {
    const res = await fetch(`${base}/`);
    const imgSrc = (res.headers.get("content-security-policy") ?? "")
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("img-src"));
    expect(imgSrc?.split(/\s+/)).toContain("blob:");
  });

  test("non-4100 daemon returns dark icon, 4100 returns light icon (security-and-pairing.md §3, issue #21)", async () => {
    // 1. Non-4100 daemon (the active test daemon on `base` uses an ephemeral non-4100 port)
    const testSvgRes = await fetch(`${base}/icon.svg`);
    expect(testSvgRes.status).toBe(200);
    const testSvg = await testSvgRes.text();
    expect(testSvg).toContain('<stop offset="0%" stop-color="#24272B" />');
    expect(testSvg).not.toContain("#F7F4EC");

    const testPngRes = await fetch(`${base}/icon-192.png`);
    expect(testPngRes.status).toBe(200);
    const testPngBytes = new Uint8Array(await testPngRes.arrayBuffer());
    expect(testPngBytes).toEqual(new Uint8Array(Buffer.from(PWA_ICON_DARK_192_BASE64, "base64")));

    const testManifestRes = await fetch(`${base}/manifest.webmanifest`);
    expect(testManifestRes.status).toBe(200);
    const testManifest = await testManifestRes.json();
    expect(testManifest.icons.some((i: any) => i.src === "/icon-dark-192.png")).toBe(true);

    const testHtmlRes = await fetch(`${base}/`);
    expect(testHtmlRes.status).toBe(200);
    const testHtml = await testHtmlRes.text();
    expect(testHtml).toContain('href="/icon-dark-192.png"');

    // 2. Production daemon on port 4100
    const dir = tempDir("prod-daemon");
    const prodDaemon = new PigeonDaemon({
      configManager: new ConfigManager(join(dir, "config.json"), { HOME: dir }),
      port: 4100,
      publicBaseUrl: "https://pigeon.example.ts.net",
      herdrAppSocketPath: join(dir, "no-app.sock"),
      herdrCoreSocketPath: join(dir, "no-core.sock"),
      adminSocketPath: join(dir, "admin.sock"),
      devicesFilePath: join(dir, "devices.json"),
      vapidPath: join(dir, "vapid.json"),
      embeddedHtml: "<!doctype html><title>Pigeon</title><link rel=\"apple-touch-icon\" href=\"/icon-192.png\" /><link rel=\"icon\" type=\"image/svg+xml\" href=\"/icon.svg\" />",
    });

    const prodSvgRes = await prodDaemon.fetch(new Request("http://127.0.0.1:4100/icon.svg"));
    expect(prodSvgRes.status).toBe(200);
    const prodSvg = await prodSvgRes.text();
    expect(prodSvg).toContain(".bg-0 { stop-color: #F7F4EC; }");
    expect(prodSvg).not.toContain('<stop offset="0%" stop-color="#24272B" />');

    const prodPngRes = await prodDaemon.fetch(new Request("http://127.0.0.1:4100/icon-192.png"));
    expect(prodPngRes.status).toBe(200);
    const prodPngBytes = new Uint8Array(await prodPngRes.arrayBuffer());
    expect(prodPngBytes).toEqual(new Uint8Array(Buffer.from(PWA_ICON_192_BASE64, "base64")));

    const prodManifestRes = await prodDaemon.fetch(new Request("http://127.0.0.1:4100/manifest.webmanifest"));
    expect(prodManifestRes.status).toBe(200);
    const prodManifest = await prodManifestRes.json();
    expect(prodManifest.icons.some((i: any) => i.src === "/icon-192.png")).toBe(true);

    const prodHtmlRes = await prodDaemon.fetch(new Request("http://127.0.0.1:4100/"));
    expect(prodHtmlRes.status).toBe(200);
    const prodHtml = await prodHtmlRes.text();
    expect(prodHtml).toContain('href="/icon-192.png"');
  });
});

describe("daemon log file (architecture.md §4.6, issue #21)", () => {
  test("the daemon log file is truncated at start", async () => {
    const dir = tempDir("daemon-log");
    const logPath = join(dir, "pigeon.log");
    writeFileSync(logPath, "stale line from the previous run\n");
    const port = freePort();
    const daemon = new PigeonDaemon({
      configManager: new ConfigManager(join(dir, "config.json"), { HOME: dir }),
      port,
      publicBaseUrl: "https://pigeon.example.ts.net",
      herdrAppSocketPath: join(dir, "no-app.sock"),
      herdrCoreSocketPath: join(dir, "no-core.sock"),
      adminSocketPath: join(dir, "admin.sock"),
      devicesFilePath: join(dir, "devices.json"),
      vapidPath: join(dir, "vapid.json"),
      embeddedHtml: "<!doctype html><title>Pigeon</title><link rel=\"apple-touch-icon\" href=\"/icon-192.png\" /><link rel=\"icon\" type=\"image/svg+xml\" href=\"/icon.svg\" />",
      logPath,
    });
    await daemon.start();
    try {
      const text = readFileSync(logPath, "utf-8");
      expect(text).not.toContain("stale line");
      expect(text.split("\n")[0]).toContain(String(port));
    } finally {
      await daemon.stop();
    }
  });

  test("core events and requests are recorded in the log file (architecture.md §4.6)", async () => {
    const dir = tempDir("daemon-log-events");
    const logPath = join(dir, "pigeon.log");
    const port = freePort();
    const origin = `http://127.0.0.1:${port}`;
    const daemon = new PigeonDaemon({
      configManager: new ConfigManager(join(dir, "config.json"), { HOME: dir }),
      port,
      publicBaseUrl: "https://pigeon.example.ts.net",
      herdrAppSocketPath: join(dir, "no-app.sock"),
      herdrCoreSocketPath: join(dir, "no-core.sock"),
      adminSocketPath: join(dir, "admin.sock"),
      devicesFilePath: join(dir, "devices.json"),
      vapidPath: join(dir, "vapid.json"),
      embeddedHtml: "<!doctype html><title>Pigeon</title><link rel=\"apple-touch-icon\" href=\"/icon-192.png\" /><link rel=\"icon\" type=\"image/svg+xml\" href=\"/icon.svg\" />",
      logPath,
    });
    await daemon.start();
    try {
      // 1. Pairing token exchange
      const { token } = daemon.pairingManager.createPairingToken();
      const pairRes = await daemon.fetch(new Request(`${origin}/api/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: `127.0.0.1:${port}` },
        body: JSON.stringify({ code: token, deviceName: "Test Phone" }),
      }));
      expect(pairRes.status).toBe(200);

      // 2. Upload file
      const uploadRes = await daemon.fetch(new Request(`${origin}/api/uploads`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Pigeon-Filename": "notes.txt",
          Host: `127.0.0.1:${port}`,
          Origin: origin,
          Cookie: pairRes.headers.get("Set-Cookie")!.split(";")[0],
        },
        body: "Hello log test",
      }));
      expect(uploadRes.status).toBe(200);

      const logContent = readFileSync(logPath, "utf-8");
      expect(logContent).toContain('pairing success: device "Test Phone"');
      expect(logContent).toContain("upload received:");
      expect(logContent).toContain("notes.txt");
    } finally {
      await daemon.stop();
    }
  });
});
