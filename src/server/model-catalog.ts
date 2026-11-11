import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelOption } from "../types/protocol";

const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"];
/** `pi --help`: the levels `--thinking` takes. */
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const COMMAND_TIMEOUT_MS = 30_000;

/** The CLI's own aliases; the CLI resolves them to its current models, so no version is named here. */
const CLAUDE_MODELS: ModelOption[] = [
  { id: "opus", label: "Opus", thinkingLevels: EFFORT_LADDER },
  { id: "sonnet", label: "Sonnet", thinkingLevels: EFFORT_LADDER },
  { id: "haiku", label: "Haiku" },
];

export interface ModelCatalogOptions {
  home?: string;
  /** Environment for the agents' list commands (`PATH` finds them). */
  env?: Record<string, string | undefined>;
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
  private lists = new Map<string, ModelOption[]>([["claude", CLAUDE_MODELS]]);
  private filling: Promise<boolean> | null = null;
  /** Log model names that already caused a fill, so a model no source lists cannot loop. */
  private chased = new Set<string>();

  constructor(options: ModelCatalogOptions = {}) {
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
  }

  public models(agent: string): ModelOption[] {
    return this.lists.get(agent) ?? [];
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

  /** Fills every list again; resolves whether any list changed. Concurrent calls share one fill. */
  public refresh(): Promise<boolean> {
    this.filling ??= this.fill().finally(() => (this.filling = null));
    return this.filling;
  }

  /**
   * §7.1: a bound session's records named `model`. When the agent's list lacks it, fill once for that
   * name; resolves whether a list changed.
   */
  public async noteModel(agent: string, model: string): Promise<boolean> {
    if (agent === "claude" || this.models(agent).some((m) => m.id === model)) return false;
    const key = `${agent}|${model}`;
    if (this.chased.has(key)) return false;
    this.chased.add(key);
    return this.refresh();
  }

  private async fill(): Promise<boolean> {
    const sources: Array<[string, () => Promise<ModelOption[]>]> = [
      ["codex", async () => this.codex()],
      ["pi", async () => this.pi()],
      ["opencode", () => this.opencode()],
      ["agy", () => this.agy()],
    ];
    const results = await Promise.all(
      sources.map(async ([agent, read]) => {
        try {
          return [agent, await read()] as const;
        } catch (err) {
          console.warn(`[pigeon] ${agent} model list unavailable: ${(err as Error).message}`);
          return [agent, null] as const;
        }
      })
    );
    let changed = false;
    for (const [agent, list] of results) {
      if (!list || JSON.stringify(list) === JSON.stringify(this.lists.get(agent) ?? [])) continue;
      this.lists.set(agent, list);
      changed = true;
    }
    return changed;
  }

  private readJson(path: string): unknown {
    if (!existsSync(path)) throw new Error(`${path} does not exist`);
    return JSON.parse(readFileSync(path, "utf-8"));
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

  /** `opencode models`: one `<provider>/<model>` per line. */
  private async opencode(): Promise<ModelOption[]> {
    const lines = await this.run(["opencode", "models"]);
    return lines.filter((l) => /^[^\s/]+\/\S+$/.test(l)).map((id) => ({ id, label: id }));
  }

  /** `agy models`: one `<id>\t<label>` or `<id>   <label>` per line; the label names the effort, e.g. `Gemini 3.8 Flash (High)`. */
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
