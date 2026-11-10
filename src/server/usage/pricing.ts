// Issue #13. quota-and-usage.md §3.3. Pricing manager.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, pricingKey } from "./model-id";

export interface ModelPrice {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken?: number;
  cacheWriteCostPerToken?: number;
  source: string;
}

export interface PricingManagerOptions {
  cachePath?: string;
  now?: () => number;
  fetch?: (input: any, init?: any) => Promise<Response>;
}

const MODELSDEV_URL = "https://models.dev/api.json";
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

export class PricingManager {
  private cachePath: string;
  private now: () => number;
  private fetchFn: (input: any, init?: any) => Promise<Response>;
  private catalog = new Map<string, ModelPrice>();
  private loaded = false;
  private pricesAvailable = false;

  constructor(options: PricingManagerOptions = {}) {
    const defaultDataDir = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "pigeon") : join(process.env.HOME || "", ".local", "share", "pigeon");
    this.cachePath = options.cachePath ?? join(defaultDataDir, "pricing-cache.json");
    this.now = options.now ?? (() => Date.now());
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  public arePricesAvailable(): boolean {
    return this.pricesAvailable;
  }

  public async initialize(): Promise<void> {
    if (this.loaded) return;

    // 1. Try disk cache
    const cacheResult = this.loadFromCache(this.cachePath);
    if (cacheResult.fresh && cacheResult.hasEntries) {
      this.loaded = true;
      this.pricesAvailable = true;
      return;
    }

    // Fallback seed cache from pigeon if present
    const pigeonPricing = join(dirname(this.cachePath), "pricing.json");
    if (!cacheResult.hasEntries && existsSync(pigeonPricing) && this.loadFromSeedCache(pigeonPricing)) {
      this.loaded = true;
      this.pricesAvailable = true;
      return;
    }

    // 2. Try fetching from network
    let networkOk = false;
    try {
      networkOk = await this.refreshFromNetwork();
    } catch {}

    if (networkOk) {
      this.pricesAvailable = this.catalog.size > 0;
      this.loaded = true;
    } else {
      // Network failed: if we loaded stale or seed cache, use it as offline fallback
      this.pricesAvailable = this.catalog.size > 0;
      // Do not mark loaded = true permanently so future scans retry
      this.loaded = false;
    }
  }

  private loadFromCache(path: string): { fresh: boolean; hasEntries: boolean } {
    if (!existsSync(path)) return { fresh: false, hasEntries: false };
    try {
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw);
      const fetchedAt = data.fetchedAt || 0;
      const fresh = this.now() - fetchedAt <= 24 * 60 * 60 * 1000;
      if (data.entries) {
        for (const [k, v] of Object.entries(data.entries)) {
          this.catalog.set(k, v as ModelPrice);
        }
        return { fresh, hasEntries: this.catalog.size > 0 };
      }
    } catch {
      return { fresh: false, hasEntries: false };
    }
    return { fresh: false, hasEntries: false };
  }

  private loadFromSeedCache(path: string): boolean {
    try {
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw);
      const entries = data?.pricing?.entries || data?.entries;
      if (entries) {
        for (const [k, v] of Object.entries(entries)) {
          const rec = v as any;
          const p = rec?.pricing || rec;
          if (p && typeof p.input_cost_per_token === "number") {
            const canonicalKey = canonical(k);
            const price: ModelPrice = {
              inputCostPerToken: p.input_cost_per_token,
              outputCostPerToken: p.output_cost_per_token || 0,
              cacheReadCostPerToken: p.cache_read_input_token_cost,
              cacheWriteCostPerToken: p.cache_creation_input_token_cost,
              source: rec?.source || "seed-cache",
            };
            if (!this.catalog.has(canonicalKey)) this.catalog.set(canonicalKey, price);
            this.catalog.set(pricingKey(k), price);
          }
        }
        return this.catalog.size > 0;
      }
    } catch {
      return false;
    }
    return false;
  }

  private async refreshFromNetwork(): Promise<boolean> {
    const newCatalog = new Map<string, ModelPrice>();

    // Source 1: models.dev
    try {
      const res = await this.fetchFn(MODELSDEV_URL, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const providers = (await res.json()) as any;
        for (const [provider, providerData] of Object.entries(providers)) {
          const models = (providerData as any)?.models || {};
          for (const m of Object.values(models)) {
            const cost = (m as any)?.cost;
            if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") continue;
            const price: ModelPrice = {
              inputCostPerToken: cost.input / 1_000_000,
              outputCostPerToken: cost.output / 1_000_000,
              cacheReadCostPerToken: typeof cost.cache_read === "number" ? cost.cache_read / 1_000_000 : undefined,
              cacheWriteCostPerToken: typeof cost.cache_write === "number" ? cost.cache_write / 1_000_000 : undefined,
              source: "models.dev",
            };
            const id = (m as any).id || "";
            const key1 = canonical(`${provider}/${id}`);
            const key2 = canonical(id);
            if (!newCatalog.has(key1)) newCatalog.set(key1, price);
            if (!newCatalog.has(key2)) newCatalog.set(key2, price);
          }
        }
      }
    } catch {}

    // Source 2: litellm
    try {
      const res = await this.fetchFn(LITELLM_URL, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = (await res.json()) as any;
        for (const [id, m] of Object.entries(data)) {
          const cost = m as any;
          if (!cost || typeof cost.input_cost_per_token !== "number") continue;
          const price: ModelPrice = {
            inputCostPerToken: cost.input_cost_per_token,
            outputCostPerToken: cost.output_cost_per_token || 0,
            cacheReadCostPerToken: cost.cache_read_input_token_cost,
            cacheWriteCostPerToken: cost.cache_creation_input_token_cost,
            source: "litellm",
          };
          const key = canonical(id);
          if (!newCatalog.has(key)) newCatalog.set(key, price);
        }
      }
    } catch {}

    // Source 3: openrouter
    try {
      const res = await this.fetchFn(OPENROUTER_URL, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = (await res.json()) as any;
        const models = data?.data || [];
        for (const m of models) {
          const p = m.pricing;
          if (!p) continue;
          const inp = typeof p.prompt === "string" ? parseFloat(p.prompt) : Number(p.prompt);
          const out = typeof p.completion === "string" ? parseFloat(p.completion) : Number(p.completion);
          if (isNaN(inp) || isNaN(out)) continue;
          const price: ModelPrice = {
            inputCostPerToken: inp,
            outputCostPerToken: out,
            source: "openrouter",
          };
          const key = canonical(m.id);
          if (!newCatalog.has(key)) newCatalog.set(key, price);
        }
      }
    } catch {}

    if (newCatalog.size > 0) {
      this.catalog = newCatalog;
      try {
        mkdirSync(dirname(this.cachePath), { recursive: true });
        const obj: Record<string, any> = {
          fetchedAt: this.now(),
          entries: Object.fromEntries(this.catalog.entries()),
        };
        writeFileSync(this.cachePath, JSON.stringify(obj), "utf-8");
      } catch {}
    }
    return newCatalog.size > 0;
  }

  public getPrice(modelId: string): ModelPrice | null {
    const k1 = canonical(modelId);
    if (this.catalog.has(k1)) return this.catalog.get(k1)!;
    const k2 = pricingKey(modelId);
    if (this.catalog.has(k2)) return this.catalog.get(k2)!;
    return null;
  }
}
