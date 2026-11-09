// Issue #13. quota-and-usage.md §3, protocol.md §4.16–§4.18.
import { resolveRange, type UsagePreset } from "../../shared/usage";
import type { ClientConfig, UsageDayPayload, UsageGetPayload, UsageModelPayload } from "../../types/protocol";
import { PricingManager } from "./pricing";
import { UsageStore } from "./store";
import type { ConfigManager } from "../config-manager";

export interface UsageServiceOptions {
  store?: UsageStore;
  pricing?: PricingManager;
  configManager?: ConfigManager;
  now?: () => number;
}

export class UsageService {
  private store: UsageStore;
  private pricing: PricingManager;
  private configManager?: ConfigManager;
  private now: () => number;
  private scanPromise: Promise<{ scannedFiles: number; recordsAdded: number }> | null = null;
  private backgroundTimer: any = null;
  private hasScannedOnce = false;

  constructor(options: UsageServiceOptions = {}) {
    this.store = options.store ?? new UsageStore();
    this.pricing = options.pricing ?? new PricingManager();
    this.configManager = options.configManager;
    this.now = options.now ?? (() => Date.now());
    this.startBackgroundTimer();
  }

  public getScanMode(): "realtime" | "scheduled" {
    return this.configManager?.getClientConfig().usageScanMode ?? "scheduled";
  }

  public getScanIntervalMs(): number {
    const interval = this.configManager?.getClientConfig().usageScanInterval ?? "5m";
    switch (interval) {
      case "1m": return 60_000;
      case "2m": return 120_000;
      case "5m": return 300_000;
      case "10m": return 600_000;
      case "15m": return 900_000;
      default: return 300_000;
    }
  }

  public startBackgroundTimer(): void {
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
    const mode = this.getScanMode();
    if (mode === "scheduled") {
      const ms = this.getScanIntervalMs();
      this.backgroundTimer = setInterval(() => {
        void this.scan().catch((err) => console.error("[Pigeon] background usage scan failed:", err));
      }, ms);
      // Trigger non-blocking initial scan if not done yet
      if (!this.hasScannedOnce) {
        void this.scan().catch(() => {});
      }
    }
  }

  public updateConfig(client: ClientConfig): void {
    this.startBackgroundTimer();
  }

  public destroy(): void {
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
  }

  public async scan(): Promise<{ scannedFiles: number; recordsAdded: number }> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      await this.pricing.initialize();
      const res = await this.store.scanIncremental(this.pricing);
      this.hasScannedOnce = true;
      return res;
    })().finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  public async rebuild(): Promise<{ scannedFiles: number; recordsAdded: number; totalTokens: number; totalCost: number; recordCount: number }> {
    await this.pricing.initialize();
    const res = await this.store.rebuildAll(this.pricing);
    this.hasScannedOnce = true;
    const totals = this.store.getTotalsSummary();
    return {
      scannedFiles: res.scannedFiles,
      recordsAdded: res.recordsAdded,
      recordCount: totals.recordCount,
      totalTokens: totals.totalTokens,
      totalCost: totals.totalCost,
    };
  }

  public async getUsage(req: { preset: string; from?: string; to?: string; agents: string[]; force?: boolean }): Promise<UsageGetPayload> {
    if (req.force || this.getScanMode() === "realtime" || !this.hasScannedOnce) {
      await this.scan();
    }

    const nowDt = new Date(this.now());
    const today = `${nowDt.getFullYear()}-${String(nowDt.getMonth() + 1).padStart(2, "0")}-${String(nowDt.getDate()).padStart(2, "0")}`;

    const range = resolveRange(req.preset as UsagePreset, today, {
      from: req.from,
      to: req.to,
    });

    return this.store.getUsageReport(req, range, today, this.pricing.arePricesAvailable());
  }

  public async getDay(req: { date: string; agents: string[] }): Promise<UsageDayPayload> {
    if (this.getScanMode() === "realtime" || !this.hasScannedOnce) {
      await this.scan();
    }
    return this.store.getDayReport(req);
  }

  public async getModel(req: { model: string; from: string; to: string; agents: string[] }): Promise<UsageModelPayload> {
    if (this.getScanMode() === "realtime" || !this.hasScannedOnce) {
      await this.scan();
    }
    return this.store.getModelReport(req);
  }
}
