import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ClientConfig,
  ServerConfig,
  PigeonConfig,
  MacroItem,
} from "../types/protocol";

export const DEFAULT_MACROS: MacroItem[] = [
  { id: "m_model", name: "模型", type: "key", payload: "model" },
  { id: "m_continue", name: "继续", type: "text", payload: "continue" },
  { id: "m_ctrlc", name: "终止", type: "key", payload: "ctrl+c" },
  { id: "m_enter", name: "Enter", type: "key", payload: "enter" },
  { id: "m_tab", name: "Tab", type: "key", payload: "tab" },
];

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  themeKey: "gruvbox",
  themeMode: "system",
  themeId: "gruvbox",
  confirmCtrlC: true,
  defaultView: "cards",
  macros: DEFAULT_MACROS,
  displayDensity: "compact",
  showScrollControls: true,
  showMacroDock: true,
};

export function getDefaultServerConfig(): ServerConfig {
  return {
    port: 4100,
    host: "",
    insecureDev: false,
    publicBaseUrl: "",
    herdrSocketPath:
      process.env.HERDR_SOCKET_PATH ||
      (process.env.HOME ? join(process.env.HOME, ".config", "herdr", "herdr.sock") : "/tmp/herdr.sock"),
    adminSocketPath:
      process.env.XDG_RUNTIME_DIR
        ? join(process.env.XDG_RUNTIME_DIR, "pigeon.sock")
        : (process.env.HOME ? join(process.env.HOME, ".local", "state", "pigeon", "admin.sock") : "/tmp/pigeon.sock"),
  };
}

export function getDefaultConfig(): PigeonConfig {
  return {
    server: getDefaultServerConfig(),
    client: { ...DEFAULT_CLIENT_CONFIG },
  };
}

export function resolveConfigPath(customPath?: string): string {
  if (customPath) return customPath;
  if (process.env.PIGEON_CONFIG_PATH) return process.env.PIGEON_CONFIG_PATH;
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "pigeon", "config.json");
  }
  if (process.env.HOME) {
    return join(process.env.HOME, ".config", "pigeon", "config.json");
  }
  return "/tmp/pigeon_config.json";
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

export class ConfigManager {
  private configPath: string;
  private config: PigeonConfig;
  private saveTimer: any = null;
  private debounceMs: number;

  constructor(customPath?: string, debounceMs = 200) {
    this.configPath = resolveConfigPath(customPath);
    this.debounceMs = debounceMs;
    this.config = this.loadOrCreate();
  }

  private loadOrCreate(): PigeonConfig {
    const defaults = getDefaultConfig();
    try {
      if (!existsSync(this.configPath)) {
        const dir = dirname(this.configPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(this.configPath, JSON.stringify(defaults, null, 2) + "\n", "utf-8");
        return defaults;
      }

      const raw = readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        server: deepMerge(defaults.server, parsed.server || {}),
        client: deepMerge(defaults.client, parsed.client || {}),
      };
    } catch {
      return defaults;
    }
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

  public patchClientConfig(patch: Partial<ClientConfig>): ClientConfig {
    if (!patch || typeof patch !== "object") {
      return this.config.client;
    }
    this.config.client = deepMerge(this.config.client, patch);
    this.scheduleSave();
    return this.config.client;
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.flush();
    }, this.debounceMs);
  }

  public flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const dir = dirname(this.configPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.configPath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      writeFileSync(tmpPath, JSON.stringify(this.config, null, 2) + "\n", "utf-8");
      renameSync(tmpPath, this.configPath);
    } catch (err) {
      console.error("Failed to write Pigeon config:", err);
    }
  }

  public destroy(): void {
    if (this.saveTimer) {
      this.flush();
    }
  }
}
