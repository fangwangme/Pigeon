// Issue #13. quota-and-usage.md §2.2, §2.3.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { QuotaCredit, QuotaSnapshot, QuotaWindow } from "../../types/protocol";
import { decodeJwtPayload, fileCredentialSource } from "./credentials";

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

  public async fetch(): Promise<QuotaSnapshot> {
    const credPath = this.findCredPath();
    if (!credPath) {
      throw new Error("Codex credentials not found");
    }

    const raw = fileCredentialSource(credPath).read();
    if (raw === null) {
      throw new Error("Codex credentials not found");
    }
    let creds: any;
    try {
      creds = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse Codex credentials: ${(err as Error).message}`);
    }
    if (!creds?.tokens?.access_token) throw new Error("Codex credentials missing tokens.access_token");
    const tokens = creds.tokens as { access_token: string; refresh_token?: string; id_token?: string };

    // A6: Read-only credentials. Check JWT expiry before making any network call.
    const exp = decodeJwtPayload(tokens.access_token)?.exp;
    if (typeof exp === "number" && exp <= Math.floor(this.now() / 1000)) {
      throw new Error("Codex login expired — open Codex to refresh it");
    }

    const usageRes = await this.callUsage(tokens.access_token);
    if (usageRes.status === 401 || usageRes.status === 403) {
      throw new Error("Codex login expired — open Codex to refresh it");
    }
    const accessToken = tokens.access_token;
    const idToken = tokens.id_token;

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
        signal: AbortSignal.timeout(10000),
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
      signal: AbortSignal.timeout(10000),
    });
  }
}
