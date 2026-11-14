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

export const DEFAULT_PORT = 4100;
export const DEFAULT_TAILSCALE_HTTPS_PORT = 8443;
export const DEFAULT_TEST_TAILSCALE_HTTPS_PORT = 18443;

export interface InstancePaths {
  stateDir: string;
  configPath: string;
  adminSocketPath: string;
  devicesPath: string;
  queuePath: string;
  vapidPath: string;
  pushSubscriptionsPath: string;
  uploadsDir: string;
  logPath: string;
  usageDbPath: string;
  pricingCachePath: string;
}

export function resolveProductionPort(env: NodeJS.ProcessEnv = process.env): number {
  try {
    const prodConfigPath = resolveConfigPath(undefined, env);
    if (existsSync(prodConfigPath)) {
      const raw = JSON.parse(readFileSync(prodConfigPath, "utf-8"));
      if (raw && typeof raw === "object" && raw.server && typeof raw.server.port === "number") {
        return raw.server.port;
      }
    }
  } catch {}
  return DEFAULT_PORT;
}

export function resolveInstancePaths(options: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  port?: number;
  productionPort?: number;
} = {}): InstancePaths {
  const env = options.env ?? process.env;
  const home = env.HOME || "";
  const dataHome = env.XDG_DATA_HOME ? env.XDG_DATA_HOME : join(home, ".local", "share");
  const runDir = env.XDG_RUNTIME_DIR ? env.XDG_RUNTIME_DIR : join(dataHome, "pigeon");

  const prodPort = options.productionPort ?? resolveProductionPort(env as NodeJS.ProcessEnv);
  const port = options.port ?? prodPort;
  const isProd = port === prodPort;

  const instanceName = isProd ? "pigeon" : `pigeon-${port}`;
  const stateDir = join(dataHome, instanceName);
  const adminSocketPath = join(runDir, isProd ? "pigeon.sock" : `pigeon-${port}.sock`);

  return {
    stateDir,
    configPath: join(stateDir, "config.json"),
    adminSocketPath,
    devicesPath: join(stateDir, "devices.json"),
    queuePath: join(stateDir, "queue.json"),
    vapidPath: join(stateDir, "vapid.json"),
    pushSubscriptionsPath: join(stateDir, "push-subscriptions.json"),
    uploadsDir: join(stateDir, "uploads"),
    logPath: join(stateDir, "pigeon.log"),
    usageDbPath: join(dataHome, "pigeon", "usage.db"),
    pricingCachePath: join(dataHome, "pigeon", "pricing-cache.json"),
  };
}

const STATIC_SERVER_DEFAULTS = {
  port: DEFAULT_PORT,
  tailscaleHttpsPort: DEFAULT_TAILSCALE_HTTPS_PORT,
  host: "",
  insecureDev: false,
  publicBaseUrl: "",
};

/**
 * Environment-derived defaults. Resolved on every start and never written to disk, so a later
 * change of `XDG_RUNTIME_DIR`, `HERDR_APP_HOME` or `HC_TERMINAL_SOCKET` is picked up.
 */
function resolveRuntimeServerDefaults(
  env: NodeJS.ProcessEnv = process.env
): Pick<ServerConfig, "herdrAppSocketPath" | "herdrCoreSocketPath" | "adminSocketPath" | "stateDir"> {
  const home = env.HOME;
  if (!home) throw new Error("HOME is not set; Pigeon cannot locate its state and the Herdr sockets");
  const { stateDir } = resolveInstancePaths({ env, port: DEFAULT_PORT, productionPort: DEFAULT_PORT });
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
  public readonly env: NodeJS.ProcessEnv;
  public readonly port: number;
  public readonly productionPort: number;

  constructor(customPathOrOptions?: string | { port?: number; path?: string; productionPort?: number }, env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    let customPath: string | undefined;
    let explicitPort: number | undefined;
    let productionPort: number | undefined;
    if (typeof customPathOrOptions === "string") {
      customPath = customPathOrOptions;
    } else if (customPathOrOptions) {
      customPath = customPathOrOptions.path;
      explicitPort = customPathOrOptions.port;
      productionPort = customPathOrOptions.productionPort;
    }
    const prodPort = productionPort ?? resolveProductionPort(env);
    this.productionPort = prodPort;
    if (!customPath && explicitPort) {
      customPath = resolveInstancePaths({ port: explicitPort, productionPort: prodPort, env }).configPath;
    }
    this.port = explicitPort ?? prodPort;
    this.configPath = resolveConfigPath(customPath, env);
    this.home = env.HOME || "";
    this.stored = this.loadOrCreate();
    const detectedProviders = detectQuotaProviders(this.home, env);
    const clientDefaults: ClientConfig = {
      ...DEFAULT_CLIENT_CONFIG,
      quotaProviders: detectedProviders,
    };
    const isTest = this.port !== prodPort;
    const defaultTailscalePort = isTest ? DEFAULT_TEST_TAILSCALE_HTTPS_PORT : DEFAULT_TAILSCALE_HTTPS_PORT;
    this.config = {
      server: {
        ...STATIC_SERVER_DEFAULTS,
        tailscaleHttpsPort: defaultTailscalePort,
        ...(explicitPort ? { port: explicitPort } : {}),
        ...resolveRuntimeServerDefaults(env),
        ...(this.stored.server || {}),
      } as ServerConfig,
      client: deepMerge(clientDefaults, this.stored.client || {}),
    };
  }

  private loadOrCreate(): StoredConfig {
    if (!existsSync(this.configPath)) {
      const isTest = this.port !== this.productionPort;
      const initial: StoredConfig = {
        server: {
          ...STATIC_SERVER_DEFAULTS,
          port: this.port,
          tailscaleHttpsPort: isTest ? DEFAULT_TEST_TAILSCALE_HTTPS_PORT : DEFAULT_TAILSCALE_HTTPS_PORT,
        },
        client: { ...DEFAULT_CLIENT_CONFIG },
      };
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

