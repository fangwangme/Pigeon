// Issue #13. quota-and-usage.md §2.2, §2.3, §4.
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { QuotaSnapshot, QuotaWindow } from "../../types/protocol";
import { fileCredentialSource, type CredentialSource } from "./credentials";

export interface ClaudeQuotaProviderOptions {
  home?: string;
  usageUrl?: string;
  /** `false` skips the macOS Keychain; a `CredentialSource` replaces it (tests). Default: on macOS only. */
  keychain?: boolean | CredentialSource;
  now?: () => number;
}

const DEFAULT_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const HOUR_MS = 60 * 60 * 1000;
const WINDOW_PERIODS: Record<string, number> = { five_hour: 5 * HOUR_MS, seven_day: 7 * 24 * HOUR_MS };

/** The login Keychain item Claude Code keeps on macOS (`security-and-pairing.md` §6). */
function macKeychainSource(): CredentialSource {
  const account = userInfo().username;
  return {
    read: () => {
      const res = Bun.spawnSync(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
      return res.exitCode === 0 ? res.stdout.toString().trim() || null : null;
    },
    write: (raw) => {
      // Through `security -i` on stdin, hex-encoded, so the token never appears in a process list.
      const command = `add-generic-password -U -a "${account}" -s "${KEYCHAIN_SERVICE}" -X "${Buffer.from(raw, "utf-8").toString("hex")}"\n`;
      const res = Bun.spawnSync(["security", "-i"], { stdin: new TextEncoder().encode(command) });
      if (res.exitCode !== 0) throw new Error(`Keychain write failed with exit code ${res.exitCode}`);
    },
  };
}

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
    return {
      provider: "claude",
      plan: oauth.subscriptionType,
      account: this.readAccountEmail(),
      windows: this.windowsOf(usageData),
      credits: [],
      fetchedAt: this.now(),
    };
  }

  /** §2.2: `five_hour` → 5 hours, `seven_day` → 7 days, `seven_day_<family>` → 7 days of that family, in the response's order. */
  private windowsOf(usageData: Record<string, any>): QuotaWindow[] {
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
