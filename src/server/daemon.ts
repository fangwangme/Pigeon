import { join } from "node:path";
import { networkInterfaces } from "node:os";
import type { Server, ServerWebSocket } from "bun";
import { HerdrClient } from "./herdr-client";
import { PairingManager } from "./pairing";
import { PushManager, type PushSubscriptionData } from "./push";
import { WsServer, newConnectionId, SERVER_VERSION, type ClientConnectionData } from "./ws-server";
import { EMBEDDED_HTML } from "./embedded-html";
import { ConfigManager } from "./config-manager";
import { PWA_MANIFEST, PWA_SW_SCRIPT, PWA_ICON_SVG, PWA_ICON_192_BASE64, PWA_ICON_512_BASE64 } from "./pwa-assets";

export interface DaemonConfig {
  configManager: ConfigManager;
  port?: number;
  insecureDev?: boolean;
  publicBaseUrl?: string;
  herdrSocketPath?: string;
  /** Overrides for tests; production derives these from the config's state directory. */
  adminSocketPath?: string;
  devicesFilePath?: string;
  vapidPath?: string;
  embeddedHtml?: string;
}

export interface ResolvedDaemonConfig {
  port: number;
  host: string;
  insecureDev: boolean;
  publicBaseUrl: string;
  herdrSocketPath: string;
  adminSocketPath: string;
  devicesFilePath: string;
  vapidPath: string;
}

const VIRTUAL_IFACE_RE = /^(docker|br-|veth|virbr|vmnet|vboxnet|lo|tailscale|tun|tap|wg)/;
const VITE_DEV_PORT = 5173;
const COOKIE_MAX_AGE_S = 31536000; // security-and-pairing.md §2: 1-year session cookie

function isPrivateIPv4(addr: string): boolean {
  const [a, b] = addr.split(".").map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** LAN address for insecure-dev pairing links: a private IPv4 on a physical interface. */
export function detectLocalIp(): string | null {
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (!list || VIRTUAL_IFACE_RE.test(name)) continue;
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal && isPrivateIPv4(iface.address)) return iface.address;
    }
  }
  return null;
}

/** Tailscale MagicDNS name of this machine, or null when Tailscale is absent or not running. */
export function detectTailscaleDns(): string | null {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["tailscale", "status", "--json"], { timeout: 2000, stderr: "ignore" });
  } catch {
    return null; // tailscale binary not installed
  }
  if (proc.exitCode !== 0 || !proc.stdout) return null;
  const dns: string | undefined = JSON.parse(proc.stdout.toString()).Self?.DNSName;
  return dns ? dns.replace(/\.+$/, "") : null;
}

/**
 * Works out where the phone will reach the daemon. Without Tailscale or an explicit URL, a
 * non-dev daemon (bound to loopback) cannot be reached from a phone, so that is an error rather
 * than a QR code that never opens.
 */
export function resolvePublicBaseUrl(
  opts: { configured?: string; insecureDev: boolean; port: number },
  detectTs: () => string | null = detectTailscaleDns
): string {
  if (opts.configured) return opts.configured.replace(/\/+$/, "");
  if (opts.insecureDev) {
    const ip = detectLocalIp();
    if (!ip) throw new Error("--insecure-dev needs a private LAN IPv4 address, but none was found. Pass --public-url.");
    return `http://${ip}:${opts.port}`;
  }
  const ts = detectTs();
  if (ts) return `https://${ts}`;
  throw new Error(
    "No phone-reachable address: Tailscale is not running and no publicBaseUrl is configured.\n" +
      "Use one of: run `tailscale serve` and start again, pass --public-url <https-url>, or use --insecure-dev on a trusted LAN."
  );
}

function hostOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname; // keeps IPv6 brackets: "[::1]"
  } catch {
    return null;
  }
}

export class PigeonDaemon {
  public config: ResolvedDaemonConfig;
  public configManager: ConfigManager;
  public herdrClient: HerdrClient;
  public pairingManager: PairingManager;
  public pushManager: PushManager;
  public wsServer: WsServer;
  private bunServer: Server<ClientConnectionData> | null = null;
  private html: string;
  private allowedHosts: Set<string>;
  private allowedOrigins: Set<string>;
  private icon192 = Buffer.from(PWA_ICON_192_BASE64, "base64");
  private icon512 = Buffer.from(PWA_ICON_512_BASE64, "base64");

  constructor(opts: DaemonConfig) {
    this.configManager = opts.configManager;
    const serverCfg = this.configManager.getServerConfig();
    const port = opts.port ?? serverCfg.port;
    const insecureDev = opts.insecureDev ?? serverCfg.insecureDev;

    this.config = {
      port,
      host: serverCfg.host,
      insecureDev,
      publicBaseUrl: resolvePublicBaseUrl({ configured: opts.publicBaseUrl || serverCfg.publicBaseUrl, insecureDev, port }),
      herdrSocketPath: opts.herdrSocketPath || serverCfg.herdrSocketPath,
      adminSocketPath: opts.adminSocketPath || serverCfg.adminSocketPath,
      devicesFilePath: opts.devicesFilePath || join(serverCfg.stateDir, "devices.json"),
      vapidPath: opts.vapidPath || join(serverCfg.stateDir, "vapid.json"),
    };

    // Only the HTML compiled into this build is served (never a file found via the cwd).
    this.html = opts.embeddedHtml || EMBEDDED_HTML;

    const publicUrl = new URL(this.config.publicBaseUrl);
    this.allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", publicUrl.hostname]);
    this.allowedOrigins = new Set([publicUrl.origin]);
    if (insecureDev) {
      for (const h of ["localhost", "127.0.0.1", "[::1]"]) {
        this.allowedOrigins.add(`http://${h}:${port}`);
        this.allowedOrigins.add(`http://${h}:${VITE_DEV_PORT}`); // vite dev server proxying /ws
      }
      this.allowedOrigins.add(`http://${publicUrl.hostname}:${VITE_DEV_PORT}`);
    }

    this.herdrClient = new HerdrClient({ socketPath: this.config.herdrSocketPath });
    this.pairingManager = new PairingManager({
      publicBaseUrl: this.config.publicBaseUrl,
      insecureDev,
      adminSocketPath: this.config.adminSocketPath,
      devicesFilePath: this.config.devicesFilePath,
    });
    this.pushManager = new PushManager(this.config.vapidPath);
    this.wsServer = new WsServer({
      herdrClient: this.herdrClient,
      pushManager: this.pushManager,
      configManager: this.configManager,
    });
    this.pairingManager.on("device_revoked", (deviceId) => this.wsServer.closeDevice(deviceId));
  }

  public parseCookie(req: Request): Record<string, string> {
    const cookies: Record<string, string> = {};
    for (const pair of (req.headers.get("cookie") || "").split(";")) {
      const idx = pair.indexOf("=");
      if (idx > 0) cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
    return cookies;
  }

  /** security-and-pairing.md §4: exact Host and Origin match, against CSWSH and DNS rebinding. */
  private checkHostAndOrigin(req: Request): Response | null {
    const host = hostOf(req.headers.get("host") || "");
    if (!host || !this.allowedHosts.has(host)) return new Response("Forbidden Host", { status: 403 });
    const origin = req.headers.get("origin");
    if (!origin || !this.allowedOrigins.has(origin)) return new Response("Forbidden Origin", { status: 403 });
    return null;
  }

  public async start(): Promise<void> {
    await this.pairingManager.startAdminSocket();
    await this.herdrClient.connect();

    if (this.config.insecureDev) {
      console.warn(
        "\n\x1b[41;97m WARNING \x1b[0m --insecure-dev: serving plain HTTP on every interface. Anyone on this network who\n" +
          "obtains the pairing link can control your terminals. Web Push is disabled in this mode.\n"
      );
    }

    const self = this;
    const cookieName = this.pairingManager.getCookieName();
    const isHttps = this.config.publicBaseUrl.startsWith("https://");
    const csp =
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; object-src 'none';";
    const htmlResponse = () =>
      new Response(self.html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp } });
    const sessionOf = (req: Request) => self.pairingManager.validateSession(self.parseCookie(req)[cookieName]);

    this.bunServer = Bun.serve<ClientConnectionData>({
      port: this.config.port,
      // No hostname: Bun listens dual-stack on every interface (LESSONS: Chromium resolves
      // localhost to ::1). `server.host` pins one address. Host/Origin checks still gate /ws.
      ...(this.config.host ? { hostname: this.config.host } : {}),

      async fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === "/ws") {
          const rejected = self.checkHostAndOrigin(req);
          if (rejected) return rejected;
          const session = sessionOf(req);
          if (!session) return new Response("Unauthorized", { status: 401, statusText: "ERR_UNAUTHORIZED" });
          const upgraded = server.upgrade(req, {
            data: { session, connectionId: newConnectionId(), subscribedPaneId: null, lastPingTime: Date.now() },
          });
          return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname === "/api/pair" && req.method === "POST") {
          let body: any;
          try {
            body = await req.json();
          } catch {
            return Response.json({ success: false, error: "Body must be JSON" }, { status: 400 });
          }
          const { code, deviceName } = body || {};
          if (typeof code !== "string" || code.length > 64 || (deviceName !== undefined && (typeof deviceName !== "string" || deviceName.length > 128))) {
            return Response.json({ success: false, error: "Expected { code: string, deviceName?: string }" }, { status: 400 });
          }
          const res = self.pairingManager.exchangeToken(code, deviceName || "Mobile Chrome");
          if (!res.success) return Response.json({ success: false, error: res.error }, { status: 400 });
          const secureFlag = isHttps ? "; Secure" : "";
          return Response.json(
            { success: true, deviceId: res.deviceId },
            { headers: { "Set-Cookie": `${cookieName}=${res.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${secureFlag}` } }
          );
        }

        if (url.pathname === "/api/version") return Response.json({ version: SERVER_VERSION, name: "pigeon" });

        if (url.pathname === "/api/auth/status") {
          const session = sessionOf(req);
          return Response.json({ authenticated: !!session, deviceId: session?.deviceId || null });
        }

        if (url.pathname === "/api/push/vapid-public-key") return Response.json({ publicKey: self.pushManager.getPublicKey() });

        if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
          if (!sessionOf(req)) return new Response("Unauthorized", { status: 401 });
          let sub: any;
          try {
            sub = await req.json();
          } catch {
            return Response.json({ success: false, error: "Body must be JSON" }, { status: 400 });
          }
          if (!isPushSubscription(sub)) return Response.json({ success: false, error: "Invalid push subscription" }, { status: 400 });
          self.pushManager.addSubscription(sub);
          return Response.json({ success: true });
        }

        if (url.pathname === "/manifest.webmanifest" || url.pathname === "/manifest.json") {
          return Response.json(PWA_MANIFEST, {
            headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=3600" },
          });
        }
        if (url.pathname === "/sw.js") {
          return new Response(PWA_SW_SCRIPT, {
            headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" },
          });
        }
        if (url.pathname === "/icon.svg") {
          return new Response(PWA_ICON_SVG, { headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
        }
        if (url.pathname === "/icon-192.png") {
          return new Response(self.icon192, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
        }
        if (url.pathname === "/icon-512.png") {
          return new Response(self.icon512, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
        }
        if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/pair") return htmlResponse();

        return new Response("Not Found", { status: 404 });
      },

      websocket: {
        open(ws) {
          self.wsServer.handleOpen(ws);
        },
        message(ws, msg) {
          self.wsServer.handleMessage(ws, msg).catch((err) => console.error("[pigeon] WebSocket message handling crashed:", err));
        },
        close(ws) {
          self.wsServer.handleClose(ws);
        },
      },
    });
  }

  public stop(): void {
    this.bunServer?.stop(true);
    this.bunServer = null;
    this.herdrClient.disconnect();
    this.pairingManager.stopAdminSocket();
    this.wsServer.destroy();
  }
}

function isPushSubscription(v: any): v is PushSubscriptionData {
  return (
    typeof v === "object" && v !== null &&
    typeof v.endpoint === "string" && v.endpoint.startsWith("https://") && v.endpoint.length < 2048 &&
    typeof v.keys?.p256dh === "string" && typeof v.keys?.auth === "string"
  );
}
