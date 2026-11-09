import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClientConfig, ServerConfig, PigeonConfig, QuotaProvidersConfig } from "../types/protocol";
import { DEFAULT_CLIENT_CONFIG } from "../shared/defaults";

export function detectQuotaProviders(home: string, env: NodeJS.ProcessEnv = process.env): QuotaProvidersConfig {
  let claude = existsSync(join(home, ".claude", ".credentials.json"));
  if (!claude && process.platform === "darwin") {
    try {
      const res = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials"]);
      if (res.exitCode === 0) claude = true;
    } catch {
      // ignore
    }
  }

  const codexHome = env.CODEX_HOME;
  const codex =
    (codexHome ? existsSync(join(codexHome, "auth.json")) : false) ||
    existsSync(join(home, ".config", "codex", "auth.json")) ||
    existsSync(join(home, ".codex", "auth.json"));

  const antigravity =
    existsSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")) ||
    existsSync(join(home, ".config", "Antigravity")) ||
    (process.platform === "darwin" && existsSync(join(home, "Library", "Application Support", "Antigravity")));

  return { claude, codex, antigravity };
}

/** Server settings that do not depend on the environment, written into a fresh config file. */
/** The production port; every other port runs an isolated instance (`architecture.md` §4.6). */
export const DEFAULT_PORT = 4100;

/**
 * `architecture.md` §4.6: a daemon on a port other than 4100 keeps its own admin socket, devices
 * and queue files, so a test daemon never touches the production one. `pigeon.sock` → `pigeon-4101.sock`.
 */
export function portScoped(path: string, port: number): string {
  if (port === DEFAULT_PORT) return path;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? `${path.slice(0, dot)}-${port}${path.slice(dot)}` : `${path}-${port}`;
}

const STATIC_SERVER_DEFAULTS = { port: DEFAULT_PORT, host: "", insecureDev: false, publicBaseUrl: "" };

/**
 * Environment-derived defaults. Resolved on every start and never written to disk, so a later
 * change of `XDG_RUNTIME_DIR`, `HERDR_APP_HOME` or `HC_TERMINAL_SOCKET` is picked up.
 */
function resolveRuntimeServerDefaults(
  env: NodeJS.ProcessEnv = process.env
): Pick<ServerConfig, "herdrAppSocketPath" | "herdrCoreSocketPath" | "adminSocketPath" | "stateDir"> {
  const home = env.HOME;
  if (!home) throw new Error("HOME is not set; Pigeon cannot locate its state and the Herdr sockets");
  const dataDir = env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "pigeon") : join(home, ".local", "share", "pigeon");
  return {
    herdrAppSocketPath: join(env.HERDR_APP_HOME || join(home, ".config", "herdr-app"), "herdr-app.sock"),
    // Empty when neither is set; the daemon then refuses to start (herdr-adapter.md §2).
    herdrCoreSocketPath: env.HC_TERMINAL_SOCKET || (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "herdr-core", "default.sock") : ""),
    adminSocketPath: env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "pigeon.sock") : join(dataDir, "admin.sock"),
    stateDir: dataDir,
  };
}

function resolveConfigPath(customPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (customPath) return customPath;
  if (env.PIGEON_CONFIG_PATH) return env.PIGEON_CONFIG_PATH;
  if (!env.HOME) throw new Error("HOME is not set; cannot resolve the Pigeon config path");
  const shareConfig = env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "pigeon", "config.json") : join(env.HOME, ".local", "share", "pigeon", "config.json");
  const configHome = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "pigeon", "config.json") : join(env.HOME, ".config", "pigeon", "config.json");
  if (!existsSync(shareConfig) && existsSync(configHome)) return configHome;
  return shareConfig;
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
  private stored: StoredConfig;
  private config: PigeonConfig;
  /** The home directory the agents' files are found under (the environment's `HOME`). */
  public readonly home: string;

  constructor(customPath?: string, env: NodeJS.ProcessEnv = process.env) {
    this.configPath = resolveConfigPath(customPath, env);
    this.home = env.HOME || "";
    this.stored = this.loadOrCreate();
    const detectedProviders = detectQuotaProviders(this.home, env);
    const clientDefaults: ClientConfig = {
      ...DEFAULT_CLIENT_CONFIG,
      quotaProviders: detectedProviders,
    };
    this.config = {
      server: { ...STATIC_SERVER_DEFAULTS, ...resolveRuntimeServerDefaults(env), ...(this.stored.server || {}) } as ServerConfig,
      client: deepMerge(clientDefaults, this.stored.client || {}),
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
    return parsed as StoredConfig;
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

