import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { networkInterfaces } from "node:os";
import type { Server, ServerWebSocket } from "bun";
import { HerdrClient } from "./herdr-client";
import { PairingManager } from "./pairing";
import { PushManager } from "./push";
import { WsServer, type ClientConnectionData } from "./ws-server";
import { EMBEDDED_HTML } from "./embedded-html";
import { ConfigManager } from "./config-manager";
import {
  PWA_MANIFEST,
  PWA_SW_SCRIPT,
  PWA_ICON_SVG,
  PWA_ICON_192_BASE64,
  PWA_ICON_512_BASE64,
} from "./pwa-assets";

export interface DaemonConfig {
  port?: number;
  host?: string;
  insecureDev?: boolean;
  publicBaseUrl?: string;
  herdrSocketPath?: string;
  adminSocketPath?: string;
  vapidPath?: string;
  embeddedHtml?: string;
  configManager?: ConfigManager;
  configPath?: string;
}

export function detectLocalIp(): string | null {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal) {
        if (
          iface.address.startsWith("192.168.") ||
          iface.address.startsWith("10.") ||
          iface.address.startsWith("172.")
        ) {
          return iface.address;
        }
      }
    }
  }
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

export function detectTailscaleDns(): string | null {
  try {
    const proc = Bun.spawnSync(["tailscale", "status", "--json"]);
    if (proc.exitCode === 0) {
      const data = JSON.parse(proc.stdout.toString());
      if (data.Self?.DNSName) {
        return data.Self.DNSName.replace(/\.+$/, "");
      }
    }
  } catch {}
  return null;
}

export class PigeonDaemon {
  public config: Required<DaemonConfig>;
  public configManager: ConfigManager;
  public herdrClient: HerdrClient;
  public pairingManager: PairingManager;
  public pushManager: PushManager;
  public wsServer: WsServer;
  private bunServer: Server<ClientConnectionData> | null = null;
  private htmlContent: string;

  constructor(config: DaemonConfig = {}) {
    this.configManager = config.configManager || new ConfigManager(config.configPath);
    const serverCfg = this.configManager.getServerConfig();

    const port = config.port !== undefined ? config.port : (serverCfg.port || 4100);
    const insecureDev = config.insecureDev !== undefined ? config.insecureDev : (serverCfg.insecureDev || false);
    const host = config.host !== undefined ? config.host : (serverCfg.host || "");

    let publicBaseUrl = config.publicBaseUrl || serverCfg.publicBaseUrl;
    if (!publicBaseUrl) {
      if (!insecureDev) {
        const tsDns = detectTailscaleDns();
        if (tsDns) {
          publicBaseUrl = `https://${tsDns}`;
        }
      }
      if (!publicBaseUrl) {
        const localIp = detectLocalIp() || "localhost";
        publicBaseUrl = `http://${localIp}:${port}`;
      }
    }

    this.config = {
      port,
      host,
      insecureDev,
      publicBaseUrl,
      herdrSocketPath:
        config.herdrSocketPath ||
        serverCfg.herdrSocketPath ||
        (process.env.HOME ? `${process.env.HOME}/.config/herdr/herdr.sock` : "/tmp/herdr.sock"),
      adminSocketPath:
        config.adminSocketPath ||
        serverCfg.adminSocketPath ||
        (process.env.XDG_RUNTIME_DIR
          ? `${process.env.XDG_RUNTIME_DIR}/pigeon.sock`
          : `${process.env.HOME}/.local/state/pigeon/admin.sock`),
      vapidPath:
        config.vapidPath ||
        (process.env.HOME
          ? `${process.env.HOME}/.local/state/pigeon/vapid.json`
          : "/tmp/pigeon_vapid.json"),
      embeddedHtml: config.embeddedHtml || "",
      configManager: this.configManager,
      configPath: this.configManager.getConfigPath(),
    };

    this.herdrClient = new HerdrClient({
      socketPath: this.config.herdrSocketPath,
    });
    this.herdrClient.on("error", () => {});

    this.pairingManager = new PairingManager({
      publicBaseUrl: this.config.publicBaseUrl,
      insecureDev: this.config.insecureDev,
      adminSocketPath: this.config.adminSocketPath,
    });

    this.pushManager = new PushManager(this.config.vapidPath);

    this.wsServer = new WsServer({
      herdrClient: this.herdrClient,
      pairingManager: this.pairingManager,
      pushManager: this.pushManager,
      insecureDev: this.config.insecureDev,
      configManager: this.configManager,
    });

    this.pairingManager.on("device_revoked", (deviceId) => {
      this.wsServer.closeDevice(deviceId);
    });

    this.htmlContent = this.resolveHtml();
  }

  private resolveHtml(): string {
    const candidatePaths = [
      join(process.cwd(), "dist", "index.html"),
      join(dirname(Bun.main), "dist", "index.html"),
      join(dirname(Bun.main), "index.html"),
      join(dirname(dirname(Bun.main)), "dist", "index.html"),
    ];

    for (const p of candidatePaths) {
      if (existsSync(p)) {
        try {
          const content = readFileSync(p, "utf-8");
          if (content.length > 1000) return content;
        } catch {}
      }
    }

    if (this.config.embeddedHtml) {
      return this.config.embeddedHtml;
    }

    if (EMBEDDED_HTML && EMBEDDED_HTML.length > 1000) {
      return EMBEDDED_HTML;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, interactive-widget=resizes-content">
  <title>Pigeon Mobile</title>
  <style>
    body { margin: 0; background: #0B0F14; color: #F0F6FC; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; }
  </style>
</head>
<body>
  <div id="root"><h3>Pigeon Server Running</h3></div>
</body>
</html>`;
  }

  public parseCookie(req: Request): Record<string, string> {
    const cookieHeader = req.headers.get("cookie");
    if (!cookieHeader) return {};

    const cookies: Record<string, string> = {};
    for (const pair of cookieHeader.split(";")) {
      const idx = pair.indexOf("=");
      if (idx > 0) {
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        cookies[key] = decodeURIComponent(val);
      }
    }
    return cookies;
  }

  public async start(): Promise<void> {
    try {
      await this.herdrClient.connect();
    } catch {}

    try {
      await this.pairingManager.startAdminSocket();
    } catch {}

    const self = this;
    const cookieName = this.pairingManager.getCookieName();

    this.bunServer = Bun.serve<ClientConnectionData>({
      port: this.config.port,
      hostname: this.config.host || undefined,

      async fetch(req, server) {
        const url = new URL(req.url);

        const csp =
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; object-src 'none';";

        // WebSocket Upgrade endpoint
        if (url.pathname === "/ws") {
          const cookies = self.parseCookie(req);
          let sessionToken = cookies[cookieName];

          if (!sessionToken && url.searchParams.has("token")) {
            sessionToken = url.searchParams.get("token")!;
          }

          const session = self.pairingManager.validateSession(sessionToken);
          if (!session) {
            return new Response("Unauthorized", {
              status: 401,
              statusText: "ERR_UNAUTHORIZED",
              headers: { "Content-Type": "text/plain" },
            });
          }

          const upgraded = server.upgrade(req, {
            data: {
              session,
              subscribedPaneId: url.searchParams.get("paneId") || null,
              lastPingTime: Date.now(),
            },
          });

          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        // POST /api/pair
        if (url.pathname === "/api/pair" && req.method === "POST") {
          try {
            const body = await req.json();
            const { code, deviceName } = body;
            const res = self.pairingManager.exchangeToken(code, deviceName);

            if (!res.success) {
              return Response.json(
                { success: false, error: res.error },
                { status: 400 }
              );
            }

            const isHttps = self.config.publicBaseUrl.startsWith("https://");
            const secureFlag = isHttps ? "; Secure" : "";
            const setCookie = `${cookieName}=${res.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secureFlag}`;

            return Response.json(
              { success: true, deviceId: res.deviceId },
              {
                headers: {
                  "Set-Cookie": setCookie,
                  "Content-Type": "application/json",
                },
              }
            );
          } catch (e: any) {
            return Response.json({ success: false, error: e.message }, { status: 400 });
          }
        }

        // GET /api/version
        if (url.pathname === "/api/version") {
          return Response.json({ version: "0.1.0", name: "pigeon" });
        }

        // GET /api/push/vapid-public-key
        if (url.pathname === "/api/push/vapid-public-key") {
          return Response.json({ publicKey: self.pushManager.getPublicKey() });
        }

        // POST /api/push/subscribe
        if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
          try {
            const body = await req.json();
            self.pushManager.addSubscription(body);
            return Response.json({ success: true });
          } catch (e: any) {
            return Response.json({ success: false, error: e.message }, { status: 400 });
          }
        }

        // PWA Web App Manifest
        if (url.pathname === "/manifest.webmanifest" || url.pathname === "/manifest.json") {
          return Response.json(PWA_MANIFEST, {
            headers: {
              "Content-Type": "application/manifest+json; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
            },
          });
        }

        // PWA Service Worker
        if (url.pathname === "/sw.js") {
          return new Response(PWA_SW_SCRIPT, {
            headers: {
              "Content-Type": "application/javascript; charset=utf-8",
              "Cache-Control": "no-cache, no-store, must-revalidate",
            },
          });
        }

        // PWA Icons
        if (url.pathname === "/icon.svg") {
          return new Response(PWA_ICON_SVG, {
            headers: {
              "Content-Type": "image/svg+xml; charset=utf-8",
              "Cache-Control": "public, max-age=86400",
            },
          });
        }

        if (url.pathname === "/icon-192.png") {
          const buf = Buffer.from(PWA_ICON_192_BASE64, "base64");
          return new Response(buf, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=86400",
            },
          });
        }

        if (url.pathname === "/icon-512.png") {
          const buf = Buffer.from(PWA_ICON_512_BASE64, "base64");
          return new Response(buf, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=86400",
            },
          });
        }

        // Review showcase page with all screenshots in one place
        if (url.pathname === "/review" || url.pathname === "/review.html") {
          const reviewPath = "/home/fangwang/.gemini/antigravity-cli/brain/7a55b02f-037e-4bec-b354-a0963f7e8434/review.html";
          const reviewFile = Bun.file(reviewPath);
          if (await reviewFile.exists()) {
            return new Response(reviewFile, {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-cache",
              },
            });
          }
        }

        // Serve PWA SPA html
        return new Response(self.resolveHtml(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": csp,
          },
        });
      },

      websocket: {
        open(ws) {
          self.wsServer.handleOpen(ws);
        },
        message(ws, msg) {
          self.wsServer.handleMessage(ws, msg);
        },
        close(ws) {
          self.wsServer.handleClose(ws);
        },
      },
    });
  }

  public stop(): void {
    if (this.bunServer) {
      this.bunServer.stop();
      this.bunServer = null;
    }
    this.herdrClient.disconnect();
    this.pairingManager.stopAdminSocket();
    this.configManager.destroy();
  }
}
