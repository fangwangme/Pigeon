// Issue #13. quota-and-usage.md §2.6, protocol.md §4.15.
import type { ConfigManager } from "../config-manager";
import type { ClientConfig, QuotaProviderState, QuotaSnapshot } from "../../types/protocol";
import { ClaudeQuotaProvider } from "./claude";
import { CodexQuotaProvider } from "./codex";
import { AntigravityQuotaProvider } from "./antigravity";

export interface QuotaServiceOptions {
  claude?: ClaudeQuotaProvider;
  codex?: CodexQuotaProvider;
  antigravity?: AntigravityQuotaProvider;
  configManager?: ConfigManager;
  now?: () => number;
}

interface ProviderRecord {
  snapshot: QuotaSnapshot | null;
  error: { message: string; at: number } | null;
  fetchedAt: number;
}

export class QuotaService {
  private claude: ClaudeQuotaProvider;
  private codex: CodexQuotaProvider;
  private antigravity: AntigravityQuotaProvider;
  private configManager?: ConfigManager;
  private now: () => number;

  private cache: Record<"claude" | "codex" | "antigravity", ProviderRecord> = {
    claude: { snapshot: null, error: null, fetchedAt: 0 },
    codex: { snapshot: null, error: null, fetchedAt: 0 },
    antigravity: { snapshot: null, error: null, fetchedAt: 0 },
  };

  private inFlight: Partial<Record<"claude" | "codex" | "antigravity", Promise<QuotaSnapshot>>> = {};

  constructor(options: QuotaServiceOptions = {}) {
    this.claude = options.claude ?? new ClaudeQuotaProvider();
    this.codex = options.codex ?? new CodexQuotaProvider();
    this.antigravity = options.antigravity ?? new AntigravityQuotaProvider();
    this.configManager = options.configManager;
    this.now = options.now ?? (() => Date.now());
  }

  public async getQuota(clientConfig?: ClientConfig): Promise<{ providers: QuotaProviderState[] }> {
    const config = clientConfig ?? this.configManager?.getClientConfig();
    const providersConfig = config?.quotaProviders ?? { claude: true, codex: true, antigravity: true };
    const now = this.now();

    const providerKeys: Array<"claude" | "codex" | "antigravity"> = ["claude", "codex", "antigravity"];

    const tasks = providerKeys.map(async (key): Promise<QuotaProviderState> => {
      const isEnabled = providersConfig[key] ?? false;
      if (!isEnabled) {
        return {
          provider: key,
          enabled: false,
          snapshot: null,
          error: null,
        };
      }

      const cached = this.cache[key];
      const isFresh = cached.snapshot && now - cached.fetchedAt < 60_000;
      if (isFresh) {
        return {
          provider: key,
          enabled: true,
          snapshot: cached.snapshot,
          error: cached.error,
        };
      }
      if (cached.error && now - cached.error.at < 60_000 && !cached.snapshot) {
        return {
          provider: key,
          enabled: true,
          snapshot: null,
          error: cached.error,
        };
      }

      try {
        if (!this.inFlight[key]) {
          this.inFlight[key] = this.fetchProvider(key).finally(() => {
            delete this.inFlight[key];
          });
        }
        const snap = await this.inFlight[key]!;
        this.cache[key] = {
          snapshot: snap,
          error: null,
          fetchedAt: this.now(),
        };
        return {
          provider: key,
          enabled: true,
          snapshot: snap,
          error: null,
        };
      } catch (err) {
        const error = {
          message: `${key}: ${(err as Error).message}`,
          at: this.now(),
        };
        this.cache[key].error = error;
        return {
          provider: key,
          enabled: true,
          snapshot: this.cache[key].snapshot,
          error,
        };
      }
    });

    const results = await Promise.all(tasks);
    return { providers: results };
  }

  private fetchProvider(key: "claude" | "codex" | "antigravity"): Promise<QuotaSnapshot> {
    switch (key) {
      case "claude":
        return this.claude.fetch();
      case "codex":
        return this.codex.fetch();
      case "antigravity":
        return this.antigravity.fetch();
    }
  }
}
