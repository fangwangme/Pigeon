// Issue #13, #25. quota-and-usage.md §2.6, protocol.md §4.16, §5.11.
import type { ConfigManager } from "../config-manager";
import type { ClientConfig, QuotaGetPayload, QuotaProviderState, QuotaSnapshot } from "../../types/protocol";
import { scanIntervalToMs } from "../../shared/defaults";
import { ClaudeQuotaProvider } from "./claude";
import { CodexQuotaProvider } from "./codex";
import { AntigravityQuotaProvider } from "./antigravity";
import { orderWindows } from "./order";

export interface QuotaServiceOptions {
  claude?: ClaudeQuotaProvider;
  codex?: CodexQuotaProvider;
  antigravity?: AntigravityQuotaProvider;
  configManager?: ConfigManager;
  autoScan?: boolean;
  now?: () => number;
  onUpdated?: (payload: QuotaGetPayload) => void;
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
  private autoScan: boolean;
  private now: () => number;
  private onUpdated?: (payload: QuotaGetPayload) => void;
  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  private timerIntervalMs: number | null = null;
  private hasOnlineClients = false;
  private lastEnabled = false;
  private lastFetchTime: number | null = null;
  private refreshAllPromise: Promise<void> | null = null;

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
    this.autoScan = options.autoScan !== false;
    this.lastEnabled = options.configManager?.getClientConfig().quotaEnabled === true;
    this.now = options.now ?? (() => Date.now());
    this.onUpdated = options.onUpdated;
  }

  public setOnUpdated(cb?: (payload: QuotaGetPayload) => void): void {
    this.onUpdated = cb;
  }

  public getScanIntervalMs(): number {
    return scanIntervalToMs(this.configManager?.getClientConfig().usageScanInterval);
  }

  private isEnabled(clientConfig?: ClientConfig): boolean {
    const cfg = clientConfig ?? this.configManager?.getClientConfig();
    return cfg?.quotaEnabled === true;
  }

  private isStale(): boolean {
    return this.lastFetchTime === null || (this.now() - this.lastFetchTime) > this.getScanIntervalMs();
  }

  private stopBackgroundTimer(): void {
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
    this.timerIntervalMs = null;
  }

  public setClientOnline(online: boolean): void {
    this.hasOnlineClients = online;
    if (!online) {
      this.stopBackgroundTimer();
      return;
    }
    this.startBackgroundTimer();
    if (this.autoScan && this.isEnabled() && this.isStale()) {
      void this.fetchAll().catch((err) => console.error("[Pigeon] connect quota fetch failed:", err));
    }
  }

  public startBackgroundTimer(): void {
    if (!this.autoScan || !this.hasOnlineClients || !this.configManager || !this.isEnabled()) {
      this.stopBackgroundTimer();
      return;
    }
    const intervalMs = this.getScanIntervalMs();
    if (this.backgroundTimer && this.timerIntervalMs === intervalMs) return;
    this.stopBackgroundTimer();
    const backgroundFetch = () => void this.fetchAll().catch((err) => console.error("[Pigeon] background quota fetch failed:", err));
    this.backgroundTimer = setInterval(backgroundFetch, intervalMs);
    this.backgroundTimer.unref();
    this.timerIntervalMs = intervalMs;
  }

  public updateConfig(): void {
    const isNowEnabled = this.isEnabled();
    const becameEnabled = !this.lastEnabled && isNowEnabled;
    this.lastEnabled = isNowEnabled;
    this.startBackgroundTimer();
    if (becameEnabled) {
      void this.fetchAll().catch((err) => console.error("[Pigeon] post-enable quota fetch failed:", err));
    }
  }

  public destroy(): void {
    this.stopBackgroundTimer();
  }

  private isProviderEnabled(config: ClientConfig | undefined, key: "claude" | "codex" | "antigravity"): boolean {
    return config?.quotaProviders?.[key] !== false;
  }

  public async fetchAll(clientConfig?: ClientConfig): Promise<void> {
    if (this.refreshAllPromise) return this.refreshAllPromise;
    this.refreshAllPromise = (async () => {
      const config = clientConfig ?? this.configManager?.getClientConfig();
      const providerKeys: Array<"claude" | "codex" | "antigravity"> = ["claude", "codex", "antigravity"];
      const enabledKeys = providerKeys.filter((k) => this.isProviderEnabled(config, k));

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
      const currentCfg = clientConfig ?? this.configManager?.getClientConfig();
      if (!currentCfg || currentCfg.quotaEnabled === true) {
        this.onUpdated?.(this.buildPayload(currentCfg));
      }
    })().finally(() => {
      this.refreshAllPromise = null;
    });
    return this.refreshAllPromise;
  }

  private buildPayload(clientConfig?: ClientConfig): { providers: QuotaProviderState[]; fetchedAt: number } {
    const config = clientConfig ?? this.configManager?.getClientConfig();
    const providerKeys: Array<"claude" | "codex" | "antigravity"> = ["claude", "codex", "antigravity"];

    const results: QuotaProviderState[] = providerKeys.map((key) => {
      const isEnabled = this.isProviderEnabled(config, key);
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
    const fetchedAt = validFetchedTimes.length > 0 ? Math.max(...validFetchedTimes) : (this.lastFetchTime ?? 0);
    return { providers: results, fetchedAt };
  }

  /** Reads the daemon cache only; never triggers upstream provider requests (protocol.md §4.16). */
  public async getQuota(clientConfig?: ClientConfig): Promise<{ providers: QuotaProviderState[]; fetchedAt: number }> {
    return this.buildPayload(clientConfig);
  }

  private async fetchProvider(key: "claude" | "codex" | "antigravity"): Promise<QuotaSnapshot> {
    const provider = key === "claude" ? this.claude : key === "codex" ? this.codex : this.antigravity;
    const snap = await provider.fetch();
    return { ...snap, windows: orderWindows(snap.windows) };
  }
}
