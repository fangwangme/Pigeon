import { randomBytes, createHash } from "node:crypto";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { existsSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import qrcode from "qrcode-terminal";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateBase32Token(bytesLength = 16): string {
  const bytes = randomBytes(bytesLength);
  let bits = 0;
  let value = 0;
  let output = "";

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output.slice(0, 26);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface DeviceSession {
  deviceId: string;
  deviceName: string;
  tokenHash: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface PairingOptions {
  publicBaseUrl: string;
  insecureDev?: boolean;
  adminSocketPath?: string;
}

export class PairingManager extends EventEmitter {
  private activeToken: {
    token: string;
    createdAt: number;
    expiresAt: number;
    failedAttempts: number;
  } | null = null;

  private sessions = new Map<string, DeviceSession>(); // tokenHash -> DeviceSession
  private publicBaseUrl: string;
  private insecureDev: boolean;
  private adminSocketPath: string;
  private adminServer: NetServer | null = null;

  constructor(options: PairingOptions) {
    super();
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, "");
    this.insecureDev = !!options.insecureDev;
    this.adminSocketPath =
      options.adminSocketPath ||
      (process.env.XDG_RUNTIME_DIR
        ? `${process.env.XDG_RUNTIME_DIR}/pigeon.sock`
        : `${process.env.HOME}/.local/state/pigeon/admin.sock`);
  }

  public getCookieName(): string {
    const isHttps = this.publicBaseUrl.startsWith("https://");
    return !this.insecureDev && isHttps ? "__Host-pigeon_session" : "pigeon_session";
  }

  public getActiveToken(): { token: string; expiresAt: number } | null {
    if (!this.activeToken) return null;
    if (Date.now() > this.activeToken.expiresAt) return null;
    return { token: this.activeToken.token, expiresAt: this.activeToken.expiresAt };
  }

  public createPairingToken(): { token: string; url: string; expiresAt: number } {
    const token = generateBase32Token(16);
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000; // 10 minutes

    this.activeToken = {
      token,
      createdAt: now,
      expiresAt,
      failedAttempts: 0,
    };

    const url = `${this.publicBaseUrl}/#code=${token}`;
    return { token, url, expiresAt };
  }

  public printTerminalQrCode(tokenInfo?: { token: string; url: string }): void {
    const info = tokenInfo || this.createPairingToken();
    console.log("\n=======================================================");
    console.log("             PIGEON TERMINAL PAIRING QR CODE           ");
    console.log("=======================================================\n");
    console.log(`Pairing URL: ${info.url}\n`);
    qrcode.generate(info.url, { small: true });
    console.log("\nScan the QR code above with your mobile Chromium browser.");
    console.log("This pairing link will expire in 10 minutes.");
    console.log("=======================================================\n");
  }

  public exchangeToken(
    code: string,
    deviceName = "Mobile Chrome"
  ): { success: boolean; sessionToken?: string; deviceId?: string; error?: string } {
    const now = Date.now();

    if (!this.activeToken) {
      return { success: false, error: "No active pairing token. Run 'pigeon pair' to generate one." };
    }

    if (now > this.activeToken.expiresAt) {
      this.activeToken = null;
      return { success: false, error: "Pairing token has expired. Please generate a new one." };
    }

    if (this.activeToken.failedAttempts >= 5) {
      this.activeToken = null;
      return { success: false, error: "Too many failed attempts. Pairing token revoked." };
    }

    if (code !== this.activeToken.token) {
      this.activeToken.failedAttempts++;
      return { success: false, error: "Invalid pairing code." };
    }

    // Success: consume token
    this.activeToken = null;

    const sessionToken = generateBase32Token(32);
    const tokenHash = hashToken(sessionToken);
    const deviceId = `dev_${randomBytes(6).toString("hex")}`;
    const sanitizedName = deviceName.replace(/[\x00-\x1F\x7F]/g, "").slice(0, 32) || "Mobile Chrome";

    const session: DeviceSession = {
      deviceId,
      deviceName: sanitizedName,
      tokenHash,
      createdAt: now,
      lastUsedAt: now,
    };

    this.sessions.set(tokenHash, session);

    return {
      success: true,
      sessionToken,
      deviceId,
    };
  }

  public validateSession(sessionToken?: string): DeviceSession | null {
    if (!sessionToken) return null;
    const hash = hashToken(sessionToken);
    const session = this.sessions.get(hash);
    if (!session) return null;

    session.lastUsedAt = Date.now();
    return session;
  }

  public listDevices(): DeviceSession[] {
    return Array.from(this.sessions.values());
  }

  public revokeDevice(deviceId: string): boolean {
    let found = false;
    for (const [hash, session] of this.sessions.entries()) {
      if (session.deviceId === deviceId) {
        this.sessions.delete(hash);
        found = true;
      }
    }
    if (found) {
      this.emit("device_revoked", deviceId);
    }
    return found;
  }

  public startAdminSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const dir = dirname(this.adminSocketPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        if (existsSync(this.adminSocketPath)) {
          unlinkSync(this.adminSocketPath);
        }

        this.adminServer = createServer((socket: Socket) => {
          socket.on("error", () => {});
          let buffer = "";
          socket.on("data", (chunk) => {
            buffer += chunk.toString("utf-8");
            let newlineIdx: number;
            while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, newlineIdx).trim();
              buffer = buffer.slice(newlineIdx + 1);
              if (line) {
                this.handleAdminCommand(line, socket);
              }
            }
          });
        });

        this.adminServer.listen(this.adminSocketPath, () => {
          try {
            chmodSync(this.adminSocketPath, 0o600);
          } catch {}
          resolve();
        });

        this.adminServer.on("error", (err) => {
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleAdminCommand(line: string, socket: Socket) {
    try {
      const msg = JSON.parse(line);
      const id = msg.id || "1";
      const method = msg.method;

      switch (method) {
        case "pair.create": {
          const tokenInfo = this.createPairingToken();
          socket.write(JSON.stringify({ id, result: tokenInfo }) + "\n");
          break;
        }
        case "pair.status": {
          socket.write(
            JSON.stringify({
              id,
              result: {
                hasActiveToken: !!this.activeToken,
                expiresAt: this.activeToken?.expiresAt || null,
              },
            }) + "\n"
          );
          break;
        }
        case "devices.list": {
          socket.write(JSON.stringify({ id, result: this.listDevices() }) + "\n");
          break;
        }
        case "devices.revoke": {
          const deviceId = msg.params?.deviceId;
          const ok = this.revokeDevice(deviceId);
          socket.write(JSON.stringify({ id, result: { revoked: ok } }) + "\n");
          break;
        }
        case "status": {
          socket.write(
            JSON.stringify({
              id,
              result: {
                activeSessions: this.sessions.size,
                publicBaseUrl: this.publicBaseUrl,
              },
            }) + "\n"
          );
          break;
        }
        default:
          socket.write(
            JSON.stringify({ id, error: { code: "unknown_method", message: `Method ${method} not recognized` } }) + "\n"
          );
      }
    } catch (err: any) {
      socket.write(JSON.stringify({ error: { code: "invalid_json", message: err.message } }) + "\n");
    }
  }

  public stopAdminSocket(): void {
    if (this.adminServer) {
      this.adminServer.close();
      this.adminServer = null;
    }
    if (existsSync(this.adminSocketPath)) {
      try {
        unlinkSync(this.adminSocketPath);
      } catch {}
    }
  }
}
