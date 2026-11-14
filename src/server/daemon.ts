import { join, dirname } from "node:path";
import { networkInterfaces } from "node:os";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import type { Server } from "bun";
import { HerdrClient } from "./herdr-client";
import { PairingManager } from "./pairing";
import { PushManager, type PushSubscriptionData } from "./push";
import { WsServer, newConnectionId, SERVER_VERSION, type ClientConnectionData } from "./ws-server";
import { EMBEDDED_HTML } from "./embedded-html";
import { ConfigManager, resolveInstancePaths, resolveProductionPort, DEFAULT_PORT, DEFAULT_TAILSCALE_HTTPS_PORT, DEFAULT_TEST_TAILSCALE_HTTPS_PORT } from "./config-manager";
import { ModelCatalog } from "./model-catalog";
import { MAX_UPLOAD_BYTES, UploadStore } from "./uploads";
import { QuotaService } from "./quota/index";
import { UsageService } from "./usage/index";
import {
  PWA_MANIFEST,
  PWA_MANIFEST_DARK,
  PWA_SW_SCRIPT,
  PWA_ICON_SVG,
  PWA_ICON_192_BASE64,
  PWA_ICON_512_BASE64,
  PWA_ICON_DARK_SVG,
  PWA_ICON_DARK_192_BASE64,
  PWA_ICON_DARK_512_BASE64,
} from "./pwa-assets";

export interface DaemonConfig {
  configManager: ConfigManager;
  port?: number;
  insecureDev?: boolean;
  publicBaseUrl?: string;
  herdrAppSocketPath?: string;
  herdrCoreSocketPath?: string;
  /** Overrides for tests; production derives these from the config's state directory. */
  adminSocketPath?: string;
  devicesFilePath?: string;
  queueFilePath?: string;
  vapidPath?: string;
  pushSubscriptionsPath?: string;
  uploadsDir?: string;
  embeddedHtml?: string;
  logPath?: string;
  productionPort?: number;
  autoServe?: boolean;
}

export interface ResolvedDaemonConfig {
  port: number;
  host: string;
  insecureDev: boolean;
  publicBaseUrl: string;
  herdrAppSocketPath: string;
  herdrCoreSocketPath: string;
  adminSocketPath: string;
  devicesFilePath: string;
  queueFilePath: string;
  vapidPath: string;
  pushSubscriptionsPath: string;
  uploadsDir: string;
  logPath: string;
}

const VIRTUAL_IFACE_RE = /^(docker|br-|veth|virbr|vmnet|vboxnet|lo|tailscale|tun|tap|wg)/;
const VITE_DEV_PORT = 5173;
const COOKIE_MAX_AGE_S = 31536000; // security-and-pairing.md §2: 1-year session cookie

function isPrivateIPv4(addr: string): boolean {
  const [a, b] = addr.split(".").map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** LAN address for insecure-dev pairing links: a private IPv4 on a physical interface. */
function detectLocalIp(): string | null {
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (!list || VIRTUAL_IFACE_RE.test(name)) continue;
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal && isPrivateIPv4(iface.address)) return iface.address;
    }
  }
  return null;
}

function detectTailscaleHostname(): string | null {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["tailscale", "status", "--json"], { timeout: 2000, stderr: "ignore" });
  } catch {
    return null;
  }
  if (proc.exitCode !== 0 || !proc.stdout) return null;
  try {
    const dns: string | undefined = JSON.parse(proc.stdout.toString()).Self?.DNSName;
    return dns ? dns.replace(/\.+$/, "") : null;
  } catch {
    return null;
  }
}

function tryAutoTailscaleServe(port: number, httpsPort: number): boolean {
  try {
    const res = Bun.spawnSync(["tailscale", "serve", "--bg", `--https=${httpsPort}`, String(port)], {
      timeout: 3000,
      stderr: "ignore",
    });
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

export interface ServeCheckResult {
  host: string | null;
  conflict?: { httpsPort: number; target: string };
}

function checkTailscaleServe(port: number, httpsPort: number, enableAutoServe: boolean = true): ServeCheckResult {
  const dns = detectTailscaleHostname();
  if (!dns) return { host: null };

  try {
    const serveProc = Bun.spawnSync(["tailscale", "serve", "status", "--json"], { timeout: 2000, stderr: "ignore" });
    if (serveProc.exitCode !== 0 || !serveProc.stdout) return { host: null };
    const text = serveProc.stdout.toString().trim();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      return { host: null };
    }

    let rootProxy: string | undefined;
    if (data.Web && typeof data.Web === "object") {
      for (const [k, entry] of Object.entries(data.Web)) {
        const portMatch = k.endsWith(`:${httpsPort}`) || (httpsPort === 443 && !k.includes(":"));
        if (portMatch) {
          rootProxy = (entry as any)?.Handlers?.["/"]?.Proxy;
          break;
        }
      }
    }

    const isTargetingPort =
      rootProxy === `http://127.0.0.1:${port}` ||
      rootProxy === `http://localhost:${port}` ||
      rootProxy === `http://[::1]:${port}`;

    if (isTargetingPort) {
      return { host: httpsPort === 443 ? dns : `${dns}:${httpsPort}` };
    }

    if (rootProxy) {
      return { host: null, conflict: { httpsPort, target: rootProxy } };
    }

    if (enableAutoServe && tryAutoTailscaleServe(port, httpsPort)) {
      return { host: httpsPort === 443 ? dns : `${dns}:${httpsPort}` };
    }

    return { host: null };
  } catch {
    return { host: null };
  }
}

function detectTailscaleIp(): string | null {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["tailscale", "status", "--json"], { timeout: 2000, stderr: "ignore" });
  } catch {
    return null;
  }
  if (proc.exitCode !== 0 || !proc.stdout) return null;
  try {
    const data = JSON.parse(proc.stdout.toString());
    const ips: string[] | undefined = data.Self?.TailscaleIPs;
    if (Array.isArray(ips)) {
      const v4 = ips.find((ip) => typeof ip === "string" && !ip.includes(":"));
      if (v4) return v4;
    }
  } catch {
    return null;
  }
  return null;
}

export interface AccessProbes {
  tailscaleServeDns?: () => string | null;
  tailscaleIp?: () => string | null;
  lanIp?: () => string | null;
}

export interface ResolvedAccess {
  publicBaseUrl: string;
  secure: boolean;
  bindHost: string;
  alternatives: Array<{ mode: string; url: string }>;
  serveConflict?: { httpsPort: number; target: string };
}

export function resolveAccess(
  opts: {
    configured?: string;
    insecureDev?: boolean;
    port: number;
    tailscaleHttpsPort?: number;
    isProduction?: boolean;
    autoServe?: boolean;
  },
  probes: AccessProbes = {}
): ResolvedAccess {
  const httpsPort =
    opts.tailscaleHttpsPort ??
    (opts.port === DEFAULT_PORT ? DEFAULT_TAILSCALE_HTTPS_PORT : DEFAULT_TEST_TAILSCALE_HTTPS_PORT);
  const serveResult =
    !opts.insecureDev && !opts.configured && !probes.tailscaleServeDns
      ? checkTailscaleServe(opts.port, httpsPort, opts.autoServe ?? true)
      : { host: null };

  const tailscaleServeDns = probes.tailscaleServeDns ?? (() => serveResult.host);
  const tailscaleIp = probes.tailscaleIp ?? detectTailscaleIp;
  const lanIp = probes.lanIp ?? detectLocalIp;

  const alternatives: Array<{ mode: string; url: string }> = [];

  const tsServe = !opts.insecureDev ? tailscaleServeDns() : null;
  if (tsServe) alternatives.push({ mode: "Tailscale Serve", url: `https://${tsServe.replace(/\/+$/, "")}` });

  const tsIp = tailscaleIp();
  if (tsIp) alternatives.push({ mode: "Tailscale IP", url: `http://${tsIp}:${opts.port}` });

  const lan = lanIp();
  if (lan) alternatives.push({ mode: "LAN", url: `http://${lan}:${opts.port}` });

  alternatives.push({ mode: "Localhost", url: `http://localhost:${opts.port}` });

  if (opts.configured) {
    const clean = opts.configured.replace(/\/+$/, "");
    return {
      publicBaseUrl: clean,
      secure: clean.startsWith("https://"),
      bindHost: "",
      alternatives,
    };
  }

  if (!opts.insecureDev) {
    if (tsServe) {
      return {
        publicBaseUrl: `https://${tsServe.replace(/\/+$/, "")}`,
        secure: true,
        bindHost: "127.0.0.1",
        alternatives,
      };
    }
    if (tsIp) {
      return {
        publicBaseUrl: `http://${tsIp}:${opts.port}`,
        secure: false,
        bindHost: "",
        alternatives,
        serveConflict: serveResult.conflict,
      };
    }
  }

  if (lan) {
    return {
      publicBaseUrl: `http://${lan}:${opts.port}`,
      secure: false,
      bindHost: "",
      alternatives,
      serveConflict: serveResult.conflict,
    };
  }

  return {
    publicBaseUrl: `http://localhost:${opts.port}`,
    secure: false,
    bindHost: "",
    alternatives,
    serveConflict: serveResult.conflict,
  };
}

/**
 * Works out where the phone will reach the daemon.
 */
export function resolvePublicBaseUrl(
  opts: { configured?: string; insecureDev: boolean; port: number },
  detectTs?: (port?: number) => string | null
): string {
  const probes = detectTs ? { tailscaleServeDns: () => detectTs(opts.port) } : {};
  return resolveAccess(opts, probes).publicBaseUrl;
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
  public access: ResolvedAccess;
  public configManager: ConfigManager;
  public herdrClient: HerdrClient;
  public pairingManager: PairingManager;
  public pushManager: PushManager;
  public wsServer: WsServer;
  public uploadStore: UploadStore;
  private bunServer: Server<ClientConnectionData> | null = null;
  private html: string;
  private allowedHosts: Set<string>;
  private allowedOrigins: Set<string>;
  private icon192 = Buffer.from(PWA_ICON_192_BASE64, "base64");
  private icon512 = Buffer.from(PWA_ICON_512_BASE64, "base64");
  private iconDark192 = Buffer.from(PWA_ICON_DARK_192_BASE64, "base64");
  private iconDark512 = Buffer.from(PWA_ICON_DARK_512_BASE64, "base64");
  public readonly isProduction: boolean;

  constructor(opts: DaemonConfig) {
    this.configManager = opts.configManager;
    const serverCfg = this.configManager.getServerConfig();
    const port = opts.port ?? serverCfg.port;
    const insecureDev = opts.insecureDev ?? serverCfg.insecureDev;
    const productionPort = opts.productionPort ?? resolveProductionPort(this.configManager.env);
    const isProduction = port === productionPort;
    this.isProduction = isProduction;
    const tailscaleHttpsPort =
      serverCfg.tailscaleHttpsPort ??
      (isProduction ? DEFAULT_TAILSCALE_HTTPS_PORT : DEFAULT_TEST_TAILSCALE_HTTPS_PORT);
    const access = resolveAccess({
      configured: opts.publicBaseUrl || serverCfg.publicBaseUrl,
      insecureDev,
      port,
      tailscaleHttpsPort,
      isProduction,
      autoServe: opts.autoServe,
    });
    this.access = access;

    const instancePaths = resolveInstancePaths({ port, productionPort, env: this.configManager.env });
    const stateDir = isProduction ? serverCfg.stateDir : instancePaths.stateDir;

    this.config = {
      port,
      host: serverCfg.host || access.bindHost || "",
      insecureDev,
      publicBaseUrl: access.publicBaseUrl,
      herdrAppSocketPath: opts.herdrAppSocketPath || serverCfg.herdrAppSocketPath,
      herdrCoreSocketPath: opts.herdrCoreSocketPath || serverCfg.herdrCoreSocketPath,
      adminSocketPath: opts.adminSocketPath || (isProduction ? serverCfg.adminSocketPath : instancePaths.adminSocketPath),
      devicesFilePath: opts.devicesFilePath || (isProduction ? join(serverCfg.stateDir, "devices.json") : instancePaths.devicesPath),
      queueFilePath: opts.queueFilePath || (isProduction ? join(serverCfg.stateDir, "queue.json") : instancePaths.queuePath),
      vapidPath: opts.vapidPath || (isProduction ? join(serverCfg.stateDir, "vapid.json") : instancePaths.vapidPath),
      pushSubscriptionsPath: opts.pushSubscriptionsPath || (isProduction ? join(serverCfg.stateDir, "push-subscriptions.json") : instancePaths.pushSubscriptionsPath),
      uploadsDir: opts.uploadsDir || (isProduction ? join(serverCfg.stateDir, "uploads") : instancePaths.uploadsDir),
      logPath: opts.logPath || (isProduction ? join(serverCfg.stateDir, "pigeon.log") : instancePaths.logPath),
    };

    // Only the HTML compiled into this build is served (never a file found via the cwd).
    this.html = opts.embeddedHtml || EMBEDDED_HTML;

    const publicUrl = new URL(this.config.publicBaseUrl);
    this.allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", publicUrl.hostname]);
    this.allowedOrigins = new Set([publicUrl.origin]);

    for (const alt of this.access.alternatives) {
      try {
        const u = new URL(alt.url);
        this.allowedHosts.add(u.hostname);
        this.allowedOrigins.add(u.origin);
        if (insecureDev) {
          this.allowedOrigins.add(`http://${u.hostname}:${port}`);
          this.allowedOrigins.add(`http://${u.hostname}:${VITE_DEV_PORT}`);
        }
      } catch {}
    }

    const tsHost = detectTailscaleHostname();
    if (tsHost) {
      this.allowedHosts.add(tsHost);
      this.allowedOrigins.add(`http://${tsHost}:${port}`);
      this.allowedOrigins.add(`https://${tsHost}`);
      this.allowedOrigins.add(`https://${tsHost}:${port}`);
      this.allowedOrigins.add(`https://${tsHost}:${tailscaleHttpsPort}`);
      if (insecureDev || !isProduction) {
        this.allowedOrigins.add(`http://${tsHost}:${VITE_DEV_PORT}`);
      }
    }

    if (insecureDev || !isProduction) {
      for (const h of ["localhost", "127.0.0.1", "[::1]"]) {
        this.allowedOrigins.add(`http://${h}:${port}`);
        this.allowedOrigins.add(`http://${h}:${VITE_DEV_PORT}`); // vite dev server proxying /ws
      }
      this.allowedOrigins.add(`http://${publicUrl.hostname}:${VITE_DEV_PORT}`);
    }

    if (!this.config.herdrCoreSocketPath) {
      throw new Error("Cannot locate the Herdr Core socket: set HC_TERMINAL_SOCKET or XDG_RUNTIME_DIR, or pass --herdr-core-sock");
    }
    this.herdrClient = new HerdrClient({
      appSocketPath: this.config.herdrAppSocketPath,
      coreSocketPath: this.config.herdrCoreSocketPath,
      logger: (msg) => this.log(msg),
      seenPanesFilePath: join(stateDir, "seen-panes.json"),
    });
    const quotaService = new QuotaService({ configManager: this.configManager });
    const usageService = new UsageService({ configManager: this.configManager });
    this.pairingManager = new PairingManager({
      publicBaseUrl: this.config.publicBaseUrl,
      insecureDev,
      adminSocketPath: this.config.adminSocketPath,
      devicesFilePath: this.config.devicesFilePath,
      rebuildUsage: () => usageService.rebuild(),
      getStatus: () => {
        const scanInfo = usageService.getLastScanInfo();
        return {
          herdrConnected: this.herdrClient.isConnected(),
          queues: this.wsServer.getQueueStatus(),
          lastUsageScan: {
            time: scanInfo.time,
            durationMs: scanInfo.durationMs,
          },
          sourceErrors: {
            usageScan: scanInfo.error,
            agentAdapters: this.wsServer.getSourceErrors(),
          },
        };
      },
    });
    this.pushManager = new PushManager(this.config.vapidPath, this.config.pushSubscriptionsPath, this.config.publicBaseUrl);
    this.pairingManager.on("device_revoked", (deviceId: string) => {
      this.log(`device revoked: ${deviceId}`);
      this.pushManager.removeSubscriptionByDevice(deviceId);
    });
    this.uploadStore = new UploadStore(this.config.uploadsDir);
    this.wsServer = new WsServer({
      buildId: createHash("sha256").update(this.html).digest("hex").slice(0, 12),
      herdrClient: this.herdrClient,
      pushManager: this.pushManager,
      configManager: this.configManager,
      uploadStore: this.uploadStore,
      pairingManager: this.pairingManager,
      modelCatalog: new ModelCatalog({ cachePath: join(stateDir, "models.json") }),
      queueFilePath: this.config.queueFilePath,
      port: this.config.port,
      productionPort,
      environmentKind: this.config.insecureDev ? "dev" : (isProduction ? undefined : "test"),
      quotaService,
      usageService,
      logger: (msg) => this.log(msg),
    });
  }

  private parseCookie(req: Request): Record<string, string> {
    const cookies: Record<string, string> = {};
    for (const pair of (req.headers.get("cookie") || "").split(";")) {
      const idx = pair.indexOf("=");
      if (idx > 0) cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
    return cookies;
  }

  /** security-and-pairing.md §4: exact Host and Origin match, against CSWSH and DNS rebinding. */
  private checkHostAndOrigin(req: Request, requireOrigin = true): Response | null {
    const host = hostOf(req.headers.get("host") || "");
    if (!host || !this.allowedHosts.has(host)) return new Response("Forbidden Host", { status: 403 });
    const origin = req.headers.get("origin");
    if (origin) {
      if (!this.allowedOrigins.has(origin)) return new Response("Forbidden Origin", { status: 403 });
    } else if (requireOrigin) {
      return new Response("Forbidden Origin", { status: 403 });
    }
    return null;
  }

  public log(msg: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}`;
    if (this.config.logPath) appendFileSync(this.config.logPath, line + "\n", "utf-8");
  }

  /** herdr-adapter.md §7.1: fill the agents' model lists in the background; `welcome` never waits for it. */
  public fillModelCatalog(): void {
    void this.wsServer.refreshModels();
  }

  private installProcessHandlers(): void {
    if (Daemon.processHandlersInstalled) return;
    Daemon.processHandlersInstalled = true;
    process.on("uncaughtException", (err) => {
      this.log(`uncaughtException: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    });
    process.on("unhandledRejection", (reason) => {
      this.log(`unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
    });
  }

  private static processHandlersInstalled = false;

  public async start(): Promise<void> {
    this.installProcessHandlers();
    if (this.config.logPath) {
      mkdirSync(dirname(this.config.logPath), { recursive: true });
      writeFileSync(this.config.logPath, `[${new Date().toISOString()}] Pigeon daemon ${SERVER_VERSION} on port ${this.config.port}\n`, "utf-8");
    }
    await this.pairingManager.startAdminSocket();
    await this.herdrClient.connect();

    const isHttps = this.config.publicBaseUrl.startsWith("https://");

    if (this.config.insecureDev) {
      console.warn(
        "\n\x1b[41;97m WARNING \x1b[0m --insecure-dev: serving plain HTTP on every interface. Anyone on this network who\n" +
          "obtains the pairing link can control your terminals. Web Push is disabled in this mode.\n"
      );
    } else if (!isHttps) {
      let conflictNote = "";
      if (this.access.serveConflict) {
        conflictNote =
          `  Tailscale Serve port ${this.access.serveConflict.httpsPort} is currently proxying to ${this.access.serveConflict.target}.\n` +
          `  To route to this instance, run: tailscale serve --bg --https=${this.access.serveConflict.httpsPort} ${this.config.port}\n` +
          `  Or configure a different port in config.json (server.tailscaleHttpsPort).\n`;
      }
      console.warn(
        "\n\x1b[43;30m WARNING \x1b[0m Plain-HTTP mode: Web push notifications are unavailable over plain HTTP (Tailscale HTTPS required for push).\n" +
          conflictNote +
          "Reachable addresses:\n" +
          this.access.alternatives.map((a) => `  - ${a.mode}: ${a.url}`).join("\n") + "\n"
      );
    }

    const self = this;
    const cookieName = this.pairingManager.getCookieName();
    const sessionOf = (req: Request) => self.pairingManager.validateSession(self.parseCookie(req)[cookieName]);

    try {
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

          return self.handleHttp(req);
        },

      websocket: {
        perMessageDeflate: true,
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
    } catch (err: any) {
      if (err?.code === "EADDRINUSE" || String(err).includes("already in use")) {
        let holder = "";
        try {
          const lsof = Bun.spawnSync(["lsof", "-i", `:${this.config.port}`, "-sTCP:LISTEN", "-t"]);
          if (lsof.exitCode === 0 && lsof.stdout) {
            const pid = lsof.stdout.toString().trim().split("\n")[0];
            if (pid) {
              const ps = Bun.spawnSync(["ps", "-p", pid, "-o", "comm="]);
              holder = ` by process ${pid} (${ps.stdout.toString().trim()})`;
            }
          }
        } catch {}
        throw new Error(`Port ${this.config.port} is already in use${holder}. Edit server.port in config.json or stop the other process.`);
      }
      throw err;
    }
  }

  public async handleHttp(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const cookieName = this.pairingManager.getCookieName();
    const isHttps = this.config.publicBaseUrl.startsWith("https://");
    const sessionOf = (r: Request) => this.pairingManager.validateSession(this.parseCookie(r)[cookieName]);
    const csp =
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none';";
    const getHtml = () => {
      if (this.isProduction) return this.html;
      return this.html
        .replaceAll(/href="\.?\/?icon-192\.png"/g, 'href="/icon-dark-192.png"')
        .replaceAll(/href="\.?\/?icon-512\.png"/g, 'href="/icon-dark-512.png"')
        .replaceAll(/href="\.?\/?icon\.svg"/g, 'href="/icon-dark.svg"');
    };
    const htmlResponse = () =>
      new Response(getHtml(), { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp } });

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
      const res = this.pairingManager.exchangeToken(code, deviceName || "Mobile Chrome", this.parseCookie(req)[cookieName]);
      if (!res.success) {
        this.log(`pairing failed: ${res.error}`);
        return Response.json({ success: false, error: res.error }, { status: 400 });
      }
      this.log(`pairing success: device "${deviceName || "Mobile Chrome"}" (id=${res.deviceId})`);
      const secureFlag = isHttps ? "; Secure" : "";
      return Response.json(
        { success: true, deviceId: res.deviceId },
        { headers: { "Set-Cookie": `${cookieName}=${res.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${secureFlag}` } }
      );
    }

    if (url.pathname === "/api/uploads" && req.method === "POST") {
      const rejected = this.checkHostAndOrigin(req);
      if (rejected) return rejected;
      if (!sessionOf(req)) return new Response("Unauthorized", { status: 401 });
      const declared = Number(req.headers.get("content-length") || "0");
      if (declared > MAX_UPLOAD_BYTES) return Response.json({ error: "File too large" }, { status: 413 });
      let name: string;
      try {
        name = decodeURIComponent(req.headers.get("x-pigeon-filename") || "");
      } catch {
        return Response.json({ error: "Bad file name" }, { status: 400 });
      }
      if (!name || name.length > 200) return Response.json({ error: "X-Pigeon-Filename is required" }, { status: 400 });
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_UPLOAD_BYTES) return Response.json({ error: "File too large" }, { status: 413 });
      if (bytes.length === 0) return Response.json({ error: "Empty file" }, { status: 400 });
      const mime = (req.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
      const info = this.uploadStore.save({ name, mime, bytes });
      this.log(`upload received: ${info.id} (${info.name}, ${info.size} bytes, mime=${info.mime})`);
      return Response.json({ id: info.id, name: info.name, size: info.size, mime: info.mime });
    }

    const uploadMatch = url.pathname.match(/^\/api\/uploads\/(up_[0-9a-f]{16})$/);
    if (uploadMatch && req.method === "GET") {
      const rejected = this.checkHostAndOrigin(req, false);
      if (rejected) return rejected;
      if (!sessionOf(req)) return new Response("Unauthorized", { status: 401 });
      const info = this.uploadStore.get(uploadMatch[1]);
      if (!info) return new Response("Not found", { status: 404 });
      const file = Bun.file(info.path);
      const mime = (info.mime || "application/octet-stream").toLowerCase();
      const isRaster = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/heic"].includes(mime);
      const disposition = isRaster ? "inline" : "attachment";
      return new Response(file, {
        headers: {
          "Content-Type": info.mime || "application/octet-stream",
          "Content-Disposition": `${disposition}; filename="${encodeURIComponent(info.name)}"`,
          "Cache-Control": "private, max-age=86400",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }

    if (url.pathname === "/api/version") return Response.json({ version: SERVER_VERSION, name: "pigeon" });

    if (url.pathname === "/api/auth/status") {
      const session = sessionOf(req);
      return Response.json({ authenticated: !!session, deviceId: session?.deviceId || null });
    }

    if (url.pathname === "/api/push/vapid-public-key") return Response.json({ publicKey: this.pushManager.getPublicKey() });

    if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
      const session = sessionOf(req);
      if (!session) return new Response("Unauthorized", { status: 401 });
      let sub: any;
      try {
        sub = await req.json();
      } catch {
        return Response.json({ success: false, error: "Body must be JSON" }, { status: 400 });
      }
      if (!isPushSubscription(sub)) return Response.json({ success: false, error: "Invalid push subscription" }, { status: 400 });
      this.pushManager.addSubscription({ ...sub, deviceId: session.deviceId });
      this.log(`push subscribed: device ${session.deviceId}`);
      return Response.json({ success: true });
    }

    if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
      const session = sessionOf(req);
      if (!session) return new Response("Unauthorized", { status: 401 });
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ success: false, error: "Body must be JSON" }, { status: 400 });
      }
      if (!body || typeof body.endpoint !== "string") {
        return Response.json({ success: false, error: "Invalid endpoint" }, { status: 400 });
      }
      this.pushManager.removeSubscription(body.endpoint);
      this.log(`push unsubscribed: device ${session.deviceId}`);
      return Response.json({ success: true });
    }

    if (url.pathname === "/manifest.webmanifest" || url.pathname === "/manifest.json") {
      return Response.json(this.isProduction ? PWA_MANIFEST : PWA_MANIFEST_DARK, {
        headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }
    if (url.pathname === "/sw.js") {
      return new Response(PWA_SW_SCRIPT, {
        headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" },
      });
    }
    const iconCache = this.isProduction ? "public, max-age=86400" : "no-cache, must-revalidate";
    if (url.pathname === "/icon.svg") {
      return new Response(this.isProduction ? PWA_ICON_SVG : PWA_ICON_DARK_SVG, {
        headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": iconCache },
      });
    }
    if (url.pathname === "/icon-192.png") {
      return new Response(this.isProduction ? this.icon192 : this.iconDark192, {
        headers: { "Content-Type": "image/png", "Cache-Control": iconCache },
      });
    }
    if (url.pathname === "/icon-512.png") {
      return new Response(this.isProduction ? this.icon512 : this.iconDark512, {
        headers: { "Content-Type": "image/png", "Cache-Control": iconCache },
      });
    }
    if (url.pathname === "/icon-dark.svg") {
      return new Response(PWA_ICON_DARK_SVG, {
        headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": iconCache },
      });
    }
    if (url.pathname === "/icon-dark-192.png") {
      return new Response(this.iconDark192, {
        headers: { "Content-Type": "image/png", "Cache-Control": iconCache },
      });
    }
    if (url.pathname === "/icon-dark-512.png") {
      return new Response(this.iconDark512, {
        headers: { "Content-Type": "image/png", "Cache-Control": iconCache },
      });
    }
    if (url.pathname === "/icon-light.svg") {
      return new Response(PWA_ICON_SVG, {
        headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": iconCache },
      });
    }
    if (url.pathname === "/icon-light-192.png") {
      return new Response(this.icon192, {
        headers: { "Content-Type": "image/png", "Cache-Control": iconCache },
      });
    }
    if (url.pathname === "/icon-light-512.png") {
      return new Response(this.icon512, {
        headers: { "Content-Type": "image/png", "Cache-Control": iconCache },
      });
    }
    if (url.pathname.startsWith("/apple-touch-icon")) {
      return new Response(this.isProduction ? this.icon192 : this.iconDark192, {
        headers: { "Content-Type": "image/png", "Cache-Control": iconCache },
      });
    }
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/pair") return htmlResponse();

    return new Response("Not Found", { status: 404 });
  }

  public async fetch(req: Request): Promise<Response> {
    return this.handleHttp(req);
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
  if (typeof v !== "object" || v === null) return false;
  if (
    typeof v.endpoint !== "string" ||
    (!v.endpoint.startsWith("https://") && !v.endpoint.startsWith("http://")) ||
    v.endpoint.length >= 2048
  ) {
    return false;
  }
  if (!v.keys || typeof v.keys.p256dh !== "string" || typeof v.keys.auth !== "string") {
    return false;
  }
  try {
    const p256dh = Buffer.from(v.keys.p256dh, "base64url");
    const auth = Buffer.from(v.keys.auth, "base64url");
    if (p256dh.length !== 65 || auth.length !== 16) return false;
  } catch {
    return false;
  }
  if (v.events !== undefined) {
    if (typeof v.events !== "object" || v.events === null) return false;
    if (typeof v.events.blocked !== "boolean" || typeof v.events.done !== "boolean") return false;
  }
  return true;
}
