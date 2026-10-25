import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { createServer, connect, type Server as NetServer, type Socket } from "node:net";
import { existsSync, unlinkSync, mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync } from "node:fs";
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
  adminSocketPath: string;
  devicesFilePath: string;
}

export interface PairingTokenOptions {
  permanent?: boolean;
  singleUse?: boolean;
  ttlMs?: number;
}

export class PairingManager extends EventEmitter {
  private activeToken: {
    token: string;
    createdAt: number;
    expiresAt: number; // 0 = never expires
    failedAttempts: number;
    permanent: boolean;
    singleUse: boolean;
  } | null = null;

  private sessions = new Map<string, DeviceSession>(); // tokenHash -> DeviceSession
  private publicBaseUrl: string;
  private insecureDev: boolean;
  private adminSocketPath: string;
  private devicesFilePath: string;
  private adminServer: NetServer | null = null;

  constructor(options: PairingOptions) {
    super();
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, "");
    this.insecureDev = !!options.insecureDev;
    this.adminSocketPath = options.adminSocketPath;
    this.devicesFilePath = options.devicesFilePath;

    this.loadDevices();
  }

  /** A corrupt registry stops startup: silently dropping it would unpair every device. */
  private loadDevices(): void {
    if (!existsSync(this.devicesFilePath)) return;
    {
      const raw = readFileSync(this.devicesFilePath, "utf-8");
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Device registry ${this.devicesFilePath} is not valid JSON: ${(err as Error).message}`);
      }
      if (parsed.activeToken) {
        const at = parsed.activeToken;
        if (at.permanent || !at.expiresAt || at.expiresAt > Date.now()) {
          this.activeToken = at;
        }
      }
      if (Array.isArray(parsed.sessions)) {
        this.sessions.clear();
        for (const s of parsed.sessions) {
          if (s.tokenHash && s.deviceId) {
            this.sessions.set(s.tokenHash, s);
          }
        }
      }
    }
  }

  private saveDevices(): void {
    mkdirSync(dirname(this.devicesFilePath), { recursive: true, mode: 0o700 });
    const data = {
      version: "1.0.0",
      updatedAt: Date.now(),
      activeToken: this.activeToken,
      sessions: Array.from(this.sessions.values()),
    };
    const tmpPath = `${this.devicesFilePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, this.devicesFilePath);
  }

  public getCookieName(): string {
    const isHttps = this.publicBaseUrl.startsWith("https://");
    return !this.insecureDev && isHttps ? "__Host-pigeon_session" : "pigeon_session";
  }

  public getActiveToken(): { token: string; expiresAt: number; permanent: boolean } | null {
    if (!this.activeToken) return null;
    if (this.activeToken.expiresAt > 0 && Date.now() > this.activeToken.expiresAt) return null;
    return {
      token: this.activeToken.token,
      expiresAt: this.activeToken.expiresAt,
      permanent: this.activeToken.permanent,
    };
  }

  public createPairingToken(options?: PairingTokenOptions): {
    token: string;
    url: string;
    expiresAt: number;
    permanent: boolean;
  } {
    const token = generateBase32Token(16);
    const now = Date.now();
    // Default to permanent (never expires) per user requirement
    const isExplicitEphemeral =
      options?.permanent === false ||
      options?.singleUse === true ||
      (options?.ttlMs !== undefined && options.ttlMs > 0);
    const permanent = options?.permanent ?? !isExplicitEphemeral;
    const ttl = options?.ttlMs ?? (permanent ? 0 : 10 * 60 * 1000);
    const expiresAt = ttl > 0 ? now + ttl : 0;
    const singleUse = options?.singleUse ?? (permanent ? false : true);

    this.activeToken = {
      token,
      createdAt: now,
      expiresAt,
      failedAttempts: 0,
      permanent,
      singleUse,
    };
    this.saveDevices();

    const url = `${this.publicBaseUrl}/pair#code=${token}`;
    return { token, url, expiresAt, permanent };
  }

  public printTerminalQrCode(tokenInfo?: { token: string; url: string; permanent?: boolean }): void {
    const info = tokenInfo || this.createPairingToken();
    console.log("\n=======================================================");
    console.log("             PIGEON TERMINAL PAIRING QR CODE           ");
    console.log("=======================================================\n");
    console.log(`Pairing URL: ${info.url}\n`);
    qrcode.generate(info.url, { small: true });
    console.log("\nScan the QR code above with your mobile Chromium browser.");
    if (info.permanent) {
      console.log("This pairing link is permanent (does not expire).");
    } else {
      console.log("This pairing link will expire in 10 minutes.");
    }
    console.log("=======================================================\n");
  }

  /** `code` and `deviceName` are already validated strings (checked at the HTTP boundary). */
  public exchangeToken(
    code: string,
    deviceName: string
  ): { success: boolean; sessionToken?: string; deviceId?: string; error?: string } {
    const now = Date.now();

    if (!this.activeToken) {
      return { success: false, error: "No active pairing token. Run 'pigeon pair' to generate one." };
    }

    if (this.activeToken.expiresAt > 0 && now > this.activeToken.expiresAt) {
      this.activeToken = null;
      this.saveDevices();
      return { success: false, error: "Pairing token has expired. Please generate a new one." };
    }

    if (this.activeToken.failedAttempts >= 5) {
      this.activeToken = null;
      this.saveDevices();
      return { success: false, error: "Too many failed attempts. Pairing token revoked." };
    }

    const codeBuf = Buffer.from(code.trim().toUpperCase());
    const tokenBuf = Buffer.from(this.activeToken.token.trim().toUpperCase());
    const match = codeBuf.length === tokenBuf.length && timingSafeEqual(codeBuf, tokenBuf);

    if (!match) {
      this.activeToken.failedAttempts++;
      this.saveDevices();
      return { success: false, error: "Invalid pairing code." };
    }

    // If single-use, consume token; if permanent/reusable, keep active
    if (this.activeToken.singleUse) {
      this.activeToken = null;
    }

    const sessionToken = generateBase32Token(32);
    const tokenHash = hashToken(sessionToken);
    const deviceId = randomUUID();
    const sanitizedName = deviceName.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x1F\x7F]/g, "").slice(0, 32) || "Mobile Chrome";

    const session: DeviceSession = {
      deviceId,
      deviceName: sanitizedName,
      tokenHash,
      createdAt: now,
      lastUsedAt: now,
    };

    this.sessions.set(tokenHash, session);
    this.saveDevices();

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
      this.saveDevices();
      this.emit("device_revoked", deviceId);
    }
    return found;
  }

  /** Resolves true when another daemon is already answering on the admin socket. */
  private probeAdminSocket(): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = connect(this.adminSocketPath);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false)); // stale socket file: nothing is listening
    });
  }

  public async startAdminSocket(): Promise<void> {
    mkdirSync(dirname(this.adminSocketPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.adminSocketPath)) {
      if (await this.probeAdminSocket()) {
        throw new Error(`Another Pigeon daemon is already running (admin socket ${this.adminSocketPath} is answering)`);
      }
      unlinkSync(this.adminSocketPath);
    }
    return new Promise((resolve, reject) => {
      {

        this.adminServer = createServer((socket: Socket) => {
          socket.on("error", (err) => console.error("[pigeon] admin socket client error:", err));
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

        this.adminServer.on("error", reject);
        this.adminServer.listen(this.adminSocketPath, () => {
          chmodSync(this.adminSocketPath, 0o600);
          resolve();
        });
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
          const tokenInfo = this.createPairingToken(msg.params?.ephemeral ? { permanent: false } : undefined);
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
    if (!this.adminServer) return; // never started, or another daemon owns the socket
    this.adminServer.close();
    this.adminServer = null;
    if (existsSync(this.adminSocketPath)) unlinkSync(this.adminSocketPath);
  }
}
