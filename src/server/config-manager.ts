import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClientConfig, ServerConfig, PigeonConfig } from "../types/protocol";
import { DEFAULT_CLIENT_CONFIG, REMOVED_CLIENT_KEYS } from "../shared/defaults";

/** Server settings that do not depend on the environment, written into a fresh config file. */
const STATIC_SERVER_DEFAULTS = { port: 4100, host: "", insecureDev: false, publicBaseUrl: "" };

/**
 * Environment-derived defaults. Resolved on every start and never written to disk, so a later
 * change of `XDG_RUNTIME_DIR`, `HERDR_APP_HOME` or `HC_TERMINAL_SOCKET` is picked up.
 */
function resolveRuntimeServerDefaults(
  env: NodeJS.ProcessEnv = process.env
): Pick<ServerConfig, "herdrAppSocketPath" | "herdrCoreSocketPath" | "adminSocketPath" | "stateDir"> {
  const home = env.HOME;
  if (!home) throw new Error("HOME is not set; Pigeon cannot locate its state and the Herdr sockets");
  const stateDir = env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "pigeon") : join(home, ".local", "state", "pigeon");
  return {
    herdrAppSocketPath: join(env.HERDR_APP_HOME || join(home, ".config", "herdr-app"), "herdr-app.sock"),
    // Empty when neither is set; the daemon then refuses to start (herdr-adapter.md §2).
    herdrCoreSocketPath: env.HC_TERMINAL_SOCKET || (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "herdr-core", "default.sock") : ""),
    adminSocketPath: env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "pigeon.sock") : join(stateDir, "admin.sock"),
    stateDir,
  };
}

function resolveConfigPath(customPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (customPath) return customPath;
  if (env.PIGEON_CONFIG_PATH) return env.PIGEON_CONFIG_PATH;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "pigeon", "config.json");
  if (!env.HOME) throw new Error("HOME is not set; cannot resolve the Pigeon config path");
  return join(env.HOME, ".config", "pigeon", "config.json");
}

function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
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

  public getClientConfig(): ClientConfig {
    return this.config.client;
  }

  public getServerConfig(): ServerConfig {
    return this.config.server;
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
 * Admin socket paths that builds before 0.1 computed and wrote into a fresh config. Such a value
 * was never chosen by the user, yet it would override the environment, so it is dropped on load.
 */
function oldAutoAdminSocketPaths(env: NodeJS.ProcessEnv): Set<string> {
  const admin = new Set(["/tmp/pigeon.sock"]);
  if (env.XDG_RUNTIME_DIR) admin.add(join(env.XDG_RUNTIME_DIR, "pigeon.sock"));
  if (env.HOME) admin.add(join(env.HOME, ".local", "state", "pigeon", "admin.sock"));
  return admin;
}

/** Upgrades values written by older builds; `changed` says whether the file needs rewriting. */
function migrate(stored: StoredConfig, env: NodeJS.ProcessEnv): { stored: StoredConfig; changed: boolean } {
  let changed = false;
  const server = stored.server as (Partial<ServerConfig> & { herdrSocketPath?: string }) | undefined;
  if (server) {
    // The old terminal Herdr's socket; Herdr App and Herdr Core replaced it (herdr-adapter.md §1).
    if (server.herdrSocketPath !== undefined) {
      delete server.herdrSocketPath;
      changed = true;
    }
    if (server.adminSocketPath !== undefined && oldAutoAdminSocketPaths(env).has(server.adminSocketPath)) {
      delete server.adminSocketPath;
      changed = true;
    }
  }
  const client = stored.client as Record<string, unknown> | undefined;
  if (client) {
    // Theme packs, macros and display options of the v1 UI (architecture.md §4.7).
    for (const key of REMOVED_CLIENT_KEYS) {
      if (key in client) {
        delete client[key];
        changed = true;
      }
    }
  }
  return { stored, changed };
}
