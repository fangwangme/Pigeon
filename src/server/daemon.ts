import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { HerdrClient } from "./herdr-client";
import { PairingManager } from "./pairing";
import { PushManager } from "./push";
import { WsServer, type ClientConnectionData } from "./ws-server";

export interface DaemonConfig {
  port?: number;
  host?: string;
  insecureDev?: boolean;
  publicBaseUrl?: string;
  herdrSocketPath?: string;
  adminSocketPath?: string;
  vapidPath?: string;
  embeddedHtml?: string;
}

export class PigeonDaemon {
  public config: Required<DaemonConfig>;
  public herdrClient: HerdrClient;
  public pairingManager: PairingManager;
  public pushManager: PushManager;
  public wsServer: WsServer;
  private bunServer: Server<ClientConnectionData> | null = null;
  private htmlContent: string;

  constructor(config: DaemonConfig = {}) {
    const port = config.port || 4100;
    const host = config.host || (config.insecureDev ? "0.0.0.0" : "127.0.0.1");
    const insecureDev = !!config.insecureDev;
    const publicBaseUrl =
      config.publicBaseUrl ||
      (insecureDev ? `http://localhost:${port}` : `https://localhost:${port}`);

    this.config = {
      port,
      host,
      insecureDev,
      publicBaseUrl,
      herdrSocketPath:
        config.herdrSocketPath ||
        (process.env.HOME ? `${process.env.HOME}/.config/herdr/herdr.sock` : "/tmp/herdr.sock"),
      adminSocketPath:
        config.adminSocketPath ||
        (process.env.XDG_RUNTIME_DIR
          ? `${process.env.XDG_RUNTIME_DIR}/pigeon.sock`
          : `${process.env.HOME}/.local/state/pigeon/admin.sock`),
      vapidPath:
        config.vapidPath ||
        (process.env.HOME
          ? `${process.env.HOME}/.local/state/pigeon/vapid.json`
          : "/tmp/pigeon_vapid.json"),
      embeddedHtml: config.embeddedHtml || "",
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
    });

    this.htmlContent = this.resolveHtml();
  }

  private resolveHtml(): string {
    if (this.config.embeddedHtml) {
      return this.config.embeddedHtml;
    }

    const distPath = join(process.cwd(), "dist", "index.html");
    if (existsSync(distPath)) {
      try {
        return readFileSync(distPath, "utf-8");
      } catch {}
    }

    // Fallback minimal responsive HTML shell
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
    // 1. Connect to Herdr socket (optional failure: continues if Herdr isn't up immediately)
    try {
      await this.herdrClient.connect();
    } catch {}

    // 2. Start Admin Socket
    try {
      await this.pairingManager.startAdminSocket();
    } catch {}

    // 3. Start Bun HTTP & WebSocket server
    const self = this;
    const cookieName = this.pairingManager.getCookieName();

    this.bunServer = Bun.serve<ClientConnectionData>({
      port: this.config.port,
      hostname: this.config.host,

      async fetch(req, server) {
        const url = new URL(req.url);

        // Security Headers
        const csp =
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; object-src 'none';";

        // WebSocket Upgrade endpoint
        if (url.pathname === "/ws") {
          const cookies = self.parseCookie(req);
          let sessionToken = cookies[cookieName];

          // Allow token query param for initial pair/test handshake
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

            const secureFlag = self.config.insecureDev ? "" : "; Secure";
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

        // Serve PWA SPA html
        return new Response(self.htmlContent, {
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
  }
}
