// Issue #13. quota-and-usage.md §3.1–§3.6, protocol.md §4.16–§4.18.
import { existsSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { comparisonRange, daysBetween, addDays, resolveRange, type UsagePreset } from "../../shared/usage";
import { canonical, detectCompany, resolveAntigravityModel } from "./model-id";
import { PricingManager, type ModelPrice } from "./pricing";
import {
  findFilesRecursive,
  scanAntigravityCacheDb,
  scanAntigravityDb,
  scanClaudeFile,
  scanCodexFile,
  scanOpenCodeDb,
  scanPiFile,
  type RawUsageRecord,
} from "./sources";

export interface UsageStoreOptions {
  dbPath?: string;
  home?: string;
  now?: () => number;
}

export class UsageStore {
  private db: Database;
  private home: string;
  private now: () => number;

  constructor(options: UsageStoreOptions = {}) {
    this.home = options.home ?? process.env.HOME ?? "";
    this.now = options.now ?? (() => Date.now());
    const defaultDataDir = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "pigeon") : join(this.home, ".local", "share", "pigeon");
    const dbPath = options.dbPath ?? join(defaultDataDir, "usage.db");
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA synchronous = NORMAL;");
    this.initSchema();
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
        size_bytes INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_pricing_snapshots (
        date TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_cost REAL NOT NULL,
        output_cost REAL NOT NULL,
        cache_read_cost REAL,
        cache_write_cost REAL,
        PRIMARY KEY (date, model_id)
      );
    `);

    try {
      const cols = (this.db.query("PRAGMA table_info('usage_records')").all() as any[]).map((c) => c.name);
      if (!cols.includes("raw_model_id")) {
        this.db.run("ALTER TABLE usage_records ADD COLUMN raw_model_id TEXT;");
      }
    } catch {}
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

    const codexHome = process.env.CODEX_HOME;
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

    const defaultDataDir = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "pigeon") : join(this.home, ".local", "share", "pigeon");
    const pigeonAgyCacheDir = join(defaultDataDir, "antigravity-cache");
    const pigeonAgyCacheDb = join(pigeonAgyCacheDir, "cache.db");
    const agyCachePath: string | null = existsSync(pigeonAgyCacheDb) ? pigeonAgyCacheDb : null;

    const opencodeDataDir = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "opencode") : join(this.home, ".local", "share", "opencode");
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

    const getFileState = this.db.prepare("SELECT mtime_ms, size_bytes FROM scan_file_state WHERE path = ?");
    const setFileState = this.db.prepare("INSERT OR REPLACE INTO scan_file_state (path, mtime_ms, size_bytes) VALUES (?, ?, ?)");
    const insertRecord = this.db.prepare(`
      INSERT OR REPLACE INTO usage_records (
        agent, session_id, message_key, timestamp_ms, date, raw_model_id, model_id, canonical_model_id,
        company, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        total_tokens, cost, unpriced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const getSnapshot = this.db.prepare("SELECT input_cost, output_cost, cache_read_cost, cache_write_cost FROM daily_pricing_snapshots WHERE date = ? AND model_id = ?");
    const insertSnapshot = this.db.prepare("INSERT OR IGNORE INTO daily_pricing_snapshots (date, model_id, input_cost, output_cost, cache_read_cost, cache_write_cost) VALUES (?, ?, ?, ?, ?, ?)");

    const priceCache = new Map<string, { price: ModelPrice | null }>();

    const resolvePrice = (date: string, modelId: string): ModelPrice | null => {
      const canon = canonical(modelId);
      const cacheKey = `${date}:${canon}`;
      if (priceCache.has(cacheKey)) return priceCache.get(cacheKey)!.price;

      const snapRow: any = getSnapshot.get(date, canon);
      if (snapRow) {
        const p: ModelPrice = {
          inputCostPerToken: snapRow.input_cost,
          outputCostPerToken: snapRow.output_cost,
          cacheReadCostPerToken: snapRow.cache_read_cost ?? undefined,
          cacheWriteCostPerToken: snapRow.cache_write_cost ?? undefined,
          source: "snapshot",
        };
        priceCache.set(cacheKey, { price: p });
        return p;
      }

      const freshPrice = pricing.getPrice(canon);
      if (freshPrice) {
        insertSnapshot.run(date, canon, freshPrice.inputCostPerToken, freshPrice.outputCostPerToken, freshPrice.cacheReadCostPerToken ?? null, freshPrice.cacheWriteCostPerToken ?? null);
        priceCache.set(cacheKey, { price: freshPrice });
        return freshPrice;
      }

      priceCache.set(cacheKey, { price: null });
      return null;
    };

    const processRecords = this.db.transaction((records: RawUsageRecord[]) => {
      for (const r of records) {
        const p = resolvePrice(r.date, r.canonicalModelId);
        let cost = 0;
        let unpriced = 1;
        if (p) {
          unpriced = 0;
          const inpCost = r.inputTokens * p.inputCostPerToken;
          const outCost = r.outputTokens * p.outputCostPerToken;
          const crCost = r.cacheReadTokens * (p.cacheReadCostPerToken ?? (p.inputCostPerToken * 0.1));
          const cwCost = r.cacheWriteTokens * (p.cacheWriteCostPerToken ?? (p.inputCostPerToken * 1.25));
          cost = inpCost + outCost + crCost + cwCost;
        }

        insertRecord.run(
          r.agent,
          r.sessionId,
          r.messageKey,
          r.timestampMs,
          r.date,
          r.rawModelId ?? r.modelId,
          r.modelId,
          r.canonicalModelId,
          r.company,
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
      switch (item.agent) {
        case "claude":
          rawRecords = scanClaudeFile(item.path);
          break;
        case "codex":
          rawRecords = scanCodexFile(item.path);
          break;
        case "agy":
          rawRecords = scanAntigravityDb(item.path);
          break;
        case "agy-cache":
          rawRecords = scanAntigravityCacheDb(item.path);
          break;
        case "opencode":
          rawRecords = scanOpenCodeDb(item.path);
          break;
        case "pi":
          rawRecords = scanPiFile(item.path);
          break;
      }

      if (rawRecords.length > 0) {
        processRecords(rawRecords);
        recordsAdded += rawRecords.length;
      }

      setFileState.run(item.path, fingerprintMtime, fingerprintSize);
    }

    if (pricing.arePricesAvailable()) {
      this.repairAntigravityRecords(pricing);
    }

    return { scannedFiles, recordsAdded };
  }

  public repairAntigravityRecords(pricing: PricingManager): number {
    const unpricedRows: any[] = this.db.query(`
      SELECT agent, message_key, date, raw_model_id, model_id, canonical_model_id,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
      FROM usage_records
      WHERE agent = 'agy' AND (
        unpriced = 1 OR
        canonical_model_id LIKE '%-n' OR
        canonical_model_id LIKE '%-a' OR
        canonical_model_id = 'gemini-default' OR
        canonical_model_id LIKE '%-trial'
      )
    `).all();

    if (unpricedRows.length === 0) return 0;

    let repaired = 0;
    const update = this.db.prepare(`
      UPDATE usage_records
      SET raw_model_id = ?, model_id = ?, canonical_model_id = ?, company = ?, cost = ?, unpriced = ?
      WHERE agent = ? AND message_key = ?
    `);

    this.db.transaction(() => {
      for (const row of unpricedRows) {
        const resolved = resolveAntigravityModel(row.raw_model_id, row.model_id);
        const canon = resolved.canonicalModelId;
        const p = pricing.getPrice(canon);
        let cost = 0;
        let unpriced = 1;
        if (p) {
          unpriced = 0;
          const inpCost = row.input_tokens * p.inputCostPerToken;
          const outCost = row.output_tokens * p.outputCostPerToken;
          const crCost = row.cache_read_tokens * (p.cacheReadCostPerToken ?? (p.inputCostPerToken * 0.1));
          const cwCost = row.cache_write_tokens * (p.cacheWriteCostPerToken ?? (p.inputCostPerToken * 1.25));
          cost = inpCost + outCost + crCost + cwCost;
        }
        update.run(
          resolved.rawModelId,
          resolved.modelId,
          canon,
          detectCompany(canon, "agy"),
          cost,
          unpriced,
          row.agent,
          row.message_key
        );
        repaired++;
      }
    })();

    return repaired;
  }

  public async rebuildAll(pricing: PricingManager): Promise<{ scannedFiles: number; recordsAdded: number }> {
    this.db.run("DELETE FROM usage_records;");
    this.db.run("DELETE FROM scan_file_state;");
    this.db.run("DELETE FROM daily_pricing_snapshots;");
    this.db.run("VACUUM;");
    return this.scanIncremental(pricing);
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
    pricesAvailable: boolean
  ): UsageGetPayload {
    const agentsList = req.agents;
    const placeholders = agentsList.map(() => "?").join(",");

    // First day
    const firstDay = this.getFirstDay(agentsList);
    if (req.preset === "all" && firstDay) {
      resolvedRange = resolveRange("all", today, { firstDay });
    }

    // Totals for range
    const totalsRow: any = this.db
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
      .get(...agentsList, resolvedRange.from, resolvedRange.to);

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

    // Days summary
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

    const days: UsageDaySummary[] = dayRows.map((r) => ({
      date: r.date,
      cost: Number(r.cost.toFixed(4)),
      tokens: Number(r.tokens),
      input: Number(r.input),
      output: Number(r.output),
      cacheRead: Number(r.cache_read),
      cacheWrite: Number(r.cache_write),
      messages: Number(r.messages),
      sessions: Number(r.sessions),
    }));

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
      scannedAt: this.now(),
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
