// Issue #13. quota-and-usage.md §2.2, §2.3, §4.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QuotaExtraUsage, QuotaSnapshot, QuotaWindow } from "../../types/protocol";
import { fileCredentialSource, macKeychainSource, type CredentialSource } from "./credentials";

export interface ClaudeQuotaProviderOptions {
  home?: string;
  usageUrl?: string;
  /** `false` skips the macOS Keychain; a `CredentialSource` replaces it (tests). Default: on macOS only. */
  keychain?: boolean | CredentialSource;
  now?: () => number;
}

const DEFAULT_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const HOUR_MS = 60 * 60 * 1000;
const WINDOW_PERIODS: Record<string, number> = { five_hour: 5 * HOUR_MS, seven_day: 7 * 24 * HOUR_MS };

function familyLabel(family: string): string {
  return family
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export class ClaudeQuotaProvider {
  private home: string;
  private usageUrl: string;
  private keychain: CredentialSource | null;
  private now: () => number;

  constructor(options: ClaudeQuotaProviderOptions = {}) {
    this.home = options.home ?? process.env.HOME ?? "";
    this.usageUrl = options.usageUrl ?? DEFAULT_USAGE_URL;
    const keychain = options.keychain ?? process.platform === "darwin";
    this.keychain = keychain === true ? macKeychainSource() : keychain === false ? null : keychain;
    this.now = options.now ?? (() => Date.now());
  }

  /** §2.2: the credential file, else (macOS) the Keychain item. */
  private credentialSource(): { source: CredentialSource; raw: string } {
    const file = fileCredentialSource(join(this.home, ".claude", ".credentials.json"));
    const fromFile = file.read();
    if (fromFile !== null) return { source: file, raw: fromFile };
    const fromKeychain = this.keychain?.read() ?? null;
    if (fromKeychain !== null) return { source: this.keychain!, raw: fromKeychain };
    throw new Error("Claude credentials not found");
  }

  private readAccountEmail(): string | undefined {
    const p = join(this.home, ".claude.json");
    if (!existsSync(p)) return undefined;
    try {
      const email = JSON.parse(readFileSync(p, "utf-8"))?.oauthAccount?.emailAddress;
      return typeof email === "string" && email.trim() ? email.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private parseOauth(raw: string): any {
    let creds: any;
    try {
      creds = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse Claude credentials: ${(err as Error).message}`);
    }
    if (!creds?.claudeAiOauth?.accessToken) throw new Error("Claude credential missing claudeAiOauth.accessToken");
    return creds.claudeAiOauth;
  }

  public async fetch(): Promise<QuotaSnapshot> {
    const credential = this.credentialSource();
    const raw = credential.raw;
    const oauth = this.parseOauth(raw);

    if (typeof oauth.expiresAt === "number" && this.now() >= oauth.expiresAt) {
      throw new Error("Claude login expired — open Claude Code to refresh it");
    }

    const usageRes = await this.callUsage(oauth.accessToken);
    if (usageRes.status === 401 || usageRes.status === 403) {
      throw new Error("Claude login expired — open Claude Code to refresh it");
    }
    if (!usageRes.ok) throw new Error(`Claude usage request failed with HTTP ${usageRes.status}`);

    const usageData = (await usageRes.json()) as Record<string, any>;
    const extraUsage = this.extraUsageOf(usageData);
    return {
      provider: "claude",
      plan: oauth.subscriptionType,
      account: this.readAccountEmail(),
      windows: this.windowsOf(usageData),
      credits: [],
      ...(extraUsage ? { extraUsage } : {}),
      fetchedAt: this.now(),
    };
  }

  private extraUsageOf(usageData: Record<string, any>): QuotaExtraUsage | undefined {
    const eu = usageData?.extra_usage;
    if (!eu || typeof eu !== "object" || eu.is_enabled !== true) return undefined;
    const scale = typeof eu.decimal_places === "number" && eu.decimal_places >= 0 ? 10 ** eu.decimal_places : 100;
    return {
      used: typeof eu.used_credits === "number" ? eu.used_credits / scale : 0,
      limit: typeof eu.monthly_limit === "number" ? eu.monthly_limit / scale : null,
      ...(typeof eu.currency === "string" && eu.currency ? { currency: eu.currency } : {}),
    };
  }

  private windowsOf(usageData: Record<string, any>): QuotaWindow[] {
    if (Array.isArray(usageData.limits) && usageData.limits.length > 0) {
      const session: QuotaWindow[] = [];
      const weekly: QuotaWindow[] = [];
      for (let i = 0; i < usageData.limits.length; i++) {
        const l = usageData.limits[i];
        if (!l || typeof l !== "object") continue;
        const usedPercent = typeof l.percent === "number" ? l.percent : typeof l.utilization === "number" ? l.utilization : null;
        if (usedPercent === null) continue;
        const kind = typeof l.kind === "string" ? l.kind : "";
        const group = typeof l.group === "string" ? l.group : "";
        const scopeName =
          typeof l.scope?.model?.display_name === "string" && l.scope.model.display_name
            ? l.scope.model.display_name
            : typeof l.scope?.surface === "string" && l.scope.surface
            ? l.scope.surface
            : undefined;
        const resetsAt = l.resets_at ? Date.parse(l.resets_at) : null;
        if (kind === "session" || group === "session") {
          session.push({
            id: typeof l.id === "string" ? l.id : `session_${i}`,
            label: scopeName ? `5h · ${scopeName}` : "5h",
            ...(scopeName ? { family: scopeName } : {}),
            usedPercent,
            periodMs: WINDOW_PERIODS.five_hour,
            resetsAt,
          });
        } else {
          const family = scopeName ? scopeName : kind === "weekly_scoped" ? familyLabel(String(l.id || "model")) : undefined;
          weekly.push({
            id: typeof l.id === "string" ? l.id : family ? `seven_day_${family.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` : `weekly_${i}`,
            label: family ? `7d · ${family}` : "7d",
            ...(family ? { family } : {}),
            usedPercent,
            periodMs: WINDOW_PERIODS.seven_day,
            resetsAt,
          });
        }
      }
      if (session.length > 0 || weekly.length > 0) {
        return [...session, ...weekly];
      }
    }

    const windows: QuotaWindow[] = [];
    for (const [id, w] of Object.entries(usageData)) {
      if (!w || typeof w !== "object" || typeof w.utilization !== "number") continue;
      const family = id.startsWith("seven_day_") ? familyLabel(id.slice("seven_day_".length)) : undefined;
      const periodMs = family ? WINDOW_PERIODS.seven_day : WINDOW_PERIODS[id];
      if (!periodMs) continue;
      windows.push({
        id,
        label: family ? `7d · ${family}` : id === "five_hour" ? "5h" : "7d",
        ...(family ? { family } : {}),
        usedPercent: w.utilization,
        periodMs,
        resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
      });
    }
    return windows;
  }

  private callUsage(accessToken: string): Promise<Response> {
    return fetch(this.usageUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
  }
}
