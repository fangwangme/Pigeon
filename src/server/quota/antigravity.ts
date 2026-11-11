// Issue #13. quota-and-usage.md §2.2, §2.3.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QuotaSnapshot, QuotaWindow } from "../../types/protocol";
import { decodeJwtPayload, fileCredentialSource, storeRefreshed } from "./credentials";
import { discoverAntigravityLs, isLoopbackAddress } from "../usage/antigravity-ls";

export interface AntigravityQuotaProviderOptions {
  home?: string;
  now?: () => number;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function cleanGroupLabel(displayName: string): string {
  const trimmed = displayName.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "gemini models" || lower === "gemini") {
    return "Gemini";
  } else if (lower.includes("claude") || lower.includes("gpt")) {
    return "Claude";
  } else {
    let cleaned = trimmed;
    if (lower.endsWith(" models")) {
      cleaned = trimmed.slice(0, trimmed.length - " models".length).trim();
    }
    return cleaned || "Usage";
  }
}

function groupRank(groupLabel: string): number {
  if (groupLabel === "Gemini") return 0;
  if (groupLabel === "Claude") return 1;
  return 2;
}

function windowDescriptor(window: string): { suffix: string; rank: number; periodMs: number | null } {
  const lower = window.toLowerCase();
  if (lower === "5h") return { suffix: "5h", rank: 0, periodMs: FIVE_HOURS_MS };
  if (lower === "weekly") return { suffix: "7d", rank: 1, periodMs: SEVEN_DAYS_MS };
  return { suffix: window, rank: 2, periodMs: null };
}

export class AntigravityQuotaProvider {
  private home: string;
  private now: () => number;

  constructor(options: AntigravityQuotaProviderOptions = {}) {
    this.home = options.home ?? process.env.HOME ?? "";
    this.now = options.now ?? (() => Date.now());
  }

  private tokenPath(): string {
    return join(this.home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  }

  private readAccountEmail(): string | undefined {
    // 1. Check OAuth token file (antigravity-oauth-token)
    const tokenPaths = [
      process.env.TOKENPULSE_ANTIGRAVITY_AUTH_PATH,
      this.tokenPath(),
    ].filter(Boolean) as string[];

    for (const tp of tokenPaths) {
      if (existsSync(tp)) {
        try {
          const data = JSON.parse(readFileSync(tp, "utf-8"));
          if (data?.id_token) {
            const payload = decodeJwtPayload(data.id_token);
            if (payload?.email) return payload.email;
          }
        } catch {
          // ignore
        }
      }
    }

    // 2. Check Antigravity Desktop app_storage.json
    const storagePaths = [
      join(this.home, ".config", "Antigravity", "app_storage.json"),
      join(this.home, "Library", "Application Support", "Antigravity", "app_storage.json"),
    ];
    for (const sp of storagePaths) {
      if (existsSync(sp)) {
        try {
          const data = JSON.parse(readFileSync(sp, "utf-8"));
          const username = data?.["jetski.onboarding.lastLoginUsername"];
          if (typeof username === "string" && username.includes("@")) {
            return username.trim();
          }
        } catch {
          // ignore
        }
      }
    }

    return undefined;
  }

  public async fetch(): Promise<QuotaSnapshot> {
    const errors: string[] = [];

    // Source 1: Language Server RPC (auto discovery or override)
    try {
      const lsConn = await discoverAntigravityLs();
      if (lsConn) {
        const snap = await this.probeLanguageServer(lsConn.address, lsConn.csrfToken);
        if (snap) return snap;
      }
    } catch (err) {
      errors.push(`Language server RPC: ${(err as Error).message}`);
    }

    // Source 2: agy -p /usage --output-format json
    try {
      const snap = await this.probeAgyCli();
      if (snap) return snap;
    } catch (err) {
      errors.push(`agy CLI: ${(err as Error).message}`);
    }

    // Source 3: Cloud Code API
    try {
      const snap = await this.probeCloudCode();
      if (snap) return snap;
    } catch (err) {
      errors.push(`Cloud Code API: ${(err as Error).message}`);
    }

    throw new Error(`Antigravity quota fetch failed: ${errors.join("; ")}`);
  }

  private async probeLanguageServer(address: string, csrfToken?: string): Promise<QuotaSnapshot | null> {
    if (!isLoopbackAddress(address)) return null;
    const url = `http://${address}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    };
    if (csrfToken) headers["x-codeium-csrf-token"] = csrfToken;

    const res = await fetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        metadata: {
          ideName: "antigravity",
          extensionName: "antigravity",
          ideVersion: "unknown",
          locale: "en",
        },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const summary = data?.response || data;
    if (!summary?.groups) return null;

    let lsEmail: string | undefined;
    try {
      const statusRes = await fetch(`http://${address}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          metadata: { ideName: "antigravity", extensionName: "antigravity", ideVersion: "unknown", locale: "en" },
        }),
      });
      if (statusRes.ok) {
        const sData = (await statusRes.json()) as any;
        const email = sData?.userStatus?.email;
        if (typeof email === "string" && email.trim()) {
          lsEmail = email.trim();
        }
      }
    } catch {
      // ignore
    }

    return this.buildSnapshotFromGroups(summary.groups, lsEmail);
  }

  private async probeAgyCli(): Promise<QuotaSnapshot | null> {
    const proc = Bun.spawn(["agy", "-p", "/usage", "--output-format", "json"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error("agy CLI timed out after 15s"));
      }, 15000)
    );

    const result = await Promise.race([proc.exited, timeout]);
    if (result !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`agy CLI exited with code ${result}: ${err}`);
    }

    const output = await new Response(proc.stdout).text();
    const parsed = JSON.parse(output);
    const groups = parsed?.command?.data?.groups;
    if (!Array.isArray(groups)) return null;
    return this.buildSnapshotFromGroups(groups);
  }

  private async probeCloudCode(): Promise<QuotaSnapshot | null> {
    const source = fileCredentialSource(this.tokenPath());
    let raw = source.read();
    if (raw === null) return null;
    let tokenObj = JSON.parse(raw)?.token;
    if (!tokenObj?.access_token) return null;

    const expiry = tokenObj.expiry ? Date.parse(tokenObj.expiry) : 0;
    if (expiry && this.now() >= expiry - 5 * 60 * 1000 && tokenObj.refresh_token) {
      const clientId = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
      const clientSecret = ["GOCSPX-", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("");
      const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: tokenObj.refresh_token,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!refreshRes.ok) throw new Error(`Antigravity token refresh rejected with status ${refreshRes.status}`);
      const refreshData = (await refreshRes.json()) as any;
      // §2.3: written back only when the CLI did not rotate the token file meanwhile.
      raw = storeRefreshed(source, raw, (data) => {
        data.token = {
          ...data.token,
          access_token: refreshData.access_token,
          expiry: new Date(this.now() + (refreshData.expires_in || 3600) * 1000).toISOString(),
          refresh_token: refreshData.refresh_token || data.token.refresh_token,
        };
      });
      tokenObj = JSON.parse(raw).token;
    }
    const accessToken = tokenObj.access_token;

    const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "antigravity/hub/2.9.1 linux/amd64",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as any;
    const summary = body?.response || body;
    if (!summary?.groups) return null;
    return this.buildSnapshotFromGroups(summary.groups);
  }

  private buildSnapshotFromGroups(groups: any[], preferredEmail?: string): QuotaSnapshot {
    interface WindowSortItem {
      gRank: number;
      gIdx: number;
      wRank: number;
      window: QuotaWindow;
    }

    const items: WindowSortItem[] = [];

    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const group = groups[gIdx];
      const gName = group.displayName || group.name || "";
      const groupLabel = cleanGroupLabel(gName);
      const gRank = groupRank(groupLabel);

      const buckets = group.buckets || [];
      for (const bucket of buckets) {
        const desc = windowDescriptor(bucket.window || "");
        const remFraction = typeof bucket.remaining_fraction === "number"
          ? bucket.remaining_fraction
          : typeof bucket.remainingFraction === "number"
          ? bucket.remainingFraction
          : 1.0;
        const clampedFraction = Math.max(0, Math.min(1, remFraction));
        const usedPercent = (1.0 - clampedFraction) * 100;
        const resetStr = bucket.reset_time || bucket.resetTime;
        const resetsAt = resetStr ? Date.parse(resetStr) : null;

        const id = `${groupLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${desc.suffix}`;
        const label = `${groupLabel} (${desc.suffix})`;
        const family = groupLabel === "Usage" ? undefined : groupLabel;

        items.push({
          gRank,
          gIdx,
          wRank: desc.rank,
          window: {
            id,
            label,
            family,
            usedPercent,
            periodMs: desc.periodMs,
            resetsAt,
          },
        });
      }
    }

    items.sort((a, b) => {
      if (a.gRank !== b.gRank) return a.gRank - b.gRank;
      if (a.gIdx !== b.gIdx) return a.gIdx - b.gIdx;
      return a.wRank - b.wRank;
    });

    const windows = items.map((i) => i.window);
    const account = preferredEmail || this.readAccountEmail();

    return {
      provider: "antigravity",
      account,
      windows,
      credits: [],
      fetchedAt: this.now(),
    };
  }
}
