import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelOption } from "../types/protocol";
import { fallbackLabel } from "../shared/model-name";
import { macKeychainSource, type CredentialSource } from "./quota/credentials";

const DEFAULT_ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";


/** `pi --help`: the levels `--thinking` takes. */
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const COMMAND_TIMEOUT_MS = 30_000;

export interface ModelCatalogOptions {
  home?: string;
  /** Environment for the agents' list commands (`PATH` finds them). */
  env?: Record<string, string | undefined>;
  keychain?: boolean | CredentialSource;
  anthropicModelsUrl?: string;
  cachePath?: string;
  now?: () => number;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `herdr-adapter.md` §7.1: every agent's model list, filled from the agent's own source. The sources
 * are other programs' files and output (a trust boundary): bad entries are skipped, and a source that
 * is missing, fails or times out keeps the agent's previous list.
 */
export class ModelCatalog {
  private home: string;
  private env: Record<string, string | undefined>;
  private keychain: CredentialSource | null;
  private anthropicModelsUrl: string;
  private cachePath?: string;
  private now: () => number;

  private lists = new Map<string, ModelOption[]>();
  private fetchedAt = new Map<string, number>();
  private filling: Promise<boolean> | null = null;
  /** Log model names that already caused a fill, so a model no source lists cannot loop. */
  private chased = new Set<string>();

  constructor(options: ModelCatalogOptions = {}) {
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
    const keychain = options.keychain ?? process.platform === "darwin";
    this.keychain = keychain === true ? macKeychainSource() : keychain === false ? null : keychain;
    this.anthropicModelsUrl = options.anthropicModelsUrl ?? DEFAULT_ANTHROPIC_MODELS_URL;
    this.cachePath = options.cachePath;
    this.now = options.now ?? (() => Date.now());

    this.loadCache();
  }

  private loadCache(): void {
    if (!this.cachePath || !existsSync(this.cachePath)) return;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.cachePath, "utf-8"));
    } catch (err) {
      console.warn(`[pigeon] failed to parse model cache '${this.cachePath}':`, err);
      return;
    }
    if (!isObj(data)) return;
    const cleanList = (arr: unknown[]): ModelOption[] =>
      arr
        .filter((m: unknown): m is ModelOption => isObj(m) && typeof m.id === "string")
        .map((m) => ({
          ...m,
          label: typeof m.label === "string" && m.label && m.label !== m.id ? m.label : fallbackLabel(m.id),
        }));
    if (isObj(data.models)) {
      const fetched = isObj(data.fetchedAt) ? data.fetchedAt : {};
      for (const [agent, list] of Object.entries(data.models)) {
        if (!Array.isArray(list)) continue;
        this.lists.set(agent, cleanList(list));
        if (typeof fetched[agent] === "number") this.fetchedAt.set(agent, fetched[agent]);
      }
      return;
    }
    for (const [agent, entry] of Object.entries(data)) {
      if (!isObj(entry) || !Array.isArray(entry.models)) continue;
      this.lists.set(agent, cleanList(entry.models));
      if (typeof entry.fetchedAt === "number") this.fetchedAt.set(agent, entry.fetchedAt);
    }
  }

  private saveCache(): void {
    if (!this.cachePath) return;
    mkdirSync(dirname(this.cachePath), { recursive: true });
    const data: Record<string, { models: ModelOption[]; fetchedAt?: number }> = {};
    for (const [agent, models] of this.lists) data[agent] = { models, fetchedAt: this.fetchedAt.get(agent) };
    const tmp = `${this.cachePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, this.cachePath);
  }

  public models(agent: string): ModelOption[] {
    return this.lists.get(agent) ?? [];
  }

  /**
   * herdr-adapter.md §5: the model and effort an agent that takes no model at launch will start
   * on. OpenCode keeps them in its own state file, which may be missing or in another shape.
   */
  public lastUsed(agent: string): { model: string; thinking?: string } | undefined {
    if (agent !== "opencode") return undefined;
    const path = join(this.home, ".local", "state", "opencode", "model.json");
    if (!existsSync(path)) return undefined;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return undefined;
    }
    const first = isObj(data) && Array.isArray(data.recent) ? data.recent[0] : undefined;
    if (!isObj(first) || typeof first.providerID !== "string" || typeof first.modelID !== "string") return undefined;
    const model = `${first.providerID}/${first.modelID}`;
    const thinking = isObj(data) && isObj(data.variant) ? data.variant[model] : undefined;
    return { model, ...(typeof thinking === "string" ? { thinking } : {}) };
  }

  /**
   * herdr-adapter.md §7.1: resolves a model value read from records to a catalog id by exact id,
   * else case-insensitive label match, else kept as read.
   */
  public resolve(agent: string, idOrLabel: string): string {
    if (!idOrLabel) return idOrLabel;
    const list = this.models(agent);
    const byId = list.find((m) => m.id === idOrLabel);
    if (byId) return byId.id;
    const lower = idOrLabel.toLowerCase();
    const byLabel = list.find((m) => m.label.toLowerCase() === lower);
    if (byLabel) return byLabel.id;
    const norm = (s: string) => s.toLowerCase().replace(/[-._]/g, "");
    const target = norm(idOrLabel);
    const byNorm = list.find((m) => norm(m.id) === target || norm(m.label) === target);
    if (byNorm) return byNorm.id;
    return idOrLabel;
  }

  /** An automatic fill of every list; resolves whether any list changed. Concurrent calls share one fill. */
  public refresh(): Promise<boolean> {
    this.filling ??= this.fill(null, false).finally(() => (this.filling = null));
    return this.filling;
  }

  /**
   * protocol.md §4.15: a fill asked from the phone, of one agent's list or all of them. It always
   * reads its sources, so it runs after a fill already under way instead of joining it.
   */
  public async refreshAsked(agent?: string): Promise<boolean> {
    if (this.filling) await this.filling;
    return this.fill(agent ? [agent] : null, true);
  }

  /**
   * §7.1: a bound session's records named `model`. When the agent's list lacks it, fill once for that
   * name; resolves whether a list changed.
   */
  public async noteModel(agent: string, model: string): Promise<boolean> {
    if (this.models(agent).some((m) => m.id === model)) return false;
    const key = `${agent}|${model}`;
    if (this.chased.has(key)) return false;
    this.chased.add(key);
    return this.refresh();
  }

  private async fill(agents: string[] | null, asked: boolean): Promise<boolean> {
    const sources: Array<[string, () => Promise<ModelOption[]>]> = [
      ["claude", () => this.claude(asked)],
      ["codex", async () => this.codex()],
      ["pi", async () => this.pi()],
      ["opencode", () => this.opencode()],
      ["agy", () => this.agy()],
    ];
    const results = await Promise.all(
      sources.filter(([agent]) => !agents || agents.includes(agent)).map(async ([agent, read]) => {
        try {
          return [agent, await read()] as const;
        } catch (err) {
          console.warn(`[pigeon] ${agent} model list unavailable: ${(err as Error).message}`);
          return [agent, null] as const;
        }
      })
    );
    const fetchedBefore = this.fetchedAt.get("claude");
    let changed = false;
    for (const [agent, list] of results) {
      if (!list || JSON.stringify(list) === JSON.stringify(this.lists.get(agent) ?? [])) continue;
      this.lists.set(agent, list);
      changed = true;
    }
    if (changed || this.fetchedAt.get("claude") !== fetchedBefore) this.saveCache();
    return changed;
  }

  private readJson(path: string): unknown {
    if (!existsSync(path)) throw new Error(`${path} does not exist`);
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  private getClaudeToken(): string | null {
    const file = fileCredentialSource(join(this.home, ".claude", ".credentials.json"));
    const fromFile = file.read();
    let raw = fromFile;
    if (raw === null && this.keychain) {
      raw = this.keychain.read();
    }
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw);
      const oauth = parsed?.claudeAiOauth;
      if (!oauth?.accessToken) return null;
      if (typeof oauth.expiresAt === "number" && this.now() >= oauth.expiresAt) return null;
      return oauth.accessToken;
    } catch {
      return null;
    }
  }

  private async claude(force = false): Promise<ModelOption[]> {
    const last = this.fetchedAt.get("claude") ?? 0;
    const ONE_DAY_MS = 24 * 3600 * 1000;
    if (!force && this.lists.has("claude") && this.now() - last < ONE_DAY_MS) {
      return this.lists.get("claude")!;
    }

    const token = this.getClaudeToken();
    if (!token) return this.lists.get("claude") ?? [];

    const url = new URL(this.anthropicModelsUrl);
    const out: ModelOption[] = [];
    const limit = 100;
    url.searchParams.set("limit", String(limit));

    while (true) {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) throw new Error(`Anthropic Models API returned ${res.status}`);
      const body = (await res.json()) as any;
      if (!isObj(body) || !Array.isArray(body.data)) break;

      for (const item of body.data) {
        if (!isObj(item) || typeof item.id !== "string") continue;
        const id = item.id;
        const label = typeof item.display_name === "string" && item.display_name ? item.display_name : id;
        let thinkingLevels: string[] | undefined = undefined;
        const effort = item.capabilities?.effort;
        if (isObj(effort) && effort.supported === true) {
          thinkingLevels = Object.keys(effort).filter((k) => k !== "supported" && isObj(effort[k]) && effort[k].supported === true);
        }
        out.push({
          id,
          label,
          ...(thinkingLevels !== undefined ? { thinkingLevels } : {}),
        });
      }

      if (body.has_more && body.last_id) {
        url.searchParams.set("after_id", body.last_id);
      } else {
        break;
      }
    }

    this.fetchedAt.set("claude", this.now());
    return out;
  }

  private codex(): ModelOption[] {
    const data = this.readJson(join(this.home, ".codex", "models_cache.json"));
    const models = isObj(data) && Array.isArray(data.models) ? data.models : [];
    return models
      .filter((m: unknown): m is Record<string, any> => isObj(m) && typeof m.slug === "string" && m.visibility !== "hide")
      .map((m) => ({
        id: m.slug,
        label: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
        thinkingLevels: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
          .map((l: unknown) => (isObj(l) ? l.effort : undefined))
          .filter((e: unknown): e is string => typeof e === "string"),
      }));
  }

  private pi(): ModelOption[] {
    const data = this.readJson(join(this.home, ".pi", "agent", "models-store.json"));
    if (!isObj(data)) return [];
    const out: ModelOption[] = [];
    for (const [provider, entry] of Object.entries(data)) {
      for (const m of isObj(entry) && Array.isArray(entry.models) ? entry.models : []) {
        if (!isObj(m) || typeof m.id !== "string") continue;
        const map = isObj(m.thinkingLevelMap) ? m.thinkingLevelMap : null;
        const levels = m.reasoning === true ? (map ? Object.keys(map).filter((k) => map[k] !== null) : PI_LEVELS) : [];
        out.push({ id: `${provider}/${m.id}`, label: typeof m.name === "string" && m.name ? m.name : m.id, ...(levels.length ? { thinkingLevels: levels } : {}) });
      }
    }
    return out;
  }

  /**
   * Ids from `opencode models`, one `<provider>/<model>` per line; label and effort levels from
   * OpenCode's models cache, which lists every provider, not only the ones OpenCode offers.
   */
  private async opencode(): Promise<ModelOption[]> {
    const lines = await this.run(["opencode", "models"]);
    const ids = lines.filter((l) => /^[^\s/]+\/\S+$/.test(l));
    const cachePath = join(this.home, ".cache", "opencode", "models.json");
    const cache = existsSync(cachePath) ? this.readJson(cachePath) : null;
    return ids.map((id) => {
      const slash = id.indexOf("/");
      const entry = isObj(cache) && isObj(cache[id.slice(0, slash)]?.models) ? cache[id.slice(0, slash)].models[id.slice(slash + 1)] : undefined;
      if (!isObj(entry)) return { id, label: fallbackLabel(id) };
      const label = typeof entry.name === "string" && entry.name ? entry.name : fallbackLabel(id);
      const effort = Array.isArray(entry.reasoning_options) ? entry.reasoning_options.find((o: unknown) => isObj(o) && o.type === "effort") : undefined;
      const levels = isObj(effort) && Array.isArray(effort.values) ? effort.values.filter((v: unknown): v is string => typeof v === "string") : undefined;
      return { id, label, ...(levels ? { thinkingLevels: levels } : {}) };
    });
  }

  private async agy(): Promise<ModelOption[]> {
    const lines = await this.run(["agy", "models"]);
    const out: ModelOption[] = [];
    for (const line of lines) {
      const match = line.match(/^(\S+)(?:\s+(.+))?$/);
      if (match) {
        const id = match[1];
        const label = match[2]?.trim() || id;
        out.push({ id, label });
      }
    }
    return out;
  }

  private async run(argv: string[]): Promise<string[]> {
    const proc = Bun.spawn(argv, { env: this.env, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS);
    try {
      const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0) throw new Error(`${argv.join(" ")} exited with ${code}`);
      return text.split("\n").map((l) => l.trim()).filter(Boolean);
    } finally {
      clearTimeout(timer);
    }
  }
}
