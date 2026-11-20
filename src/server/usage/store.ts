// Issue #13. quota-and-usage.md §3.1–§3.6, protocol.md §4.16–§4.18.
import { existsSync, statSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import type {
  UsageDayAgent,
  UsageDayPayload,
  UsageDaySummary,
  UsageGetPayload,
  UsageModelPayload,
  UsageModelPerDay,
  UsageModelSummary,
  UsageTotals,
} from "../../types/protocol";
import { comparisonRange, daysBetween, addDays, formatYMD, resolveRange, type UsagePreset } from "../../shared/usage";
import { canonical, detectCompany, resolveAntigravityModel } from "./model-id";
import { PricingManager, type ModelPrice, type PriceTier } from "./pricing";
import {
  findFilesRecursive,
  scanAntigravityCacheDb,
  scanAntigravityDb,
  scanClaudeFile,
  scanCodexFile,
  scanOpenCodeDb,
  scanPiFile,
  type RawUsageRecord,
  type ScanStats,
} from "./sources";
import {
  discoverAntigravityLs,
  syncAntigravityDesktopSessions,
  type AntigravityLsConnection,
} from "./antigravity-ls";

/** quota-and-usage.md §3.3: cache reads default to 0.1 × input, cache writes to input. */
function costAt(p: ModelPrice, input: number, output: number, cacheRead: number, cacheWrite: number): number {
  return (
    input * p.inputCostPerToken +
    output * p.outputCostPerToken +
    cacheRead * (p.cacheReadCostPerToken ?? p.inputCostPerToken * 0.1) +
    cacheWrite * (p.cacheWriteCostPerToken ?? p.inputCostPerToken)
  );
}

function toRatePerMillion(perToken: number): number {
  return Math.round(perToken * 1e15) / 1e9;
}

function fromRateRow(row: any): ModelPrice {
  return {
    inputCostPerToken: row.input_rate / 1_000_000,
    outputCostPerToken: row.output_rate / 1_000_000,
    cacheReadCostPerToken: row.cache_read_rate != null ? row.cache_read_rate / 1_000_000 : undefined,
    cacheWriteCostPerToken: row.cache_write_rate != null ? row.cache_write_rate / 1_000_000 : undefined,
    tier: row.tier,
    source: row.source ?? "",
  };
}

function effectiveRates(p: ModelPrice): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  return {
    input: toRatePerMillion(p.inputCostPerToken),
    output: toRatePerMillion(p.outputCostPerToken),
    cacheRead: toRatePerMillion(p.cacheReadCostPerToken ?? p.inputCostPerToken * 0.1),
    cacheWrite: toRatePerMillion(p.cacheWriteCostPerToken ?? p.inputCostPerToken),
  };
}

export interface RepriceModelReport {
  model: string;
  records: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  currentCost: number;
  newCost: number;
  tier: PriceTier | null;
  source: string | null;
  rates: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

export interface RepriceReport {
  fingerprint: string;
  applied: boolean;
  backupPath?: string;
  models: RepriceModelReport[];
  currentTotalCost: number;
  newTotalCost: number;
  unpricedModels: string[];
}

/** quota-and-usage.md §3.3 Reprice: a stable hash of every selected rate vector, tier and source. */
function catalogFingerprint(entries: Array<[string, ModelPrice]>): string {
  const rows = entries
    .map(([model, p]) => ({
      model,
      input: toRatePerMillion(p.inputCostPerToken),
      output: toRatePerMillion(p.outputCostPerToken),
      cacheRead: p.cacheReadCostPerToken != null ? toRatePerMillion(p.cacheReadCostPerToken) : null,
      cacheWrite: p.cacheWriteCostPerToken != null ? toRatePerMillion(p.cacheWriteCostPerToken) : null,
      tier: p.tier ?? null,
      source: p.source ?? null,
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export interface UsageStoreOptions {
  dbPath?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  discoverLs?: () => Promise<AntigravityLsConnection | null>;
}

export class UsageStore {
  private db: Database;
  private dbPath: string;
  private home: string;
  private env: Record<string, string | undefined>;
  private now: () => number;
  private discoverLs: () => Promise<AntigravityLsConnection | null>;
  private agyCacheDbPath: string;
  private lastScannedAt = 0;
  private pricedCatalogs = new WeakMap<PricingManager, number>();

  constructor(options: UsageStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? this.env.HOME ?? "";
    this.now = options.now ?? (() => Date.now());
    this.discoverLs = options.discoverLs ?? (() => discoverAntigravityLs(this.home));
    const defaultDataDir = this.env.XDG_DATA_HOME ? join(this.env.XDG_DATA_HOME, "pigeon") : join(this.home, ".local", "share", "pigeon");
    const dbPath = options.dbPath ?? join(defaultDataDir, "usage.db");
    this.dbPath = dbPath;
    // quota-and-usage.md §3.1: Pigeon's own Antigravity cache lives next to the usage database.
    this.agyCacheDbPath = join(dirname(dbPath), "antigravity-cache", "cache.db");
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.run("PRAGMA busy_timeout = 5000;");
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA synchronous = NORMAL;");
    this.initSchema();
    this.lastScannedAt = this.getLastScannedAt();
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage_records (
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_key TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        date TEXT NOT NULL,
        raw_model_id TEXT,
        model_id TEXT NOT NULL,
        canonical_model_id TEXT NOT NULL,
        company TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        cost REAL NOT NULL,
        unpriced INTEGER NOT NULL,
        PRIMARY KEY (agent, message_key)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_records_date ON usage_records(date);
      CREATE INDEX IF NOT EXISTS idx_usage_records_agent_date ON usage_records(agent, date);
      CREATE INDEX IF NOT EXISTS idx_usage_records_model_date ON usage_records(canonical_model_id, date);

      CREATE TABLE IF NOT EXISTS scan_file_state (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        watermark INTEGER NOT NULL DEFAULT 0,
        updated_watermark INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS model_price_periods (
        model TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_to TEXT,
        input_rate REAL NOT NULL,
        output_rate REAL NOT NULL,
        cache_read_rate REAL,
        cache_write_rate REAL,
        tier TEXT,
        source TEXT,
        PRIMARY KEY (model, effective_from)
      );

      CREATE TABLE IF NOT EXISTS model_releases (
        model TEXT PRIMARY KEY,
        release_date TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_meta (
        key TEXT PRIMARY KEY,
        val TEXT NOT NULL
      );
    `);

    const cols = (this.db.query("PRAGMA table_info('usage_records')").all() as any[]).map((c) => c.name);
    if (!cols.includes("raw_model_id")) {
      this.db.run("ALTER TABLE usage_records ADD COLUMN raw_model_id TEXT;");
    }
    const scanCols = (this.db.query("PRAGMA table_info('scan_file_state')").all() as any[]).map((c) => c.name);
    if (!scanCols.includes("watermark")) {
      this.db.run("ALTER TABLE scan_file_state ADD COLUMN watermark INTEGER NOT NULL DEFAULT 0;");
    }
    if (!scanCols.includes("updated_watermark")) {
      this.db.run("ALTER TABLE scan_file_state ADD COLUMN updated_watermark INTEGER NOT NULL DEFAULT 0;");
    }
    const periodCols = (this.db.query("PRAGMA table_info('model_price_periods')").all() as any[]).map((c) => c.name);
    if (!periodCols.includes("tier")) {
      this.db.run("ALTER TABLE model_price_periods ADD COLUMN tier TEXT;");
    }
    if (!periodCols.includes("source")) {
      this.db.run("ALTER TABLE model_price_periods ADD COLUMN source TEXT;");
    }
  }

  public getLastScannedAt(): number {
    if (this.lastScannedAt > 0) return this.lastScannedAt;
    const row: any = this.db.query("SELECT val FROM usage_meta WHERE key = 'last_scanned_at'").get();
    if (row?.val) {
      this.lastScannedAt = Number(row.val);
      return this.lastScannedAt;
    }
    return 0;
  }

  public syncScannedAt(ts: number): void {
    if (ts > this.lastScannedAt) {
      this.lastScannedAt = ts;
    }
  }

  public setLastScannedAt(ts: number): void {
    this.lastScannedAt = ts;
    try {
      this.db.run(
        "INSERT INTO usage_meta (key, val) VALUES ('last_scanned_at', ?) ON CONFLICT(key) DO UPDATE SET val = excluded.val",
        [ts.toString()]
      );
    } catch (err) {
      console.error("[Pigeon] failed to persist last_scanned_at:", err);
    }
  }

  public close(): void {
    this.db.close();
  }

  public async scanIncremental(pricing: PricingManager): Promise<{ scannedFiles: number; recordsAdded: number }> {
    let scannedFiles = 0;
    let recordsAdded = 0;

    // Discover files
    const claudeFiles = [
      ...findFilesRecursive(join(this.home, ".claude", "projects"), ".jsonl"),
      ...findFilesRecursive(join(this.home, ".claude", "transcripts"), ".jsonl"),
    ];

    const codexHome = this.env.CODEX_HOME;
    const codexFiles = [
      ...(codexHome ? findFilesRecursive(join(codexHome, "sessions"), [".jsonl", ".zst"]) : []),
      ...(codexHome ? findFilesRecursive(join(codexHome, "archived_sessions"), [".jsonl", ".zst"]) : []),
      ...findFilesRecursive(join(this.home, ".codex", "sessions"), [".jsonl", ".zst"]),
      ...findFilesRecursive(join(this.home, ".codex", "archived_sessions"), [".jsonl", ".zst"]),
    ];

    const agyFiles = [
      ...findFilesRecursive(join(this.home, ".gemini", "antigravity-cli", "conversations"), ".db"),
      ...findFilesRecursive(join(this.home, ".gemini", "antigravity", "conversations"), ".db"),
    ];

    // Sync Antigravity Desktop sessions via local Language Server if running
    const pigeonAgyCacheDb = this.agyCacheDbPath;
    // An offline language server is expected and handled inside; anything else fails the scan loudly.
    const lsConn = await this.discoverLs();
    if (lsConn) await syncAntigravityDesktopSessions(lsConn, pigeonAgyCacheDb, this.home);

    const agyCachePath = existsSync(pigeonAgyCacheDb) ? pigeonAgyCacheDb : null;

    const opencodeDataDir = this.env.XDG_DATA_HOME ? join(this.env.XDG_DATA_HOME, "opencode") : join(this.home, ".local", "share", "opencode");
    const opencodeFiles = findFilesRecursive(opencodeDataDir, ".db").filter((f) => !f.endsWith("-wal") && !f.endsWith("-shm") && !f.endsWith("-journal"));

    const piFiles = findFilesRecursive(join(this.home, ".pi", "agent", "sessions"), ".jsonl");

    const allFiles: Array<{ path: string; agent: string }> = [
      ...claudeFiles.map((path) => ({ path, agent: "claude" })),
      ...codexFiles.map((path) => ({ path, agent: "codex" })),
      ...agyFiles.map((path) => ({ path, agent: "agy" })),
      ...(agyCachePath ? [{ path: agyCachePath, agent: "agy-cache" }] : []),
      ...opencodeFiles.map((path) => ({ path, agent: "opencode" })),
      ...piFiles.map((path) => ({ path, agent: "pi" })),
    ];

    const getFileState = this.db.prepare("SELECT mtime_ms, size_bytes, watermark, updated_watermark FROM scan_file_state WHERE path = ?");
    const setFileState = this.db.prepare(
      "INSERT OR REPLACE INTO scan_file_state (path, mtime_ms, size_bytes, watermark, updated_watermark) VALUES (?, ?, ?, ?, ?)"
    );
    const insertRecord = this.db.prepare(`
      INSERT OR REPLACE INTO usage_records (
        agent, session_id, message_key, timestamp_ms, date, raw_model_id, model_id, canonical_model_id,
        company, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        total_tokens, cost, unpriced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const catalogVersion = pricing.getCatalogVersion();
    const catalogChanged = pricing.arePricesAvailable() && this.pricedCatalogs.get(pricing) !== catalogVersion;
    if (catalogChanged) {
      this.syncPricePeriods(pricing);
    }

    const resolveFamily = this.createGeminiFamilyResolver(pricing);
    const priceCache = new Map<string, { price: ModelPrice | null }>();
    const resolvePrice = (date: string, canon: string): ModelPrice | null => {
      const cacheKey = `${date}:${canon}`;
      if (priceCache.has(cacheKey)) return priceCache.get(cacheKey)!.price;

      const resolved = this.lookupPeriodPrice(date, canon);
      priceCache.set(cacheKey, { price: resolved });
      return resolved;
    };

    const processRecords = this.db.transaction((records: RawUsageRecord[]) => {
      for (const r of records) {
        let modelId = r.modelId;
        let canon = r.canonicalModelId;
        let company = r.company;
        if (r.agent === "agy" && r.unversionedFamily) {
          const matched = resolveFamily(r.unversionedFamily, r.date);
          if (matched) {
            modelId = matched;
            canon = matched;
            company = detectCompany(matched, "agy");
          }
        }
        const p = resolvePrice(r.date, canon);
        pricing.noteModelSeen(canon);
        const cost = p ? costAt(p, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens) : 0;
        const unpriced = p ? 0 : 1;

        insertRecord.run(
          r.agent,
          r.sessionId,
          r.messageKey,
          r.timestampMs,
          r.date,
          r.rawModelId ?? modelId,
          modelId,
          canon,
          company,
          r.inputTokens,
          r.outputTokens,
          r.cacheReadTokens,
          r.cacheWriteTokens,
          r.totalTokens,
          cost,
          unpriced
        );
      }
    });

    const stats: ScanStats = { skipped: 0 };
    for (const item of allFiles) {
      if (!existsSync(item.path)) continue;
      let st: any;
      try {
        st = statSync(item.path);
      } catch {
        continue;
      }

      let fingerprintMtime = Math.floor(st.mtimeMs);
      let fingerprintSize = st.size;
      const walPath = `${item.path}-wal`;
      if (existsSync(walPath)) {
        try {
          const walSt = statSync(walPath);
          fingerprintMtime = Math.max(fingerprintMtime, Math.floor(walSt.mtimeMs));
          fingerprintSize += walSt.size;
        } catch {}
      }

      const existing: any = getFileState.get(item.path);
      if (existing && existing.mtime_ms === fingerprintMtime && existing.size_bytes === fingerprintSize) {
        continue;
      }

      scannedFiles++;
      let rawRecords: RawUsageRecord[] = [];
      let nextWatermark = 0;
      let nextUpdatedWatermark = 0;
      try {
        switch (item.agent) {
          case "claude":
            rawRecords = scanClaudeFile(item.path, stats);
            break;
          case "codex":
            rawRecords = scanCodexFile(item.path, stats);
            break;
          case "agy":
            rawRecords = scanAntigravityDb(item.path);
            break;
          case "agy-cache":
            rawRecords = scanAntigravityCacheDb(item.path);
            break;
          case "opencode":
            rawRecords = scanOpenCodeDb(item.path, stats, {
              lastRowId: Number(existing?.watermark ?? 0),
              lastUpdatedMs: Number(existing?.updated_watermark ?? 0),
              onProgress: (maxRowId, maxUpdatedMs) => {
                nextWatermark = maxRowId;
                nextUpdatedWatermark = maxUpdatedMs;
              },
            });
            break;
          case "pi":
            rawRecords = scanPiFile(item.path, stats);
            break;
        }
      } catch (err) {
        console.warn(`[Pigeon] Failed to scan ${item.path}:`, err);
        continue;
      }

      if (rawRecords.length > 0) {
        processRecords(rawRecords);
        recordsAdded += rawRecords.length;
      }

      setFileState.run(item.path, fingerprintMtime, fingerprintSize, nextWatermark, nextUpdatedWatermark);
    }

    if (pricing.arePricesAvailable()) {
      this.repairAntigravityRecords(pricing, catalogChanged);
    }
    if (catalogChanged) {
      this.backfillUnpricedRecords(pricing);
      this.pricedCatalogs.set(pricing, catalogVersion);
    }

    // quota-and-usage.md §3.1: unparseable records are skipped and logged once per scan.
    if (stats.skipped > 0) console.warn(`[Pigeon] usage scan skipped ${stats.skipped} unparseable records`);
    this.setLastScannedAt(this.now());
    return { scannedFiles, recordsAdded };
  }

  /** quota-and-usage.md §3.3: a lookup never writes a period. */
  private lookupPeriodPrice(date: string, canon: string): ModelPrice | null {
    const row: any = this.db
      .query(
        `SELECT input_rate, output_rate, cache_read_rate, cache_write_rate, tier, source
         FROM model_price_periods
         WHERE model = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
         ORDER BY effective_from DESC
         LIMIT 1`
      )
      .get(canon, date, date);
    return row ? fromRateRow(row) : null;
  }

  /** quota-and-usage.md §3.3: the one cost path for ingest, period changes, repair, backfill and reprice. */
  private recomputeCosts(model: string, fromDate: string): number {
    const rows: any[] = this.db
      .query(
        `SELECT u.agent, u.message_key, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
                u.cost, u.unpriced,
                p.input_rate, p.output_rate, p.cache_read_rate, p.cache_write_rate, p.tier, p.source
         FROM usage_records u
         LEFT JOIN model_price_periods p ON p.rowid = (
           SELECT p2.rowid FROM model_price_periods p2
           WHERE p2.model = u.canonical_model_id AND p2.effective_from <= u.date
             AND (p2.effective_to IS NULL OR p2.effective_to >= u.date)
           ORDER BY p2.effective_from DESC
           LIMIT 1
         )
         WHERE u.canonical_model_id = ? AND u.date >= ?`
      )
      .all(model, fromDate);

    const update = this.db.prepare("UPDATE usage_records SET cost = ?, unpriced = ? WHERE agent = ? AND message_key = ?");
    let changed = 0;
    for (const row of rows) {
      const price = row.input_rate == null ? null : fromRateRow(row);
      const cost = price ? costAt(price, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens) : 0;
      const unpriced = price ? 0 : 1;
      if (cost === row.cost && unpriced === row.unpriced) continue;
      update.run(cost, unpriced, row.agent, row.message_key);
      changed++;
    }
    return changed;
  }

  private syncPricePeriods(pricing: PricingManager): void {
    const entries = pricing.getCatalogEntries();
    // quota-and-usage.md §3.3: an unavailable or ignored cache must never close every period.
    if (!pricing.arePricesAvailable() || entries.length === 0) return;
    const today = formatYMD(new Date(this.now()));
    const yesterday = addDays(today, -1);
    const seen = new Set<string>();

    const getOpen = this.db.prepare(
      "SELECT effective_from, input_rate, output_rate, cache_read_rate, cache_write_rate, tier, source FROM model_price_periods WHERE model = ? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1"
    );
    const countPeriods = this.db.prepare("SELECT COUNT(*) as cnt FROM model_price_periods WHERE model = ?");
    const insertPeriod = this.db.prepare(
      `INSERT OR REPLACE INTO model_price_periods (model, effective_from, effective_to, input_rate, output_rate, cache_read_rate, cache_write_rate, tier, source)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`
    );
    const updateInPlace = this.db.prepare(
      `UPDATE model_price_periods SET input_rate = ?, output_rate = ?, cache_read_rate = ?, cache_write_rate = ?, tier = ?, source = ?
       WHERE model = ? AND effective_from = ?`
    );
    const updateMeta = this.db.prepare(
      "UPDATE model_price_periods SET tier = ?, source = ? WHERE model = ? AND effective_from = ?"
    );
    const closePeriod = this.db.prepare(
      "UPDATE model_price_periods SET effective_to = ? WHERE model = ? AND effective_from = ?"
    );
    const upsertRelease = this.db.prepare(
      "INSERT OR REPLACE INTO model_releases (model, release_date) VALUES (?, ?)"
    );

    this.db.transaction(() => {
      for (const [canon, price] of entries) {
        if (!canon || seen.has(canon)) continue;
        seen.add(canon);

        if (price.releaseDate) {
          upsertRelease.run(canon, price.releaseDate);
        }
        const inRate = toRatePerMillion(price.inputCostPerToken);
        const outRate = toRatePerMillion(price.outputCostPerToken);
        const crRate = price.cacheReadCostPerToken != null ? toRatePerMillion(price.cacheReadCostPerToken) : null;
        const cwRate = price.cacheWriteCostPerToken != null ? toRatePerMillion(price.cacheWriteCostPerToken) : null;
        const tier = price.tier ?? null;
        const source = price.source ?? null;

        const open: any = getOpen.get(canon);
        if (!open) {
          const cntRow: any = countPeriods.get(canon);
          const from = !cntRow?.cnt ? "0000-01-01" : today;
          insertPeriod.run(canon, from, inRate, outRate, crRate, cwRate, tier, source);
          this.recomputeCosts(canon, from);
          continue;
        }

        if (
          open.input_rate === inRate &&
          open.output_rate === outRate &&
          (open.cache_read_rate ?? null) === crRate &&
          (open.cache_write_rate ?? null) === cwRate
        ) {
          if (open.tier !== tier || open.source !== source) {
            updateMeta.run(tier, source, canon, open.effective_from);
          }
          continue;
        }

        if (open.effective_from >= today) {
          updateInPlace.run(inRate, outRate, crRate, cwRate, tier, source, canon, open.effective_from);
        } else {
          closePeriod.run(yesterday, canon, open.effective_from);
          insertPeriod.run(canon, today, inRate, outRate, crRate, cwRate, tier, source);
        }
        this.recomputeCosts(canon, today);
      }

      // A model the current catalog no longer prices loses its open period at yesterday.
      const openRows = this.db
        .query("SELECT model, effective_from FROM model_price_periods WHERE effective_to IS NULL")
        .all() as Array<{ model: string; effective_from: string }>;
      for (const row of openRows) {
        if (seen.has(row.model)) continue;
        closePeriod.run(yesterday, row.model, row.effective_from);
        this.recomputeCosts(row.model, today);
      }
    })();
  }

  public backfillUnpricedRecords(pricing: PricingManager): number {
    if (!pricing.arePricesAvailable()) return 0;

    const rows = this.db
      .query("SELECT DISTINCT canonical_model_id AS model FROM usage_records WHERE unpriced = 1")
      .all() as Array<{ model: string }>;

    let updated = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        updated += this.recomputeCosts(row.model, "0000-01-01");
      }
    })();

    return updated;
  }

  private createGeminiFamilyResolver(pricing: PricingManager): (family: string, date: string) => string | null {
    type Candidate = { model: string; major: number; minor: number; releaseDate: string | null };
    const baseRe = /^gemini-(\d+)(?:-(\d+))?-([a-z][a-z0-9]*)$/;
    let byFamily: Map<string, Map<string, Candidate>> | null = null;

    const ensureIndexed = (): Map<string, Map<string, Candidate>> => {
      if (byFamily) return byFamily;
      byFamily = new Map();

      const register = (modelName: string, releaseDate: string | null) => {
        const m = modelName.match(baseRe);
        if (!m) return;
        const fam = m[3];
        const major = parseInt(m[1], 10);
        const minor = m[2] !== undefined ? parseInt(m[2], 10) : 0;
        let famMap = byFamily!.get(fam);
        if (!famMap) {
          famMap = new Map();
          byFamily!.set(fam, famMap);
        }
        const prev = famMap.get(modelName);
        if (!prev || (!prev.releaseDate && releaseDate)) {
          famMap.set(modelName, { model: modelName, major, minor, releaseDate: releaseDate ?? prev?.releaseDate ?? null });
        }
      };

      const releaseRows = this.db.query("SELECT model, release_date FROM model_releases").all() as Array<{
        model: string;
        release_date: string;
      }>;
      for (const r of releaseRows) register(r.model, r.release_date);

      for (const [rawKey, entry] of pricing.getCatalogEntries()) {
        if (rawKey.includes("/")) continue;
        register(canonical(rawKey), entry.releaseDate ?? null);
      }

      const periodRows = this.db.query("SELECT DISTINCT model FROM model_price_periods WHERE model LIKE 'gemini-%'").all() as Array<{
        model: string;
      }>;
      for (const r of periodRows) register(r.model, null);
      return byFamily;
    };

    const memo = new Map<string, string | null>();
    return (family: string, date: string): string | null => {
      const target = family.trim().toLowerCase();
      if (!target) return null;
      const cacheKey = `${target}:${date}`;
      if (memo.has(cacheKey)) return memo.get(cacheKey)!;

      const famMap = ensureIndexed().get(target);
      if (!famMap || famMap.size === 0) {
        memo.set(cacheKey, null);
        return null;
      }

      const candidates = Array.from(famMap.values());
      const dated = candidates.filter((c) => c.releaseDate !== null);

      let chosen: string;
      if (dated.length > 0) {
        const eligible = dated.filter((c) => c.releaseDate! <= date);
        if (eligible.length > 0) {
          eligible.sort((a, b) => {
            if (b.major !== a.major) return b.major - a.major;
            if (b.minor !== a.minor) return b.minor - a.minor;
            return b.releaseDate!.localeCompare(a.releaseDate!);
          });
          chosen = eligible[0].model;
        } else {
          dated.sort((a, b) => {
            const cmp = a.releaseDate!.localeCompare(b.releaseDate!);
            if (cmp !== 0) return cmp;
            if (a.major !== b.major) return a.major - b.major;
            return a.minor - b.minor;
          });
          chosen = dated[0].model;
        }
      } else {
        candidates.sort((a, b) => {
          if (b.major !== a.major) return b.major - a.major;
          return b.minor - a.minor;
        });
        chosen = candidates[0].model;
      }

      memo.set(cacheKey, chosen);
      return chosen;
    };
  }

  public repairAntigravityRecords(pricing: PricingManager, recheckFamilies = false): number {
    const candidateRows: any[] = this.db
      .query(`
        SELECT agent, message_key, date, raw_model_id, model_id, canonical_model_id, company, cost, unpriced,
               input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
        FROM usage_records
        WHERE agent = 'agy' AND (
          unpriced = 1 OR
          canonical_model_id LIKE '%-n' OR
          canonical_model_id LIKE '%-a' OR
          canonical_model_id = 'gemini-default' OR
          canonical_model_id LIKE '%-trial' OR
          canonical_model_id LIKE '%-xhigh' OR
          canonical_model_id LIKE 'gemini-pro-orchestrator%' OR
          canonical_model_id LIKE 'gemini-%-worker%' OR
          (? = 1 AND raw_model_id IS NOT NULL AND raw_model_id NOT LIKE 'MODEL_PLACEHOLDER_%')
        )
      `)
      .all(recheckFamilies ? 1 : 0);

    if (candidateRows.length === 0) return 0;

    const resolveFamily = this.createGeminiFamilyResolver(pricing);
    let repaired = 0;
    const update = this.db.prepare(`
      UPDATE usage_records
      SET raw_model_id = ?, model_id = ?, canonical_model_id = ?, company = ?, cost = ?, unpriced = ?
      WHERE agent = ? AND message_key = ?
    `);

    this.db.transaction(() => {
      for (const row of candidateRows) {
        const resolved = resolveAntigravityModel(row.raw_model_id, row.model_id);
        let modelId = resolved.modelId;
        let canon = resolved.canonicalModelId;
        if (resolved.unversionedFamily) {
          const matched = resolveFamily(resolved.unversionedFamily, row.date);
          if (matched) {
            modelId = matched;
            canon = matched;
          }
        }
        const company = detectCompany(canon, "agy");
        const p = this.lookupPeriodPrice(row.date, canon);
        const cost = p ? costAt(p, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens) : 0;
        const unpriced = p ? 0 : 1;
        if (
          resolved.rawModelId === row.raw_model_id &&
          modelId === row.model_id &&
          canon === row.canonical_model_id &&
          company === row.company &&
          cost === row.cost &&
          unpriced === row.unpriced
        ) {
          continue;
        }
        update.run(resolved.rawModelId, modelId, canon, company, cost, unpriced, row.agent, row.message_key);
        repaired++;
      }
    })();

    return repaired;
  }

  public async rebuildAll(pricing: PricingManager): Promise<{ scannedFiles: number; recordsAdded: number }> {
    this.db.run("DELETE FROM usage_records;");
    this.db.run("DELETE FROM scan_file_state;");
    this.db.run("VACUUM;");
    return this.scanIncremental(pricing);
  }

  /** quota-and-usage.md §3.3 Reprice: recompute derived costs from unchanged token facts. */
  public reprice(pricing: PricingManager, opts: { apply: boolean; expectFingerprint?: string }): RepriceReport {
    const entries = pricing.getCatalogEntries();
    if (!pricing.arePricesAvailable() || entries.length === 0) {
      throw new Error("prices unavailable: models.dev has not been fetched successfully");
    }
    const fingerprint = catalogFingerprint(entries);
    const priceByModel = new Map(entries);

    const rows: any[] = this.db
      .query(
        `SELECT canonical_model_id AS model,
                COUNT(*) AS records,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(cost), 0) AS current_cost
         FROM usage_records
         GROUP BY canonical_model_id
         ORDER BY canonical_model_id`
      )
      .all();

    const models: RepriceModelReport[] = rows.map((row) => {
      const price = priceByModel.get(row.model) ?? null;
      return {
        model: row.model,
        records: Number(row.records),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        cacheReadTokens: Number(row.cache_read_tokens),
        cacheWriteTokens: Number(row.cache_write_tokens),
        currentCost: Number(row.current_cost),
        newCost: price ? costAt(price, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens) : 0,
        tier: price?.tier ?? null,
        source: price?.source ?? null,
        rates: price ? effectiveRates(price) : null,
      };
    });

    const report: RepriceReport = {
      fingerprint,
      applied: false,
      models,
      currentTotalCost: models.reduce((sum, m) => sum + m.currentCost, 0),
      newTotalCost: models.reduce((sum, m) => sum + m.newCost, 0),
      unpricedModels: models.filter((m) => !priceByModel.has(m.model)).map((m) => m.model),
    };
    if (!opts.apply) return report;
    if (opts.expectFingerprint !== fingerprint) {
      throw new Error(`Pricing catalog fingerprint mismatch: expected ${opts.expectFingerprint}, current ${fingerprint}. Run the dry run again.`);
    }

    const backupPath = this.backupDatabase();
    this.db.transaction(() => {
      this.db.run("DELETE FROM model_price_periods;");
      const insert = this.db.prepare(
        `INSERT INTO model_price_periods (model, effective_from, effective_to, input_rate, output_rate, cache_read_rate, cache_write_rate, tier, source)
         VALUES (?, '0000-01-01', NULL, ?, ?, ?, ?, ?, ?)`
      );
      for (const [model, price] of entries) {
        insert.run(
          model,
          toRatePerMillion(price.inputCostPerToken),
          toRatePerMillion(price.outputCostPerToken),
          price.cacheReadCostPerToken != null ? toRatePerMillion(price.cacheReadCostPerToken) : null,
          price.cacheWriteCostPerToken != null ? toRatePerMillion(price.cacheWriteCostPerToken) : null,
          price.tier ?? null,
          price.source ?? null
        );
      }
      const recordModels = this.db
        .query("SELECT DISTINCT canonical_model_id AS model FROM usage_records")
        .all() as Array<{ model: string }>;
      for (const row of recordModels) {
        this.recomputeCosts(row.model, "0000-01-01");
      }
      this.db.run(
        "INSERT INTO usage_meta (key, val) VALUES ('pricing_rebuilt_at', ?) ON CONFLICT(key) DO UPDATE SET val = excluded.val",
        [new Date(this.now()).toISOString()]
      );
    })();

    return { ...report, applied: true, backupPath };
  }

  private backupDatabase(): string {
    const dir = dirname(this.dbPath);
    const base = basename(this.dbPath, ".db");
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    let path = join(dir, `${base}.reprice-${stamp}.db`);
    for (let i = 1; existsSync(path); i++) {
      path = join(dir, `${base}.reprice-${stamp}-${i}.db`);
    }
    this.db.run("VACUUM INTO ?", [path]);
    return path;
  }

  public getTotalsSummary(): { totalTokens: number; totalCost: number; recordCount: number } {
    const row = this.db
      .query("SELECT COUNT(*) as cnt, COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost), 0) as cost FROM usage_records")
      .get() as any;
    return {
      recordCount: row?.cnt || 0,
      totalTokens: row?.tokens || 0,
      totalCost: row?.cost || 0,
    };
  }

  public getFirstDay(agents: string[]): string | null {
    if (!agents.length) return null;
    const placeholders = agents.map(() => "?").join(",");
    const row: any = this.db
      .query(`SELECT MIN(date) as first_day FROM usage_records WHERE agent IN (${placeholders})`)
      .get(...agents);
    return row?.first_day ?? null;
  }

  public getUsageReport(
    req: { preset: string; from?: string; to?: string; agents: string[] },
    resolvedRange: { from: string; to: string },
    today: string,
    pricesAvailable: boolean,
    knownFirstDay?: string | null
  ): UsageGetPayload {
    const agentsList = req.agents;
    const placeholders = agentsList.map(() => "?").join(",");

    // First day
    const firstDay = knownFirstDay !== undefined ? knownFirstDay : this.getFirstDay(agentsList);
    if (req.preset === "all" && firstDay) {
      resolvedRange = resolveRange("all", today, { firstDay });
    }

    // Days summary first so scalar totals reuse its breakdown without a second aggregation scan
    const dayRows: any[] = this.db
      .query(`
        SELECT
          date,
          COALESCE(SUM(cost), 0) as cost,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(input_tokens), 0) as input,
          COALESCE(SUM(output_tokens), 0) as output,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read,
          COALESCE(SUM(cache_write_tokens), 0) as cache_write,
          COUNT(*) as messages,
          COUNT(DISTINCT session_id) as sessions
        FROM usage_records
        WHERE agent IN (${placeholders}) AND date >= ? AND date <= ?
        GROUP BY date
        ORDER BY date DESC
      `)
      .all(...agentsList, resolvedRange.from, resolvedRange.to);

    let totCost = 0;
    let totTokens = 0;
    let totInput = 0;
    let totOutput = 0;
    let totCacheRead = 0;
    let totCacheWrite = 0;
    let totMessages = 0;
    const days: UsageDaySummary[] = dayRows.map((r) => {
      const c = Number(r.cost);
      const t = Number(r.tokens);
      const inp = Number(r.input);
      const out = Number(r.output);
      const cr = Number(r.cache_read);
      const cw = Number(r.cache_write);
      const msgs = Number(r.messages);
      totCost += c;
      totTokens += t;
      totInput += inp;
      totOutput += out;
      totCacheRead += cr;
      totCacheWrite += cw;
      totMessages += msgs;
      return {
        date: r.date,
        cost: Number(c.toFixed(4)),
        tokens: t,
        input: inp,
        output: out,
        cacheRead: cr,
        cacheWrite: cw,
        messages: msgs,
        sessions: Number(r.sessions),
      };
    });

    const sessionsRow: any =
      dayRows.length > 0
        ? this.db
            .query(`
              SELECT COUNT(DISTINCT session_id) as sessions
              FROM usage_records
              WHERE agent IN (${placeholders}) AND date >= ? AND date <= ?
            `)
            .get(...agentsList, resolvedRange.from, resolvedRange.to)
        : { sessions: 0 };

    const totals: UsageTotals = {
      cost: Number(totCost.toFixed(4)),
      tokens: totTokens,
      input: totInput,
      output: totOutput,
      cacheRead: totCacheRead,
      cacheWrite: totCacheWrite,
      messages: totMessages,
      sessions: Number(sessionsRow?.sessions ?? 0),
    };

    // Comparison
    const nowDt = new Date(this.now());
    const nowMinutes = nowDt.getHours() * 60 + nowDt.getMinutes();
    const comp = comparisonRange(resolvedRange, req.preset as UsagePreset, today, firstDay, nowMinutes);

    let comparison: { from: string; to: string; totals: UsageTotals } | null = null;
    if (comp) {
      let compTotalsRow: any;
      if (comp.untilMinutes !== null) {
        // Compare today up to untilMinutes
        // We filter messages whose time of day is <= untilMinutes
        // In local time, dt.getHours()*60 + dt.getMinutes() <= untilMinutes
        const rows: any[] = this.db
          .query(`
            SELECT timestamp_ms, cost, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, session_id
            FROM usage_records
            WHERE agent IN (${placeholders}) AND date = ?
          `)
          .all(...agentsList, comp.from);

        let cCost = 0, cTokens = 0, cInp = 0, cOut = 0, cCr = 0, cCw = 0, cMsgs = 0;
        const cSessions = new Set<string>();
        for (const r of rows) {
          const dt = new Date(r.timestamp_ms);
          const mins = dt.getHours() * 60 + dt.getMinutes();
          if (mins <= comp.untilMinutes) {
            cCost += r.cost;
            cTokens += r.total_tokens;
            cInp += r.input_tokens;
            cOut += r.output_tokens;
            cCr += r.cache_read_tokens;
            cCw += r.cache_write_tokens;
            cMsgs++;
            cSessions.add(r.session_id);
          }
        }
        comparison = {
          from: comp.from,
          to: comp.to,
          totals: {
            cost: Number(cCost.toFixed(4)),
            tokens: cTokens,
            input: cInp,
            output: cOut,
            cacheRead: cCr,
            cacheWrite: cCw,
            messages: cMsgs,
            sessions: cSessions.size,
          },
        };
      } else {
        compTotalsRow = this.db
          .query(`
            SELECT
              COALESCE(SUM(cost), 0) as cost,
              COALESCE(SUM(total_tokens), 0) as tokens,
              COALESCE(SUM(input_tokens), 0) as input,
              COALESCE(SUM(output_tokens), 0) as output,
              COALESCE(SUM(cache_read_tokens), 0) as cache_read,
              COALESCE(SUM(cache_write_tokens), 0) as cache_write,
              COUNT(*) as messages,
              COUNT(DISTINCT session_id) as sessions
            FROM usage_records
            WHERE agent IN (${placeholders}) AND date >= ? AND date <= ?
          `)
          .get(...agentsList, comp.from, comp.to);

        comparison = {
          from: comp.from,
          to: comp.to,
          totals: {
            cost: Number(compTotalsRow.cost.toFixed(4)),
            tokens: Number(compTotalsRow.tokens),
            input: Number(compTotalsRow.input),
            output: Number(compTotalsRow.output),
            cacheRead: Number(compTotalsRow.cache_read),
            cacheWrite: Number(compTotalsRow.cache_write),
            messages: Number(compTotalsRow.messages),
            sessions: Number(compTotalsRow.sessions),
          },
        };
      }
    }

    // Models summary
    const modelRows: any[] = this.db
      .query(`
        SELECT
          canonical_model_id as model,
          MAX(company) as company,
          GROUP_CONCAT(DISTINCT agent) as agents_str,
          MAX(date) as last_used,
          MAX(unpriced) as unpriced,
          COALESCE(SUM(cost), 0) as cost,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(input_tokens), 0) as input,
          COALESCE(SUM(output_tokens), 0) as output,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read,
          COALESCE(SUM(cache_write_tokens), 0) as cache_write,
          COUNT(*) as messages,
          COUNT(DISTINCT session_id) as sessions
        FROM usage_records
        WHERE agent IN (${placeholders}) AND date >= ? AND date <= ?
        GROUP BY canonical_model_id
        ORDER BY tokens DESC
      `)
      .all(...agentsList, resolvedRange.from, resolvedRange.to);

    const models: UsageModelSummary[] = modelRows.map((r) => ({
      model: r.model,
      company: r.company || detectCompany(r.model),
      agents: r.agents_str ? r.agents_str.split(",") : [],
      lastUsed: r.last_used,
      unpriced: r.unpriced > 0,
      cost: Number(r.cost.toFixed(4)),
      tokens: Number(r.tokens),
      input: Number(r.input),
      output: Number(r.output),
      cacheRead: Number(r.cache_read),
      cacheWrite: Number(r.cache_write),
      messages: Number(r.messages),
      sessions: Number(r.sessions),
    }));

    return {
      range: resolvedRange,
      firstDay,
      scannedAt: this.getLastScannedAt() || this.now(),
      pricesAvailable,
      totals,
      comparison,
      days,
      models,
    };
  }

  public getDayReport(req: { date: string; agents: string[] }): UsageDayPayload {
    const agentsList = req.agents;
    const placeholders = agentsList.map(() => "?").join(",");

    const dayTotalsRow: any = this.db
      .query(`
        SELECT
          COALESCE(SUM(cost), 0) as cost,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(input_tokens), 0) as input,
          COALESCE(SUM(output_tokens), 0) as output,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read,
          COALESCE(SUM(cache_write_tokens), 0) as cache_write,
          COUNT(*) as messages,
          COUNT(DISTINCT session_id) as sessions
        FROM usage_records
        WHERE agent IN (${placeholders}) AND date = ?
      `)
      .get(...agentsList, req.date);

    const totals: UsageTotals = {
      cost: Number(dayTotalsRow.cost.toFixed(4)),
      tokens: Number(dayTotalsRow.tokens),
      input: Number(dayTotalsRow.input),
      output: Number(dayTotalsRow.output),
      cacheRead: Number(dayTotalsRow.cache_read),
      cacheWrite: Number(dayTotalsRow.cache_write),
      messages: Number(dayTotalsRow.messages),
      sessions: Number(dayTotalsRow.sessions),
    };

    const agentRows: any[] = this.db
      .query(`
        SELECT
          agent,
          COALESCE(SUM(cost), 0) as cost,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(input_tokens), 0) as input,
          COALESCE(SUM(output_tokens), 0) as output,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read,
          COALESCE(SUM(cache_write_tokens), 0) as cache_write,
          COUNT(*) as messages,
          COUNT(DISTINCT session_id) as sessions
        FROM usage_records
        WHERE agent IN (${placeholders}) AND date = ?
        GROUP BY agent
        ORDER BY cost DESC
      `)
      .all(...agentsList, req.date);

    const modelRows: any[] = this.db
      .query(`
        SELECT
          agent,
          canonical_model_id as model,
          MAX(company) as company,
          COALESCE(SUM(cost), 0) as cost,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(input_tokens), 0) as input,
          COALESCE(SUM(output_tokens), 0) as output,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read,
          COALESCE(SUM(cache_write_tokens), 0) as cache_write,
          COUNT(*) as messages,
          COUNT(DISTINCT session_id) as sessions
        FROM usage_records
        WHERE agent IN (${placeholders}) AND date = ?
        GROUP BY agent, canonical_model_id
        ORDER BY cost DESC
      `)
      .all(...agentsList, req.date);

    const modelsByAgent = new Map<string, any[]>();
    for (const m of modelRows) {
      let list = modelsByAgent.get(m.agent);
      if (!list) {
        list = [];
        modelsByAgent.set(m.agent, list);
      }
      list.push({
        model: m.model,
        company: m.company,
        cost: Number(m.cost.toFixed(4)),
        tokens: Number(m.tokens),
        input: Number(m.input),
        output: Number(m.output),
        cacheRead: Number(m.cache_read),
        cacheWrite: Number(m.cache_write),
        messages: Number(m.messages),
        sessions: Number(m.sessions),
      });
    }

    const agents: UsageDayAgent[] = agentRows.map((r) => ({
      agent: r.agent,
      cost: Number(r.cost.toFixed(4)),
      tokens: Number(r.tokens),
      input: Number(r.input),
      output: Number(r.output),
      cacheRead: Number(r.cache_read),
      cacheWrite: Number(r.cache_write),
      messages: Number(r.messages),
      sessions: Number(r.sessions),
      models: modelsByAgent.get(r.agent) || [],
    }));

    return {
      date: req.date,
      totals,
      agents,
    };
  }

  public getModelReport(req: { model: string; from: string; to: string; agents: string[] }): UsageModelPayload {
    const canon = canonical(req.model);
    const agentsList = req.agents;
    const placeholders = agentsList.map(() => "?").join(",");

    const totalsRow: any = this.db
      .query(`
        SELECT
          MAX(company) as company,
          MAX(date) as last_used,
          COALESCE(SUM(cost), 0) as cost,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(input_tokens), 0) as input,
          COALESCE(SUM(output_tokens), 0) as output,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read,
          COALESCE(SUM(cache_write_tokens), 0) as cache_write,
          COUNT(*) as messages,
          COUNT(DISTINCT session_id) as sessions
        FROM usage_records
        WHERE canonical_model_id = ? AND agent IN (${placeholders}) AND date >= ? AND date <= ?
      `)
      .get(canon, ...agentsList, req.from, req.to);

    const totals: UsageTotals = {
      cost: Number(totalsRow.cost.toFixed(4)),
      tokens: Number(totalsRow.tokens),
      input: Number(totalsRow.input),
      output: Number(totalsRow.output),
      cacheRead: Number(totalsRow.cache_read),
      cacheWrite: Number(totalsRow.cache_write),
      messages: Number(totalsRow.messages),
      sessions: Number(totalsRow.sessions),
    };

    const agentRows: any[] = this.db
      .query(`
        SELECT
          agent,
          COALESCE(SUM(cost), 0) as cost,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(input_tokens), 0) as input,
          COALESCE(SUM(output_tokens), 0) as output,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read,
          COALESCE(SUM(cache_write_tokens), 0) as cache_write,
          COUNT(*) as messages,
          COUNT(DISTINCT session_id) as sessions
        FROM usage_records
        WHERE canonical_model_id = ? AND agent IN (${placeholders}) AND date >= ? AND date <= ?
        GROUP BY agent
        ORDER BY tokens DESC
      `)
      .all(canon, ...agentsList, req.from, req.to);

    const agents = agentRows.map((r) => ({
      agent: r.agent,
      cost: Number(r.cost.toFixed(4)),
      tokens: Number(r.tokens),
      input: Number(r.input),
      output: Number(r.output),
      cacheRead: Number(r.cache_read),
      cacheWrite: Number(r.cache_write),
      messages: Number(r.messages),
      sessions: Number(r.sessions),
    }));

    // perDay: every day from req.from to req.to in order
    const dayRows: any[] = this.db
      .query(`
        SELECT
          date,
          COALESCE(SUM(cost), 0) as cost,
          COALESCE(SUM(total_tokens), 0) as tokens
        FROM usage_records
        WHERE canonical_model_id = ? AND agent IN (${placeholders}) AND date >= ? AND date <= ?
        GROUP BY date
      `)
      .all(canon, ...agentsList, req.from, req.to);

    const dayMap = new Map<string, { tokens: number; cost: number }>();
    for (const r of dayRows) {
      dayMap.set(r.date, { tokens: Number(r.tokens), cost: Number(r.cost.toFixed(4)) });
    }

    const perDay: UsageModelPerDay[] = [];
    const len = daysBetween(req.from, req.to) + 1;
    for (let i = 0; i < len; i++) {
      const curDate = addDays(req.from, i);
      const val = dayMap.get(curDate) || { tokens: 0, cost: 0 };
      perDay.push({ date: curDate, tokens: val.tokens, cost: val.cost });
    }

    return {
      model: canon,
      company: totalsRow.company || detectCompany(canon),
      totals,
      lastUsed: totalsRow.last_used || "—",
      agents,
      perDay,
    };
  }
}
