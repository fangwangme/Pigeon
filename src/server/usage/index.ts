// Issue #13. quota-and-usage.md §3, protocol.md §4.16–§4.18.
import { formatYMD, resolveRange, type UsagePreset } from "../../shared/usage";
import type { UsageDayPayload, UsageGetPayload, UsageModelPayload } from "../../types/protocol";
import { PricingManager } from "./pricing";
import { UsageStore } from "./store";
import type { ConfigManager } from "../config-manager";
import { join } from "node:path";

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
  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  private hasScannedOnce = false;

  constructor(options: UsageServiceOptions = {}) {
    this.configManager = options.configManager;
    // The usage database sits in the daemon's state directory; the agents' files are under the config's home.
    const stateDir = options.configManager?.getServerConfig().stateDir;
    this.store =
      options.store ?? new UsageStore({ dbPath: stateDir ? join(stateDir, "usage.db") : undefined, home: options.configManager?.home });
    this.pricing = options.pricing ?? new PricingManager({ cachePath: stateDir ? join(stateDir, "pricing-cache.json") : undefined });
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
    if (this.getScanMode() !== "scheduled") return;
    const backgroundScan = () => void this.scan().catch((err) => console.error("[Pigeon] background usage scan failed:", err));
    // §3.7: scheduled mode scans in the background; the timer never keeps a one-shot CLI process alive.
    this.backgroundTimer = setInterval(backgroundScan, this.getScanIntervalMs());
    this.backgroundTimer.unref();
    if (!this.hasScannedOnce) backgroundScan();
  }

  /** The scan mode or interval may have changed (`config_patch`). */
  public updateConfig(): void {
    this.startBackgroundTimer();
  }

  public destroy(): void {
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
    // A scan still in flight keeps the database until it settles; its own failure is reported by its caller.
    const close = () => this.store.close();
    if (this.scanPromise) this.scanPromise.then(close, close);
    else close();
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
    const today = formatYMD(nowDt);

    const firstDay = this.store.getFirstDay(req.agents);
    const range = resolveRange(req.preset as UsagePreset, today, {
      firstDay,
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
