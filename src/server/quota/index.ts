// Issue #13. quota-and-usage.md §2.6, protocol.md §4.15.
import type { ConfigManager } from "../config-manager";
import type { ClientConfig, QuotaProviderState, QuotaSnapshot } from "../../types/protocol";
import { ClaudeQuotaProvider } from "./claude";
import { CodexQuotaProvider } from "./codex";
import { AntigravityQuotaProvider } from "./antigravity";

export interface QuotaServiceOptions {
  claude?: ClaudeQuotaProvider;
  codex?: CodexQuotaProvider;
  antigravity?: AntigravityQuotaProvider;
  configManager?: ConfigManager;
  autoScan?: boolean;
  now?: () => number;
}

interface ProviderRecord {
  snapshot: QuotaSnapshot | null;
  error: { message: string; at: number } | null;
  fetchedAt: number;
}

export class QuotaService {
  private claude: ClaudeQuotaProvider;
  private codex: CodexQuotaProvider;
  private antigravity: AntigravityQuotaProvider;
  private configManager?: ConfigManager;
  private now: () => number;
  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  private hasFetchedOnce = false;
  private lastEnabled = true;
  private lastFetchTime: number | null = null;

  private cache: Record<"claude" | "codex" | "antigravity", ProviderRecord> = {
    claude: { snapshot: null, error: null, fetchedAt: 0 },
    codex: { snapshot: null, error: null, fetchedAt: 0 },
    antigravity: { snapshot: null, error: null, fetchedAt: 0 },
  };

  private inFlight: Partial<Record<"claude" | "codex" | "antigravity", Promise<QuotaSnapshot>>> = {};

  constructor(options: QuotaServiceOptions = {}) {
    this.claude = options.claude ?? new ClaudeQuotaProvider();
    this.codex = options.codex ?? new CodexQuotaProvider();
    this.antigravity = options.antigravity ?? new AntigravityQuotaProvider();
    this.configManager = options.configManager;
    this.lastEnabled = options.configManager?.getClientConfig().quotaUsageEnabled !== false;
    this.now = options.now ?? (() => Date.now());
    if (options.autoScan !== false && options.configManager) {
      this.startBackgroundTimer();
    }
  }

  public getScanMode(): "realtime" | "scheduled" {
    return this.configManager?.getClientConfig().usageScanMode ?? "scheduled";
  }

  public getScanIntervalMs(): number {
    const interval = this.configManager?.getClientConfig().usageScanInterval ?? "15m";
    switch (interval) {
      case "1m": return 60_000;
      case "2m": return 120_000;
      case "5m": return 300_000;
      case "10m": return 600_000;
      case "15m": return 900_000;
      default: return 900_000;
    }
  }

  public startBackgroundTimer(): void {
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
    const clientCfg = this.configManager?.getClientConfig();
    if (clientCfg && clientCfg.quotaUsageEnabled === false) return;
    if (this.getScanMode() !== "scheduled") return;
    const backgroundFetch = () => void this.fetchAll().catch((err) => console.error("[Pigeon] background quota fetch failed:", err));
    this.backgroundTimer = setInterval(backgroundFetch, this.getScanIntervalMs());
    this.backgroundTimer.unref();
    if (!this.hasFetchedOnce) backgroundFetch();
  }

  public updateConfig(): void {
    const isNowEnabled = this.configManager?.getClientConfig().quotaUsageEnabled !== false;
    const becameEnabled = !this.lastEnabled && isNowEnabled;
    this.lastEnabled = isNowEnabled;
    this.startBackgroundTimer();
    if (becameEnabled) {
      void this.fetchAll().catch((err) => console.error("[Pigeon] post-enable quota fetch failed:", err));
    }
  }

  public destroy(): void {
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
  }

  public async fetchAll(clientConfig?: ClientConfig): Promise<void> {
    const config = clientConfig ?? this.configManager?.getClientConfig();
    const providersConfig = config?.quotaProviders ?? { claude: true, codex: true, antigravity: true };
    const providerKeys: Array<"claude" | "codex" | "antigravity"> = ["claude", "codex", "antigravity"];
    const enabledKeys = providerKeys.filter((k) => providersConfig[k] !== false);

    await Promise.all(
      enabledKeys.map(async (key) => {
        try {
          if (!this.inFlight[key]) {
            this.inFlight[key] = this.fetchProvider(key).finally(() => {
              delete this.inFlight[key];
            });
          }
          const snap = await this.inFlight[key]!;
          this.cache[key] = {
            snapshot: snap,
            error: null,
            fetchedAt: this.now(),
          };
        } catch (err) {
          this.cache[key].error = {
            message: `${key}: ${(err as Error).message}`,
            at: this.now(),
          };
        }
      })
    );
    this.lastFetchTime = this.now();
    this.hasFetchedOnce = true;
  }

  public async getQuota(clientConfig?: ClientConfig, force?: boolean): Promise<{ providers: QuotaProviderState[]; fetchedAt: number }> {
    const config = clientConfig ?? this.configManager?.getClientConfig();
    const mode = config?.usageScanMode ?? this.getScanMode();
    const now = this.now();

    if (mode === "scheduled") {
      // Scheduled mode: use pre-fetched background cache, never scan on query unless never fetched
      if (!this.hasFetchedOnce) {
        await this.fetchAll(config);
      }
    } else {
      // Realtime mode: allow user-initiated queries with 60-second cooldown
      const isCooldown = this.lastFetchTime !== null && (now - this.lastFetchTime < 60_000);
      if (!isCooldown || !this.hasFetchedOnce) {
        await this.fetchAll(config);
      }
    }

    const providersConfig = config?.quotaProviders ?? { claude: true, codex: true, antigravity: true };
    const providerKeys: Array<"claude" | "codex" | "antigravity"> = ["claude", "codex", "antigravity"];

    const results: QuotaProviderState[] = providerKeys.map((key) => {
      const isEnabled = providersConfig[key] ?? false;
      if (!isEnabled) {
        return {
          provider: key,
          enabled: false,
          snapshot: null,
          error: null,
        };
      }
      return {
        provider: key,
        enabled: true,
        snapshot: this.cache[key].snapshot,
        error: this.cache[key].error,
      };
    });

    const validFetchedTimes = results
      .map((r) => r.snapshot?.fetchedAt ?? r.error?.at)
      .filter((t): t is number => typeof t === "number" && t > 0);
    const fetchedAt = validFetchedTimes.length > 0 ? Math.max(...validFetchedTimes) : (this.lastFetchTime ?? now);
    return { providers: results, fetchedAt };
  }

  private fetchProvider(key: "claude" | "codex" | "antigravity"): Promise<QuotaSnapshot> {
    switch (key) {
      case "claude":
        return this.claude.fetch();
      case "codex":
        return this.codex.fetch();
      case "antigravity":
        return this.antigravity.fetch();
    }
  }
}
