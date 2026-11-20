// Issue #13, #39. quota-and-usage.md §3.3. Pricing manager.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, formatModelId } from "./model-id";

export type PriceTier =
  | "official-global"
  | "official-regional"
  | "fallback-openrouter"
  | "fallback-vercel"
  | "fallback-cloudflare";

export interface ModelPrice {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken?: number;
  cacheWriteCostPerToken?: number;
  releaseDate?: string;
  tier: PriceTier;
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
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 3;

interface Owner {
  global: string[];
  regional: string[];
  litellm: string[];
}

const OWNERS: Record<string, Owner> = {
  anthropic: { global: ["anthropic"], regional: [], litellm: ["anthropic"] },
  openai: { global: ["openai"], regional: [], litellm: ["openai"] },
  google: { global: ["google", "google-vertex"], regional: [], litellm: ["gemini", "vertex_ai", "vertex_ai-language-models"] },
  deepseek: { global: ["deepseek"], regional: [], litellm: [] },
  zai: { global: ["zai"], regional: ["zhipuai"], litellm: ["zai"] },
  minimax: { global: ["minimax"], regional: ["minimax-cn"], litellm: ["minimax"] },
  moonshotai: { global: ["moonshotai"], regional: ["moonshotai-cn"], litellm: ["moonshot"] },
  meta: { global: ["meta"], regional: [], litellm: [] },
  nvidia: { global: ["nvidia"], regional: [], litellm: [] },
  thinkingmachines: { global: ["thinkingmachines"], regional: [], litellm: [] },
};

const LITELLM_OFFICIAL_PROVIDERS = new Set(["anthropic", "openai", "gemini", "vertex_ai", "vertex_ai-language-models", "zai", "moonshot", "minimax"]);

const FALLBACK_PROVIDERS: Array<[string, PriceTier]> = [
  ["openrouter", "fallback-openrouter"],
  ["vercel", "fallback-vercel"],
  ["cloudflare-workers-ai", "fallback-cloudflare"],
  ["cloudflare-ai-gateway", "fallback-cloudflare"],
];

/** Selection never reads any other provider, so their entries are not parsed or collision-checked. */
const SELECTABLE_MODELSDEV_PROVIDERS = new Set([
  ...Object.values(OWNERS).flatMap((owner) => [...owner.global, ...owner.regional]),
  ...FALLBACK_PROVIDERS.map(([provider]) => provider),
]);

/** quota-and-usage.md §3.3 Selection: the model owner decides which providers may be official. */
function ownerFor(key: string): Owner | null {
  if (key.startsWith("claude-")) return OWNERS.anthropic;
  if (key.startsWith("gpt-") || key.startsWith("codex-") || key.startsWith("chatgpt-")) return OWNERS.openai;
  if (key.startsWith("gemini-")) return OWNERS.google;
  if (key.startsWith("deepseek-")) return OWNERS.deepseek;
  if (key.startsWith("glm-")) return OWNERS.zai;
  if (key.startsWith("minimax-")) return OWNERS.minimax;
  if (key.startsWith("kimi-") || key.startsWith("moonshot-")) return OWNERS.moonshotai;
  if (key.startsWith("muse-")) return OWNERS.meta;
  if (key.startsWith("nemotron-")) return OWNERS.nvidia;
  if (key.startsWith("inkling-")) return OWNERS.thinkingmachines;
  return null;
}

interface CatalogEntry {
  id: string;
  key: string;
  price: ModelPrice;
}

type RawProviderCatalog = Map<string, Map<string, CatalogEntry[]>>;
type ProviderCatalog = Map<string, Map<string, CatalogEntry>>;

function rawModelId(id: string): string {
  return formatModelId(id.slice(id.lastIndexOf("/") + 1));
}

function sameRates(a: ModelPrice, b: ModelPrice): boolean {
  return (
    a.inputCostPerToken === b.inputCostPerToken &&
    a.outputCostPerToken === b.outputCostPerToken &&
    (a.cacheReadCostPerToken ?? null) === (b.cacheReadCostPerToken ?? null) &&
    (a.cacheWriteCostPerToken ?? null) === (b.cacheWriteCostPerToken ?? null)
  );
}

/**
 * quota-and-usage.md §3.3 Identity: the exact raw ID wins a same-source collision; otherwise
 * entries that disagree on price make that provider unusable for the model.
 */
function resolveCollision(provider: string, key: string, entries: CatalogEntry[]): CatalogEntry | null {
  if (entries.length === 1) return entries[0];
  const exact = entries.filter((e) => rawModelId(e.id) === key);
  if (exact.length === 1) return exact[0];
  const first = entries[0];
  if (entries.every((e) => sameRates(e.price, first.price))) return first;
  console.warn(`[Pigeon] pricing collision for ${key} in ${provider}: ${entries.map((e) => e.id).join(", ")}`);
  return null;
}

function indexProviderEntries(provider: string, rawEntries: CatalogEntry[], into: RawProviderCatalog): void {
  let byKey = into.get(provider);
  if (!byKey) {
    byKey = new Map();
    into.set(provider, byKey);
  }
  for (const entry of rawEntries) {
    const list = byKey.get(entry.key);
    if (list) list.push(entry);
    else byKey.set(entry.key, [entry]);
  }
}

function finalizeCatalog(raw: RawProviderCatalog): ProviderCatalog {
  const catalog: ProviderCatalog = new Map();
  for (const [provider, byKey] of raw) {
    const resolvedByKey = new Map<string, CatalogEntry>();
    for (const [key, entries] of byKey) {
      const resolved = resolveCollision(provider, key, entries);
      if (resolved) resolvedByKey.set(key, resolved);
    }
    catalog.set(provider, resolvedByKey);
  }
  return catalog;
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
  private loggedOwners = new Set<string>();

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
    return Array.from(this.catalog.entries()).sort(([a], [b]) => a.localeCompare(b));
  }

  public getCatalogVersion(): number {
    return this.catalogVersion;
  }

  private catalogSignature(): string {
    return JSON.stringify(this.getCatalogEntries());
  }

  public async initialize(): Promise<void> {
    const now = this.now();
    if (this.loaded && now - this.lastFetchAt <= DAY_MS) return;
    if (now < this.nextRetryAt) return;
    const before = this.catalogSignature();
    await this.load(now);
    if (this.catalogSignature() !== before) this.catalogVersion++;
  }

  private async load(now: number): Promise<void> {
    const cacheResult = this.loadFromCache(this.cachePath);
    if (cacheResult.fresh && cacheResult.hasEntries) {
      this.loaded = true;
      this.pricesAvailable = true;
      this.lastFetchAt = cacheResult.fetchedAt;
      return;
    }

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
      this.pricesAvailable = this.catalog.size > 0;
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
      const fresh = data.schemaVersion === CACHE_SCHEMA_VERSION && this.now() - fetchedAt <= DAY_MS;
      if (data.entries) {
        for (const [k, v] of Object.entries(data.entries)) {
          this.catalog.set(k, v as ModelPrice);
        }
        return { fresh, hasEntries: this.catalog.size > 0, fetchedAt };
      }
    } catch {
      return { fresh: false, hasEntries: false, fetchedAt: 0 };
    }
    return { fresh: false, hasEntries: false, fetchedAt: 0 };
  }

  private indexModelsDev(providers: any): ProviderCatalog {
    const catalog: RawProviderCatalog = new Map();
    for (const [provider, providerData] of Object.entries<any>(providers || {})) {
      if (!SELECTABLE_MODELSDEV_PROVIDERS.has(provider)) continue;
      const models = providerData?.models || {};
      const entries: CatalogEntry[] = [];
      for (const [fallbackId, model] of Object.entries<any>(models)) {
        const cost = model?.cost;
        if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") continue;
        if (cost.input === 0 && cost.output === 0) continue;
        const id = typeof model.id === "string" && model.id ? model.id : fallbackId;
        const key = canonical(id);
        if (!key) continue;
        const owner = ownerFor(key);
        const official = owner !== null && (owner.global.includes(provider) || owner.regional.includes(provider));
        const rawRelease = official ? model.release_date : undefined;
        const releaseDate = typeof rawRelease === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawRelease) ? rawRelease : undefined;
        entries.push({
          id,
          key,
          price: {
            inputCostPerToken: cost.input / 1_000_000,
            outputCostPerToken: cost.output / 1_000_000,
            cacheReadCostPerToken: typeof cost.cache_read === "number" ? cost.cache_read / 1_000_000 : undefined,
            cacheWriteCostPerToken: typeof cost.cache_write === "number" ? cost.cache_write / 1_000_000 : undefined,
            ...(releaseDate ? { releaseDate } : {}),
            tier: "official-global",
            source: provider,
          },
        });
      }
      indexProviderEntries(provider, entries, catalog);
    }
    return finalizeCatalog(catalog);
  }

  private indexLitellm(entries: any): ProviderCatalog {
    const catalog: RawProviderCatalog = new Map();
    for (const [id, model] of Object.entries<any>(entries || {})) {
      const provider = model?.litellm_provider;
      if (!LITELLM_OFFICIAL_PROVIDERS.has(provider)) continue;
      if (typeof model.input_cost_per_token !== "number") continue;
      const output = typeof model.output_cost_per_token === "number" ? model.output_cost_per_token : 0;
      if (model.input_cost_per_token === 0 && output === 0) continue;
      const key = canonical(id);
      if (!key) continue;
      indexProviderEntries(
        provider,
        [
          {
            id,
            key,
            price: {
              inputCostPerToken: model.input_cost_per_token,
              outputCostPerToken: output,
              cacheReadCostPerToken: typeof model.cache_read_input_token_cost === "number" ? model.cache_read_input_token_cost : undefined,
              cacheWriteCostPerToken: typeof model.cache_creation_input_token_cost === "number" ? model.cache_creation_input_token_cost : undefined,
              tier: "official-global",
              source: provider,
            },
          },
        ],
        catalog
      );
    }
    return finalizeCatalog(catalog);
  }

  private selectPrice(key: string, modelsDev: ProviderCatalog, litellm: ProviderCatalog): ModelPrice | null {
    const owner = ownerFor(key);
    if (owner) {
      for (const provider of owner.global) {
        const entry = modelsDev.get(provider)?.get(key);
        if (entry) return { ...entry.price, tier: "official-global", source: provider };
      }
      for (const provider of owner.regional) {
        const entry = modelsDev.get(provider)?.get(key);
        if (entry) return { ...entry.price, tier: "official-regional", source: provider };
      }
      for (const provider of owner.litellm) {
        const entry = litellm.get(provider)?.get(key);
        if (entry) return { ...entry.price, tier: "official-global", source: provider };
      }
    }
    for (const [provider, tier] of FALLBACK_PROVIDERS) {
      const entry = modelsDev.get(provider)?.get(key);
      if (entry) return { ...entry.price, tier, source: provider };
    }
    return null;
  }

  private selectCatalog(modelsDev: ProviderCatalog, litellm: ProviderCatalog): Map<string, ModelPrice> {
    const keys = new Set<string>();
    for (const byKey of modelsDev.values()) for (const key of byKey.keys()) keys.add(key);
    for (const byKey of litellm.values()) for (const key of byKey.keys()) keys.add(key);

    const selected = new Map<string, ModelPrice>();
    for (const key of keys) {
      const price = this.selectPrice(key, modelsDev, litellm);
      if (price) selected.set(key, price);
    }
    return selected;
  }

  private async refreshFromNetwork(): Promise<boolean> {
    const TIMEOUT_MS = 30_000;
    const [modelsDevResult, litellmResult] = await Promise.allSettled([
      this.fetchFn(MODELSDEV_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
      this.fetchFn(LITELLM_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
    ]);

    // quota-and-usage.md §3.3 Sources: a failed models.dev fetch changes nothing.
    if (modelsDevResult.status !== "fulfilled" || !modelsDevResult.value.ok) return false;
    let modelsDevData: any;
    try {
      modelsDevData = await modelsDevResult.value.json();
    } catch {
      return false;
    }

    const modelsDev = this.indexModelsDev(modelsDevData);
    let litellm: ProviderCatalog = new Map();
    if (litellmResult.status === "fulfilled" && litellmResult.value.ok) {
      try {
        litellm = this.indexLitellm(await litellmResult.value.json());
      } catch {
        litellm = new Map();
      }
    }

    const selected = this.selectCatalog(modelsDev, litellm);
    if (selected.size === 0) return false;
    this.catalog = selected;

    mkdirSync(dirname(this.cachePath), { recursive: true });
    const cache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      fetchedAt: this.now(),
      entries: Object.fromEntries(this.catalog.entries()),
    };
    writeFileSync(this.cachePath, JSON.stringify(cache), "utf-8");
    return true;
  }

  public getPrice(modelId: string): ModelPrice | null {
    const key = canonical(modelId);
    const price = this.catalog.get(key);
    if (!price) return null;
    if (!ownerFor(key) && !this.loggedOwners.has(key)) {
      this.loggedOwners.add(key);
      console.warn(`[Pigeon] pricing has no owner for ${key}; official stages skipped`);
    }
    return price;
  }
}
