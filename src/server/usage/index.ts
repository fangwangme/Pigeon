// Issue #13, #25, #29. quota-and-usage.md §3, protocol.md §4.17–§4.19, §5.12.
import { formatYMD, resolveRange, type UsagePreset } from "../../shared/usage";
import type { UsageDayPayload, UsageGetPayload, UsageModelPayload } from "../../types/protocol";
import { PricingManager } from "./pricing";
import { UsageStore, type RepriceReport } from "./store";
import type { ConfigManager } from "../config-manager";
import type { ScanWorkerResponse } from "./scan-worker";
import { join } from "node:path";

const MAX_REPORT_CACHE_ENTRIES = 64;

export interface UsageServiceOptions {
  store?: UsageStore;
  pricing?: PricingManager;
  configManager?: ConfigManager;
  now?: () => number;
  onUpdated?: (payload: { scannedAt: number }) => void;
  debugLogger?: (msg: string) => void;
  useWorker?: boolean;
  dbPath?: string;
  pricingCachePath?: string;
  home?: string;
  env?: Record<string, string | undefined>;
}

export class UsageService {
  private store: UsageStore;
  private pricing: PricingManager;
  private configManager?: ConfigManager;
  private now: () => number;
  private onUpdated?: (payload: { scannedAt: number }) => void;
  private debugLogger?: (msg: string) => void;
  private useWorker: boolean;
  private dbPath?: string;
  private pricingCachePath?: string;
  private home?: string;
  private optionsEnv?: Record<string, string | undefined>;
  private workerPricesAvailable: boolean | null = null;
  private reportCache = new Map<string, any>();
  private scanPromise: Promise<{ scannedFiles: number; recordsAdded: number }> | null = null;
  private hasScannedOnce = false;
  private lastScanTime: number | null = null;
  private lastScanDurationMs = 0;
  private lastScanError: string | null = null;

  constructor(options: UsageServiceOptions = {}) {
    this.configManager = options.configManager;
    // The usage database sits in the daemon's state directory; the agents' files are under the config's home.
    const stateDir = options.configManager?.getServerConfig().stateDir;
    this.dbPath = options.dbPath ?? (stateDir ? join(stateDir, "usage.db") : undefined);
    this.pricingCachePath = options.pricingCachePath ?? (stateDir ? join(stateDir, "pricing-cache.json") : undefined);
    this.home = options.home ?? options.configManager?.home;
    this.optionsEnv = options.env;
    this.store = options.store ?? new UsageStore({ dbPath: this.dbPath, home: this.home, env: this.currentEnv() });
    this.pricing = options.pricing ?? new PricingManager({ cachePath: this.pricingCachePath });
    this.now = options.now ?? (() => Date.now());
    this.onUpdated = options.onUpdated;
    this.debugLogger = options.debugLogger;
    this.useWorker = options.useWorker ?? (!options.store && !options.pricing && !options.now);
  }

  private currentEnv(): Record<string, string | undefined> {
    return {
      HOME: this.home ?? this.configManager?.env?.HOME ?? process.env.HOME,
      XDG_DATA_HOME: this.optionsEnv?.XDG_DATA_HOME ?? this.configManager?.env?.XDG_DATA_HOME ?? process.env.XDG_DATA_HOME,
      CODEX_HOME: this.optionsEnv?.CODEX_HOME ?? this.configManager?.env?.CODEX_HOME ?? process.env.CODEX_HOME,
    };
  }

  public setOnUpdated(cb?: (payload: { scannedAt: number }) => void): void {
    this.onUpdated = cb;
  }

  public setDebugLogger(cb?: (msg: string) => void): void {
    this.debugLogger = cb;
  }

  private isEnabled(): boolean {
    return this.configManager ? this.configManager.getClientConfig().usageEnabled !== false : true;
  }

  public destroy(): void {
    this.reportCache.clear();
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

  private cacheGetOrCompute<T>(key: string, compute: () => T): T {
    if (this.reportCache.has(key)) return this.reportCache.get(key) as T;
    const val = compute();
    if (this.reportCache.size >= MAX_REPORT_CACHE_ENTRIES) {
      const oldest = this.reportCache.keys().next().value;
      if (oldest !== undefined) this.reportCache.delete(oldest);
    }
    this.reportCache.set(key, val);
    return val;
  }

  private runWorker(kind: "scan" | "rebuild"): Promise<Extract<ScanWorkerResponse, { ok: true }>> {
    return new Promise((resolve, reject) => {
      const workerUrl = import.meta.url.includes("/$bunfs/")
        ? new URL("./server/usage/scan-worker.js", import.meta.url)
        : new URL("./scan-worker.ts", import.meta.url);
      const worker = new Worker(workerUrl);
      const cleanup = () => {
        try {
          worker.terminate();
        } catch {}
      };
      worker.onmessage = (event: MessageEvent<ScanWorkerResponse>) => {
        cleanup();
        const data = event.data;
        if (!data || !data.ok) {
          reject(new Error(data?.error || "Usage worker failed"));
          return;
        }
        resolve(data);
      };
      worker.onerror = (err: ErrorEvent) => {
        cleanup();
        reject(err.error instanceof Error ? err.error : new Error(err.message || "Usage worker crashed"));
      };
      worker.postMessage({
        kind,
        dbPath: this.dbPath,
        cachePath: this.pricingCachePath,
        home: this.home,
        env: this.currentEnv(),
        blockNonLoopbackFetch:
          typeof globalThis.fetch === "function" && String(globalThis.fetch).includes("Blocked unexpected outbound fetch"),
      });
    });
  }

  public async scan(): Promise<{ scannedFiles: number; recordsAdded: number }> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      const start = this.now();
      this.debugLogger?.("debug usage scan start");
      try {
        let res: { scannedFiles: number; recordsAdded: number };
        if (this.useWorker) {
          const workerRes = await this.runWorker("scan");
          this.store.syncScannedAt(workerRes.scannedAt);
          this.workerPricesAvailable = workerRes.pricesAvailable;
          res = { scannedFiles: workerRes.scannedFiles, recordsAdded: workerRes.recordsAdded };
        } else {
          await this.pricing.initialize();
          res = await this.store.scanIncremental(this.pricing);
        }
        this.reportCache.clear();
        this.hasScannedOnce = true;
        this.lastScanTime = this.now();
        this.lastScanDurationMs = this.now() - start;
        this.lastScanError = null;
        this.debugLogger?.(
          `debug usage scan done ${this.lastScanDurationMs}ms (files=${res.scannedFiles}, added=${res.recordsAdded})`
        );
        if (this.isEnabled()) {
          const scannedAt = this.store.getLastScannedAt?.() || this.lastScanTime;
          this.onUpdated?.({ scannedAt });
        }
        return res;
      } catch (err: any) {
        this.lastScanError = err.message || String(err);
        this.debugLogger?.(`debug usage scan failed ${Math.max(0, this.now() - start)}ms: ${this.lastScanError}`);
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
      this.reportCache.clear();
      if (this.useWorker) {
        const workerRes = await this.runWorker("rebuild");
        if (workerRes.kind !== "rebuild") throw new Error("Unexpected worker reply for rebuild");
        this.store.syncScannedAt(workerRes.scannedAt);
        this.workerPricesAvailable = workerRes.pricesAvailable;
        this.hasScannedOnce = true;
        return {
          scannedFiles: workerRes.scannedFiles,
          recordsAdded: workerRes.recordsAdded,
          recordCount: workerRes.recordCount,
          totalTokens: workerRes.totalTokens,
          totalCost: workerRes.totalCost,
        };
      }
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

  /** quota-and-usage.md §3.3 Reprice: wait for an in-flight scan, then recompute derived costs. */
  public async reprice(opts: { apply: boolean; expectFingerprint?: string }): Promise<RepriceReport> {
    if (this.scanPromise) await this.scanPromise;
    await this.pricing.initialize();
    const report = this.store.reprice(this.pricing, opts);
    if (report.applied) {
      this.reportCache.clear();
      const scannedAt = this.store.getLastScannedAt() || this.now();
      if (this.isEnabled()) this.onUpdated?.({ scannedAt });
    }
    return report;
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
    const pricesAvailable = this.useWorker
      ? (this.workerPricesAvailable ?? this.pricing.arePricesAvailable())
      : this.pricing.arePricesAvailable();
    const scannedAt = this.store.getLastScannedAt();
    const isTodaySingle = range.from === today && range.to === today;
    const nowMinutes = isTodaySingle ? nowDt.getHours() * 60 + nowDt.getMinutes() : -1;
    const cacheKey = `usage|${scannedAt}|${today}|${nowMinutes}|${pricesAvailable ? 1 : 0}|${req.preset}|${range.from}|${range.to}|${[...req.agents].sort().join(",")}`;

    return this.cacheGetOrCompute(cacheKey, () =>
      this.store.getUsageReport(req, range, today, pricesAvailable, firstDay)
    );
  }

  public async getDay(req: { date: string; agents: string[] }): Promise<UsageDayPayload> {
    if (!this.hasScannedOnce) {
      await this.scan();
    }
    const scannedAt = this.store.getLastScannedAt();
    const cacheKey = `day|${scannedAt}|${req.date}|${[...req.agents].sort().join(",")}`;
    return this.cacheGetOrCompute(cacheKey, () => this.store.getDayReport(req));
  }

  public async getModel(req: { model: string; from: string; to: string; agents: string[] }): Promise<UsageModelPayload> {
    if (!this.hasScannedOnce) {
      await this.scan();
    }
    const scannedAt = this.store.getLastScannedAt();
    const cacheKey = `model|${scannedAt}|${req.model}|${req.from}|${req.to}|${[...req.agents].sort().join(",")}`;
    return this.cacheGetOrCompute(cacheKey, () => this.store.getModelReport(req));
  }
}
