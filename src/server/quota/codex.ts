// Issue #13. quota-and-usage.md §2.2, §2.3.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QuotaCredit, QuotaSnapshot, QuotaWindow } from "../../types/protocol";

export interface CodexQuotaProviderOptions {
  home?: string;
  usageUrl?: string;
  creditsUrl?: string;
  tokenUrl?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function decodeJwtPayload(token: string): any {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(base64, "base64").toString("utf-8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export class CodexQuotaProvider {
  private home: string;
  private usageUrl: string;
  private creditsUrl: string;
  private tokenUrl: string;
  private env: NodeJS.ProcessEnv;
  private now: () => number;

  constructor(options: CodexQuotaProviderOptions = {}) {
    this.home = options.home ?? process.env.HOME ?? "";
    this.usageUrl = options.usageUrl ?? DEFAULT_USAGE_URL;
    this.creditsUrl = options.creditsUrl ?? DEFAULT_CREDITS_URL;
    this.tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => Date.now());
  }

  private candidatePaths(): string[] {
    const paths: string[] = [];
    if (this.env.CODEX_HOME) {
      paths.push(join(this.env.CODEX_HOME, "auth.json"));
    }
    paths.push(join(this.home, ".config", "codex", "auth.json"));
    paths.push(join(this.home, ".codex", "auth.json"));
    return paths;
  }

  private findCredPath(): string | null {
    for (const p of this.candidatePaths()) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  private async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; idToken?: string }> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    });

    let res: Response;
    try {
      res = await fetch(this.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
    } catch (err) {
      throw new Error(`Codex token refresh failed: ${(err as Error).message}`);
    }

    if (!res.ok) {
      throw new Error(`Codex token refresh rejected with status ${res.status}`);
    }

    const data = (await res.json()) as any;
    if (!data.access_token) {
      throw new Error("Codex token refresh returned no access token");
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
    };
  }

  private writeBackCreds(path: string, originalRaw: string, tokens: { accessToken: string; refreshToken?: string; idToken?: string }): boolean {
    let currentRaw: string | null = null;
    try {
      currentRaw = readFileSync(path, "utf-8");
    } catch {
      return false;
    }

    if (currentRaw !== originalRaw) {
      return false;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(originalRaw);
    } catch {
      return false;
    }

    if (!parsed.tokens) parsed.tokens = {};
    parsed.tokens.access_token = tokens.accessToken;
    if (tokens.refreshToken) parsed.tokens.refresh_token = tokens.refreshToken;
    if (tokens.idToken) parsed.tokens.id_token = tokens.idToken;

    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  }

  public async fetch(): Promise<QuotaSnapshot> {
    const credPath = this.findCredPath();
    if (!credPath) {
      throw new Error("Codex credentials not found");
    }

    let rawCreds = readFileSync(credPath, "utf-8");
    let creds: any;
    try {
      creds = JSON.parse(rawCreds);
    } catch (err) {
      throw new Error(`Failed to parse Codex credentials: ${(err as Error).message}`);
    }

    let tokens = creds.tokens;
    if (!tokens || !tokens.access_token) {
      throw new Error("Codex credentials missing tokens.access_token");
    }

    let accessToken = tokens.access_token;
    let refreshToken = tokens.refresh_token;
    let idToken = tokens.id_token;

    // Check expiration via JWT exp
    const payload = decodeJwtPayload(accessToken);
    const nowSec = Math.floor(this.now() / 1000);
    const isExpired = payload && typeof payload.exp === "number" && payload.exp <= nowSec + 60;
    let refreshed = false;

    if (isExpired && refreshToken) {
      const newTokens = await this.refreshToken(refreshToken);
      const written = this.writeBackCreds(credPath, rawCreds, newTokens);
      if (written) {
        accessToken = newTokens.accessToken;
        if (newTokens.refreshToken) refreshToken = newTokens.refreshToken;
        if (newTokens.idToken) idToken = newTokens.idToken;
      } else {
        rawCreds = readFileSync(credPath, "utf-8");
        creds = JSON.parse(rawCreds);
        tokens = creds.tokens;
        accessToken = tokens.access_token;
        refreshToken = tokens.refresh_token;
        idToken = tokens.id_token;
      }
      refreshed = true;
    }

    let usageRes = await this.callUsage(accessToken);
    if ((usageRes.status === 401 || usageRes.status === 403) && !refreshed && refreshToken) {
      const newTokens = await this.refreshToken(refreshToken);
      const written = this.writeBackCreds(credPath, rawCreds, newTokens);
      if (written) {
        accessToken = newTokens.accessToken;
        if (newTokens.refreshToken) refreshToken = newTokens.refreshToken;
        if (newTokens.idToken) idToken = newTokens.idToken;
      } else {
        rawCreds = readFileSync(credPath, "utf-8");
        creds = JSON.parse(rawCreds);
        tokens = creds.tokens;
        accessToken = tokens.access_token;
      }
      usageRes = await this.callUsage(accessToken);
    }

    if (!usageRes.ok) {
      throw new Error(`Codex usage request failed with HTTP ${usageRes.status}`);
    }

    const usageData = (await usageRes.json()) as any;
    const now = this.now();
    const windows: QuotaWindow[] = [];

    const formatSeconds = (sec: number): string => {
      if (sec === 18000) return "5h";
      if (sec === 604800) return "7d";
      if (sec % 86400 === 0) return `${sec / 86400}d`;
      if (sec % 3600 === 0) return `${sec / 3600}h`;
      return `${Math.round(sec / 60)}m`;
    };

    const rateLimit = usageData.rate_limit;
    if (rateLimit) {
      const processWindow = (w: any, id: string, defaultLabel: string) => {
        if (!w) return;
        const usedPercent = typeof w.used_percent === "number" ? w.used_percent : parseFloat(w.used_percent) || 0;
        const sec = typeof w.limit_window_seconds === "number" && w.limit_window_seconds > 0 ? w.limit_window_seconds : null;
        const label = sec ? formatSeconds(sec) : defaultLabel;
        const resetsAt = typeof w.reset_at === "number"
          ? w.reset_at * 1000
          : typeof w.reset_after_seconds === "number"
          ? now + w.reset_after_seconds * 1000
          : null;

        windows.push({
          id,
          label,
          usedPercent,
          periodMs: sec ? sec * 1000 : null,
          resetsAt,
        });
      };

      processWindow(rateLimit.primary_window, "primary", "5h");
      processWindow(rateLimit.secondary_window, "secondary", "7d");
    }

    // Reset credits
    const credits: QuotaCredit[] = [];
    try {
      const credsRes = await fetch(this.creditsUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (credsRes.ok) {
        const credsData = (await credsRes.json()) as any;
        if (Array.isArray(credsData.credits)) {
          for (const c of credsData.credits) {
            if (c.status === "available") {
              credits.push({
                id: c.id,
                label: c.reset_type || "Reset Credit",
                expiresAt: c.expires_at ? Date.parse(c.expires_at) : null,
              });
            }
          }
        }
      }
    } catch {
      // Non-fatal
    }

    let account: string | undefined;
    if (idToken) {
      const idPayload = decodeJwtPayload(idToken);
      if (idPayload?.email) account = idPayload.email;
    }

    return {
      provider: "codex",
      plan: usageData.plan_type,
      account,
      windows,
      credits,
      fetchedAt: now,
    };
  }

  private async callUsage(accessToken: string): Promise<Response> {
    return fetch(this.usageUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
  }
}
