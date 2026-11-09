// Issue #13. quota-and-usage.md §2.2, §2.3, §4.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QuotaSnapshot, QuotaWindow } from "../../types/protocol";

export interface ClaudeQuotaProviderOptions {
  home?: string;
  usageUrl?: string;
  tokenUrl?: string;
  keychain?: boolean;
  now?: () => number;
}

const DEFAULT_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export class ClaudeQuotaProvider {
  private home: string;
  private usageUrl: string;
  private tokenUrl: string;
  private keychain: boolean;
  private now: () => number;

  constructor(options: ClaudeQuotaProviderOptions = {}) {
    this.home = options.home ?? process.env.HOME ?? "";
    this.usageUrl = options.usageUrl ?? DEFAULT_USAGE_URL;
    this.tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.keychain = options.keychain ?? (process.platform === "darwin");
    this.now = options.now ?? (() => Date.now());
  }

  private credPath(): string {
    return join(this.home, ".claude", ".credentials.json");
  }

  private readRawCreds(): string | null {
    const p = this.credPath();
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  }

  private readAccountEmail(): string | undefined {
    const p = join(this.home, ".claude.json");
    if (!existsSync(p)) return undefined;
    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      const email = data?.oauthAccount?.emailAddress;
      return typeof email === "string" && email.trim() ? email.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private async refreshToken(refreshToken: string, scopes?: string[]): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
    const scopeStr = Array.isArray(scopes) && scopes.length > 0 ? scopes.join(" ") : undefined;
    const body: Record<string, any> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    };
    if (scopeStr) body.scope = scopeStr;

    let res: Response;
    try {
      res = await fetch(this.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Claude token refresh failed: ${(err as Error).message}`);
    }

    if (!res.ok) {
      throw new Error(`Claude token refresh rejected with status ${res.status}`);
    }

    const data = (await res.json()) as any;
    if (!data.access_token) {
      throw new Error("Claude token refresh returned no access token");
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: typeof data.expires_in === "number" ? data.expires_in : 3600,
    };
  }

  private writeBackCreds(originalRaw: string, tokens: { accessToken: string; refreshToken?: string; expiresIn: number }): boolean {
    const currentRaw = this.readRawCreds();
    if (currentRaw !== originalRaw) {
      // Credential changed while refresh was in flight
      return false;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(originalRaw);
    } catch {
      return false;
    }

    parsed.claudeAiOauth = parsed.claudeAiOauth || {};
    parsed.claudeAiOauth.accessToken = tokens.accessToken;
    if (tokens.refreshToken) {
      parsed.claudeAiOauth.refreshToken = tokens.refreshToken;
    }
    parsed.claudeAiOauth.expiresAt = this.now() + tokens.expiresIn * 1000;

    const p = this.credPath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
    return true;
  }

  public async fetch(): Promise<QuotaSnapshot> {
    const attemptedTokens = new Set<string>();

    let rawCreds = this.readRawCreds();
    if (!rawCreds) {
      throw new Error("Claude credentials not found");
    }

    let creds: any;
    try {
      creds = JSON.parse(rawCreds);
    } catch (err) {
      throw new Error(`Failed to parse Claude credentials: ${(err as Error).message}`);
    }

    let oauth = creds.claudeAiOauth;
    if (!oauth || !oauth.accessToken) {
      throw new Error("Claude credential missing claudeAiOauth.accessToken");
    }

    let accessToken = oauth.accessToken;
    let refreshed = false;

    // Check expiration
    const now = this.now();
    const isExpired = typeof oauth.expiresAt === "number" && now >= oauth.expiresAt;
    if (isExpired && oauth.refreshToken) {
      attemptedTokens.add(oauth.refreshToken);
      const newTokens = await this.refreshToken(oauth.refreshToken, oauth.scopes);
      const written = this.writeBackCreds(rawCreds, newTokens);
      if (written) {
        accessToken = newTokens.accessToken;
      } else {
        // Agent updated the file in the meantime; read agent's new token
        rawCreds = this.readRawCreds();
        if (!rawCreds) {
          throw new Error("Claude credentials file disappeared");
        }
        creds = JSON.parse(rawCreds);
        oauth = creds.claudeAiOauth;
        accessToken = oauth.accessToken;
      }
      refreshed = true;
    }

    // Call usage endpoint
    let usageRes = await this.callUsage(accessToken);

    // If 401/403 and haven't refreshed with this refresh token yet
    if ((usageRes.status === 401 || usageRes.status === 403) && !refreshed && oauth.refreshToken && !attemptedTokens.has(oauth.refreshToken)) {
      attemptedTokens.add(oauth.refreshToken);
      const newTokens = await this.refreshToken(oauth.refreshToken, oauth.scopes);
      const written = this.writeBackCreds(rawCreds, newTokens);
      if (written) {
        accessToken = newTokens.accessToken;
      } else {
        rawCreds = this.readRawCreds();
        if (!rawCreds) {
          throw new Error("Claude credentials file disappeared");
        }
        creds = JSON.parse(rawCreds);
        oauth = creds.claudeAiOauth;
        accessToken = oauth.accessToken;
      }
      usageRes = await this.callUsage(accessToken);
    }

    if (!usageRes.ok) {
      throw new Error(`Claude usage request failed with HTTP ${usageRes.status}`);
    }

    const usageData = (await usageRes.json()) as any;
    const windows: QuotaWindow[] = [];

    if (usageData.five_hour) {
      windows.push({
        id: "five_hour",
        label: "5h",
        usedPercent: usageData.five_hour.utilization ?? 0,
        periodMs: 5 * 60 * 60 * 1000,
        resetsAt: usageData.five_hour.resets_at ? Date.parse(usageData.five_hour.resets_at) : null,
      });
    }

    if (usageData.seven_day) {
      windows.push({
        id: "seven_day",
        label: "7d",
        usedPercent: usageData.seven_day.utilization ?? 0,
        periodMs: 7 * 24 * 60 * 60 * 1000,
        resetsAt: usageData.seven_day.resets_at ? Date.parse(usageData.seven_day.resets_at) : null,
      });
    }

    if (usageData.seven_day_sonnet) {
      windows.push({
        id: "seven_day_sonnet",
        label: "7d · Sonnet",
        family: "Sonnet",
        usedPercent: usageData.seven_day_sonnet.utilization ?? 0,
        periodMs: 7 * 24 * 60 * 60 * 1000,
        resetsAt: usageData.seven_day_sonnet.resets_at ? Date.parse(usageData.seven_day_sonnet.resets_at) : null,
      });
    }

    if (usageData.seven_day_opus) {
      windows.push({
        id: "seven_day_opus",
        label: "7d · Opus",
        family: "Opus",
        usedPercent: usageData.seven_day_opus.utilization ?? 0,
        periodMs: 7 * 24 * 60 * 60 * 1000,
        resetsAt: usageData.seven_day_opus.resets_at ? Date.parse(usageData.seven_day_opus.resets_at) : null,
      });
    }

    const account = this.readAccountEmail();

    return {
      provider: "claude",
      plan: oauth.subscriptionType,
      account,
      windows,
      credits: [],
      fetchedAt: this.now(),
    };
  }

  private async callUsage(accessToken: string): Promise<Response> {
    return fetch(this.usageUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
    });
  }
}
