// Issue #13. quota-and-usage.md §3, protocol.md §4.16–§4.18.
import { resolveRange, type UsagePreset } from "../../shared/usage";
import type { UsageDayPayload, UsageGetPayload, UsageModelPayload } from "../../types/protocol";
import { PricingManager } from "./pricing";
import { UsageStore } from "./store";

export interface UsageServiceOptions {
  store?: UsageStore;
  pricing?: PricingManager;
  now?: () => number;
}

export class UsageService {
  private store: UsageStore;
  private pricing: PricingManager;
  private now: () => number;
  private scanPromise: Promise<{ scannedFiles: number; recordsAdded: number }> | null = null;

  constructor(options: UsageServiceOptions = {}) {
    this.store = options.store ?? new UsageStore();
    this.pricing = options.pricing ?? new PricingManager();
    this.now = options.now ?? (() => Date.now());
  }

  public async scan(): Promise<{ scannedFiles: number; recordsAdded: number }> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      await this.pricing.initialize();
      return this.store.scanIncremental(this.pricing);
    })().finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  public async getUsage(req: { preset: string; from?: string; to?: string; agents: string[] }): Promise<UsageGetPayload> {
    await this.scan();

    const nowDt = new Date(this.now());
    const today = `${nowDt.getFullYear()}-${String(nowDt.getMonth() + 1).padStart(2, "0")}-${String(nowDt.getDate()).padStart(2, "0")}`;

    const range = resolveRange(req.preset as UsagePreset, today, {
      from: req.from,
      to: req.to,
    });

    return this.store.getUsageReport(req, range, today, this.pricing.arePricesAvailable());
  }

  public async getDay(req: { date: string; agents: string[] }): Promise<UsageDayPayload> {
    await this.scan();
    return this.store.getDayReport(req);
  }

  public async getModel(req: { model: string; from: string; to: string; agents: string[] }): Promise<UsageModelPayload> {
    await this.scan();
    return this.store.getModelReport(req);
  }
}
