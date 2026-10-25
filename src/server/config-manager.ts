import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClientConfig, ServerConfig, PigeonConfig } from "../types/protocol";
import { DEFAULT_CLIENT_CONFIG } from "../shared/defaults";

export { DEFAULT_MACROS, DEFAULT_CLIENT_CONFIG } from "../shared/defaults";

/** Server settings that do not depend on the environment, written into a fresh config file. */
const STATIC_SERVER_DEFAULTS = { port: 4100, host: "", insecureDev: false, publicBaseUrl: "" };

/**
 * Environment-derived defaults. Resolved on every start and never written to disk, so a later
 * change of `XDG_RUNTIME_DIR` or `HERDR_SOCKET_PATH` is picked up.
 */
export function resolveRuntimeServerDefaults(env: NodeJS.ProcessEnv = process.env): Pick<ServerConfig, "herdrSocketPath" | "adminSocketPath" | "stateDir"> {
  const home = env.HOME;
  if (!home) throw new Error("HOME is not set; Pigeon cannot locate its state and the Herdr socket");
  const stateDir = env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "pigeon") : join(home, ".local", "state", "pigeon");
  return {
    herdrSocketPath: env.HERDR_SOCKET_PATH || join(home, ".config", "herdr", "herdr.sock"),
    adminSocketPath: env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "pigeon.sock") : join(stateDir, "admin.sock"),
    stateDir,
  };
}

export function resolveConfigPath(customPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (customPath) return customPath;
  if (env.PIGEON_CONFIG_PATH) return env.PIGEON_CONFIG_PATH;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "pigeon", "config.json");
  if (!env.HOME) throw new Error("HOME is not set; cannot resolve the Pigeon config path");
  return join(env.HOME, ".config", "pigeon", "config.json");
}

export function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (result as any)[key] === "object" &&
      !Array.isArray((result as any)[key])
    ) {
      (result as any)[key] = deepMerge((result as any)[key], value);
    } else {
      (result as any)[key] = value;
    }
  }
  return result;
}

interface StoredConfig {
  server?: Partial<ServerConfig>;
  client?: Partial<ClientConfig>;
}

/**
 * Owns `config.json`. The file holds only what the user (or the first-run template) set;
 * the effective config is defaults merged with it. A file that cannot be parsed stops startup
 * instead of being silently replaced, so hand edits are never lost.
 */
export class ConfigManager {
  private configPath: string;
  private env: NodeJS.ProcessEnv;
  private stored: StoredConfig;
  private config: PigeonConfig;

  constructor(customPath?: string, env: NodeJS.ProcessEnv = process.env) {
    this.configPath = resolveConfigPath(customPath, env);
    this.env = env;
    this.stored = this.loadOrCreate();
    this.config = {
      server: { ...STATIC_SERVER_DEFAULTS, ...resolveRuntimeServerDefaults(env), ...(this.stored.server || {}) } as ServerConfig,
      client: deepMerge({ ...DEFAULT_CLIENT_CONFIG }, this.stored.client || {}),
    };
  }

  private loadOrCreate(): StoredConfig {
    if (!existsSync(this.configPath)) {
      const initial: StoredConfig = { server: { ...STATIC_SERVER_DEFAULTS }, client: { ...DEFAULT_CLIENT_CONFIG } };
      this.write(initial);
      return initial;
    }
    const raw = readFileSync(this.configPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Pigeon config ${this.configPath} is not valid JSON: ${(err as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Pigeon config ${this.configPath} must contain a JSON object`);
    }
    const { stored, changed } = migrate(parsed as StoredConfig, this.env);
    if (changed) this.write(stored);
    return stored;
  }

  public getConfig(): PigeonConfig {
    return this.config;
  }

  public getClientConfig(): ClientConfig {
    return this.config.client;
  }

  public getServerConfig(): ServerConfig {
    return this.config.server;
  }

  public getConfigPath(): string {
    return this.configPath;
  }

  /** Merges a validated patch and writes it to disk before returning; write errors propagate. */
  public patchClientConfig(patch: Partial<ClientConfig>): ClientConfig {
    const nextStored: StoredConfig = { ...this.stored, client: deepMerge(this.stored.client || {}, patch) };
    this.write(nextStored);
    this.stored = nextStored;
    this.config.client = deepMerge(this.config.client, patch);
    return this.config.client;
  }

  private write(data: StoredConfig): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    const tmpPath = `${this.configPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, this.configPath);
  }
}

/**
 * Socket paths that builds before 0.1 computed and wrote into a fresh config. Such a value was
 * never chosen by the user, yet it would override the environment, so it is dropped on load.
 */
function oldAutoSocketPaths(env: NodeJS.ProcessEnv): { herdr: Set<string>; admin: Set<string> } {
  const home = env.HOME;
  const herdr = new Set(["/tmp/herdr.sock"]);
  const admin = new Set(["/tmp/pigeon.sock"]);
  if (env.HERDR_SOCKET_PATH) herdr.add(env.HERDR_SOCKET_PATH);
  if (env.XDG_RUNTIME_DIR) admin.add(join(env.XDG_RUNTIME_DIR, "pigeon.sock"));
  if (home) {
    herdr.add(join(home, ".config", "herdr", "herdr.sock"));
    admin.add(join(home, ".local", "state", "pigeon", "admin.sock"));
  }
  return { herdr, admin };
}

/** Upgrades values written by older builds; `changed` says whether the file needs rewriting. */
function migrate(stored: StoredConfig, env: NodeJS.ProcessEnv): { stored: StoredConfig; changed: boolean } {
  let changed = false;
  const server = stored.server;
  if (server) {
    const old = oldAutoSocketPaths(env);
    if (server.herdrSocketPath !== undefined && old.herdr.has(server.herdrSocketPath)) {
      delete server.herdrSocketPath;
      changed = true;
    }
    if (server.adminSocketPath !== undefined && old.admin.has(server.adminSocketPath)) {
      delete server.adminSocketPath;
      changed = true;
    }
  }
  const macros = stored.client?.macros;
  if (Array.isArray(macros)) {
    // The old default "模型" macro sent a key named "model", which Herdr rejects.
    stored.client!.macros = macros.map((m) => {
      if (m.id !== "m_model" || m.type !== "key" || m.payload !== "model") return m;
      changed = true;
      return { ...m, type: "text" as const, payload: "/model" };
    });
  }
  return { stored, changed };
}
