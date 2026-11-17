// Issue #13, #25, #29. quota-and-usage.md §3, protocol.md §4.17–§4.19, §5.12.
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
  autoScan?: boolean;
  onUpdated?: (payload: { scannedAt: number }) => void;
}

export class UsageService {
  private store: UsageStore;
  private pricing: PricingManager;
  private configManager?: ConfigManager;
  private now: () => number;
  private onUpdated?: (payload: { scannedAt: number }) => void;
  private scanPromise: Promise<{ scannedFiles: number; recordsAdded: number }> | null = null;
  private hasScannedOnce = false;
  private lastScanTime: number | null = null;
  private lastScanDurationMs = 0;
  private lastScanError: string | null = null;

  constructor(options: UsageServiceOptions = {}) {
    this.configManager = options.configManager;
    // The usage database sits in the daemon's state directory; the agents' files are under the config's home.
    const stateDir = options.configManager?.getServerConfig().stateDir;
    this.store =
      options.store ?? new UsageStore({ dbPath: stateDir ? join(stateDir, "usage.db") : undefined, home: options.configManager?.home });
    this.pricing = options.pricing ?? new PricingManager({ cachePath: stateDir ? join(stateDir, "pricing-cache.json") : undefined });
    this.now = options.now ?? (() => Date.now());
    this.onUpdated = options.onUpdated;
  }

  public setOnUpdated(cb?: (payload: { scannedAt: number }) => void): void {
    this.onUpdated = cb;
  }

  private isEnabled(): boolean {
    return this.configManager ? this.configManager.getClientConfig().usageEnabled !== false : true;
  }

  public destroy(): void {
    // A scan still in flight keeps the database until it settles; its own failure is reported by its caller.
    const close = () => this.store.close();
    if (this.scanPromise) this.scanPromise.then(close, close);
    else close();
  }

  public getLastScanInfo() {
    return {
      time: this.lastScanTime,
      durationMs: this.lastScanDurationMs,
      error: this.lastScanError,
    };
  }

  public async scan(): Promise<{ scannedFiles: number; recordsAdded: number }> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      const start = this.now();
      try {
        await this.pricing.initialize();
        const res = await this.store.scanIncremental(this.pricing);
        this.hasScannedOnce = true;
        this.lastScanTime = this.now();
        this.lastScanDurationMs = this.now() - start;
        this.lastScanError = null;
        if (this.isEnabled()) {
          const scannedAt = this.store.getLastScannedAt?.() || this.lastScanTime;
          this.onUpdated?.({ scannedAt });
        }
        return res;
      } catch (err: any) {
        this.lastScanError = err.message || String(err);
        throw err;
      }
    })().finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  public async rebuild(): Promise<{ scannedFiles: number; recordsAdded: number; totalTokens: number; totalCost: number; recordCount: number }> {
    while (this.scanPromise) {
      try {
        await this.scanPromise;
      } catch {}
    }

    let resolveRebuild: () => void = () => {};
    const rebuildPromise = new Promise<{ scannedFiles: number; recordsAdded: number }>((resolve) => {
      resolveRebuild = () => resolve({ scannedFiles: 0, recordsAdded: 0 });
    });
    this.scanPromise = rebuildPromise;

    try {
      this.hasScannedOnce = false;
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
    } finally {
      this.scanPromise = null;
      resolveRebuild();
    }
  }

  public async getUsage(req: { preset: string; from?: string; to?: string; agents: string[]; force?: boolean }): Promise<UsageGetPayload> {
    if (req.force || !this.hasScannedOnce) {
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
    if (!this.hasScannedOnce) {
      await this.scan();
    }
    return this.store.getDayReport(req);
  }

  public async getModel(req: { model: string; from: string; to: string; agents: string[] }): Promise<UsageModelPayload> {
    if (!this.hasScannedOnce) {
      await this.scan();
    }
    return this.store.getModelReport(req);
  }
}
