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
  retryIntervalMs?: number;
}

const MODELSDEV_URL = "https://models.dev/api.json";
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_PARTY_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "google-vertex",
  "deepseek",
  "zhipuai",
  "zai",
  "minimax",
  "moonshotai",
  "xai",
  "mistral",
  "cohere",
];

function providerPriority(provider: string): number {
  const idx = FIRST_PARTY_PROVIDERS.indexOf(provider.toLowerCase());
  return idx >= 0 ? idx : FIRST_PARTY_PROVIDERS.length;
}

export class PricingManager {
  private cachePath: string;
  private now: () => number;
  private fetchFn: (input: any, init?: any) => Promise<Response>;
  private catalog = new Map<string, ModelPrice>();
  private loaded = false;
  private lastFetchAt = 0;
  private catalogVersion = 0;
  private pricesAvailable = false;
  private nextRetryAt = 0;
  private retryIntervalMs: number;

  constructor(options: PricingManagerOptions = {}) {
    const defaultDataDir = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "pigeon") : join(process.env.HOME || "", ".local", "share", "pigeon");
    this.cachePath = options.cachePath ?? join(defaultDataDir, "pricing-cache.json");
    this.now = options.now ?? (() => Date.now());
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.retryIntervalMs = options.retryIntervalMs ?? 10 * 60 * 1000;
  }

  public arePricesAvailable(): boolean {
    return this.pricesAvailable;
  }

  public getCatalogEntries(): Array<[string, ModelPrice]> {
    return Array.from(this.catalog.entries());
  }

  public getCatalogVersion(): number {
    return this.catalogVersion;
  }

  public async initialize(): Promise<void> {
    const now = this.now();
    if (this.loaded && now - this.lastFetchAt <= DAY_MS) return;
    if (now < this.nextRetryAt) return;
    const before = JSON.stringify([...this.catalog]);
    await this.load(now);
    if (JSON.stringify([...this.catalog]) !== before) this.catalogVersion++;
  }

  private async load(now: number): Promise<void> {
    // 1. Try disk cache
    const cacheResult = this.loadFromCache(this.cachePath);
    if (cacheResult.fresh && cacheResult.hasEntries) {
      this.loaded = true;
      this.pricesAvailable = true;
      this.lastFetchAt = cacheResult.fetchedAt;
      return;
    }

    // Fallback seed cache from pigeon if present
    const pigeonPricing = join(dirname(this.cachePath), "pricing.json");
    if (!this.loaded && !cacheResult.hasEntries && existsSync(pigeonPricing) && this.loadFromSeedCache(pigeonPricing)) {
      this.loaded = true;
      this.pricesAvailable = true;
      this.lastFetchAt = now;
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
      this.lastFetchAt = now;
      this.nextRetryAt = 0;
    } else {
      // Network failed: if we loaded stale or seed cache, use it as offline fallback
      this.pricesAvailable = this.catalog.size > 0;
      // Do not mark loaded = true permanently so future scans retry, but throttle retries to avoid hanging scans
      this.loaded = false;
      this.nextRetryAt = now + this.retryIntervalMs;
    }
  }

  private loadFromCache(path: string): { fresh: boolean; hasEntries: boolean; fetchedAt: number } {
    if (!existsSync(path)) return { fresh: false, hasEntries: false, fetchedAt: 0 };
    try {
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw);
      const fetchedAt = data.fetchedAt || 0;
      const fresh = this.now() - fetchedAt <= DAY_MS;
      if (data.entries) {
        for (const [k, v] of Object.entries(data.entries)) {
          if (k.includes("/")) continue;
          this.catalog.set(k, v as ModelPrice);
        }
        return { fresh, hasEntries: this.catalog.size > 0, fetchedAt };
      }
    } catch {
      return { fresh: false, hasEntries: false, fetchedAt: 0 };
    }
    return { fresh: false, hasEntries: false, fetchedAt: 0 };
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
    const modelsDevCatalog = new Map<string, ModelPrice>();
    const litellmCatalog = new Map<string, ModelPrice>();
    const openrouterCatalog = new Map<string, ModelPrice>();
    const TIMEOUT_MS = 2500;

    // Fetch sources concurrently with bounded timeout so slow network endpoints do not stall scans
    await Promise.allSettled([
      // Source 1: models.dev
      (async () => {
        try {
          const res = await this.fetchFn(MODELSDEV_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (res.ok) {
            const providers = (await res.json()) as any;
            const orderedProviders = Object.entries(providers).sort(
              ([a], [b]) => providerPriority(a) - providerPriority(b)
            );
            for (const [_provider, providerData] of orderedProviders) {
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
                const key = canonical(id);
                if (key && !modelsDevCatalog.has(key)) modelsDevCatalog.set(key, price);
              }
            }
          }
        } catch {}
      })(),

      // Source 2: litellm
      (async () => {
        try {
          const res = await this.fetchFn(LITELLM_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
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
              if (!litellmCatalog.has(key)) litellmCatalog.set(key, price);
            }
          }
        } catch {}
      })(),

      // Source 3: openrouter
      (async () => {
        try {
          const res = await this.fetchFn(OPENROUTER_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
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
              if (!openrouterCatalog.has(key)) openrouterCatalog.set(key, price);
            }
          }
        } catch {}
      })(),
    ]);

    // Merge in strict deterministic priority order: models.dev -> litellm -> openrouter
    for (const [k, v] of modelsDevCatalog) {
      newCatalog.set(k, v);
    }
    for (const [k, v] of litellmCatalog) {
      if (!newCatalog.has(k)) newCatalog.set(k, v);
    }
    for (const [k, v] of openrouterCatalog) {
      if (!newCatalog.has(k)) newCatalog.set(k, v);
    }

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
