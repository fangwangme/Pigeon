import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OPENCODE_PLACEHOLDER_TITLE, OpenCodeAdapter, type OpenCodeAdapterOptions } from "./opencode";
import { AgyAdapter, agyModelSetting, type AgyAdapterOptions } from "./agy";
import { isObj, readHeadJsonLines, readTailJsonLines } from "../sessions/common";
import { ClaudeSource } from "../sessions/claude";
import { CodexSource } from "../sessions/codex";
import { PiSource } from "../sessions/pi";
import type { SessionRead } from "../sessions/common";
import { openFilesOf } from "../sessions/process-files";
import type { PaneFacts, SessionSource } from "../sessions/source";
import type { PastSession } from "../../types/protocol";

export type { PaneFacts } from "../sessions/source";

export interface AgentAdapterManagerOptions {
  /** Root under which every agent keeps its store (`~` by default). */
  home?: string;
  opencode?: OpenCodeAdapterOptions;
  agy?: AgyAdapterOptions;
}

/**
 * AGY: brain folders carry no project folder, so without an open file only time binds
 * (`agent-session-normalization.md` §2.2).
 */
class AgySource implements SessionSource {
  public readonly agent = "agy";
  private presenceDir: string;
  private realPresenceDir: string;
  private realBrainDir: string;

  constructor(private adapter: AgyAdapter, private brainDir: string) {
    this.presenceDir = join(dirname(brainDir), "presence");
    try {
      this.realPresenceDir = realpathSync(this.presenceDir);
    } catch {
      this.realPresenceDir = this.presenceDir;
    }
    try {
      this.realBrainDir = realpathSync(brainDir);
    } catch {
      this.realBrainDir = brainDir;
    }
  }

  public sessionOfFile(path: string): string | null {
    const inPresence = path.startsWith(this.presenceDir + "/")
      ? this.presenceDir
      : path.startsWith(this.realPresenceDir + "/")
      ? this.realPresenceDir
      : null;
    if (inPresence && path.endsWith(".lock")) {
      return path.slice(inPresence.length + 1, -".lock".length) || null;
    }
    const inBrain = path.startsWith(this.brainDir + "/")
      ? this.brainDir
      : path.startsWith(this.realBrainDir + "/")
      ? this.realBrainDir
      : null;
    if (!inBrain || !/\/\.system_generated\/logs\/transcript(_full)?\.jsonl$/.test(path)) return null;
    return path.slice(inBrain.length + 1).split("/")[0] || null;
  }
  public lastWritten(sessionId: string): number | null {
    const log = this.adapter.getSessionLogPath(sessionId);
    return existsSync(log) ? statSync(log).mtimeMs : null;
  }
  public newest(facts: PaneFacts, exclude: Set<string>): string | null {
    if (!existsSync(this.brainDir)) return null;
    let best: { id: string; mtime: number } | null = null;
    for (const id of readdirSync(this.brainDir)) {
      if (exclude.has(id)) continue;
      const log = this.adapter.getSessionLogPath(id);
      if (!existsSync(log)) continue;
      const mtime = statSync(log).mtimeMs;
      if (mtime >= facts.createdMs && (!best || mtime > best.mtime)) best = { id, mtime };
    }
    return best?.id ?? null;
  }
  public watchPath(id: string): string {
    return this.adapter.getSessionLogPath(id);
  }
  public read(id: string, incremental: boolean): SessionRead {
    return this.adapter.getTurns(id, incremental);
  }
  public forget(id: string): void {
    this.adapter.resetCache(id);
  }
  public list(folder: string): PastSession[] {
    const dbPath = join(dirname(this.brainDir), "conversation_summaries.db");
    if (!existsSync(dbPath)) return [];
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        db.run("PRAGMA query_only = ON;");
        db.run("PRAGMA busy_timeout = 2000;");
        const rows = db.query<{
          conversation_id: string;
          title: string;
          preview: string;
          last_modified_time: string;
          workspace_uris: string;
          nesting_depth: number;
        }, []>(
          "SELECT conversation_id, title, preview, last_modified_time, workspace_uris, nesting_depth FROM conversation_summaries WHERE nesting_depth = 0 ORDER BY last_modified_time DESC"
        ).all();

        const targetUri = "file://" + (folder.endsWith("/") ? folder.slice(0, -1) : folder);
        const out: PastSession[] = [];
        for (const r of rows) {
          let uris: string[] = [];
          try {
            uris = JSON.parse(r.workspace_uris);
          } catch {
            continue;
          }
          if (!Array.isArray(uris)) continue;
          const matches = uris.some((u) => typeof u === "string" && (u === targetUri || u.startsWith(targetUri + "/")));
          if (!matches) continue;

          let ts: number;
          try {
            ts = Date.parse(r.last_modified_time);
            if (Number.isNaN(ts)) ts = Date.parse(r.last_modified_time.replace(" ", "T"));
          } catch {
            ts = 0;
          }

          // agent-session-normalization.md §2.6: the latest setting in the first and last 256 KB.
          let model: string | undefined = undefined;
          const logPath = this.adapter.getSessionLogPath(r.conversation_id);
          if (existsSync(logPath)) {
            const size = statSync(logPath).size;
            const records = size > 524_288 ? [...readHeadJsonLines(logPath), ...readTailJsonLines(logPath)] : readHeadJsonLines(logPath, size + 1);
            for (const rec of records) {
              const found = isObj(rec) && typeof rec.content === "string" ? agyModelSetting(rec.content) : undefined;
              if (found) model = found;
            }
          }

          out.push({
            id: r.conversation_id,
            title: r.title ? r.title : r.preview,
            updatedAt: ts,
            ...(model ? { model } : {}),
          });
          if (out.length >= 50) break;
        }
        return out;
      } finally {
        db.close();
      }
    } catch (err) {
      // agent-session-normalization.md §2.6: AGY's own database, locked or changed, degrades only this list.
      console.warn("[pigeon] agy session list unavailable:", err);
      return [];
    }
  }
}

/** OpenCode: sessions are rows of `session_v2` or legacy `session` (`agent-session-normalization.md` §2.1). */
class OpenCodeSource implements SessionSource {
  public readonly agent = "opencode";
  constructor(private adapter: OpenCodeAdapter) {}
  public newest(facts: PaneFacts, exclude: Set<string>): string | null {
    if (!facts.cwd) return null;
    const rows =
      this.adapter.withDb((db, table) =>
        db
          .query(`SELECT id FROM ${table} WHERE directory = ? AND time_updated >= ? ORDER BY time_updated DESC LIMIT 20`)
          .all(facts.cwd!, facts.createdMs) as Array<{ id: string }>
      ) ?? [];
    return rows.find((r) => !exclude.has(r.id))?.id ?? null;
  }
  public lastWritten(sessionId: string): number | null {
    return (
      this.adapter.withDb(
        (db, table) =>
          (db.query(`SELECT time_updated FROM ${table} WHERE id = ?`).get(sessionId) as { time_updated?: number } | null)
            ?.time_updated ?? null
      ) ?? null
    );
  }
  public watchPath(): string {
    return `${this.adapter.getDbPath()}-wal`;
  }
  private firstPrompt(db: Database, sessionId: string): string | undefined {
    const row = db
      .query("SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq ASC, time_created ASC LIMIT 1")
      .get(sessionId) as { data: string } | undefined;
    if (!row) return undefined;
    try {
      const data = JSON.parse(row.data);
      const text = typeof data.text === "string" ? data.text : typeof data.content === "string" ? data.content : "";
      return text.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  /** §2.1: the latest assistant message names the model as `{ providerID, id }`. */
  private model(db: Database, sessionId: string): string | undefined {
    const row = db
      .query(
        "SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC, time_created DESC LIMIT 1"
      )
      .get(sessionId) as { data: string } | undefined;
    if (!row) return undefined;
    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      return undefined; // a record that is not JSON is skipped (§1)
    }
    const model = (data as any)?.model;
    return typeof model?.providerID === "string" && typeof model?.id === "string" ? `${model.providerID}/${model.id}` : undefined;
  }
  public read(id: string, incremental = false): SessionRead {
    return this.adapter.getTurns(id, incremental);
  }
  public forget(): void {}
  public list(folder: string): PastSession[] {
    return (
      this.adapter.withDb((db, table) => {
        const rows = db
          .query(
            `SELECT id, title, time_updated FROM ${table} WHERE (directory = ? OR directory LIKE ?) AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 50`
          )
          .all(folder, `${folder}/%`) as Array<{ id: string; title: string | null; time_updated: number }>;
        return rows.map((r) => {
          const isPlaceholder = r.title ? OPENCODE_PLACEHOLDER_TITLE.test(r.title) : false;
          const effectiveTitle = (!isPlaceholder && r.title) || this.firstPrompt(db, r.id) || r.id;
          const m = this.model(db, r.id);
          return { id: r.id, title: effectiveTitle.slice(0, 120), updatedAt: r.time_updated, ...(m ? { model: m } : {}) };
        });
      }) ?? []
    );
  }
}

/** Every agent's session store behind one interface (`agent-session-normalization.md` §2). */
export class AgentAdapterManager {
  private sources = new Map<string, SessionSource>();
  private sourceErrors = new Map<string, { agent: string; op: string; message: string; at: number }>();

  constructor(options: AgentAdapterManagerOptions = {}) {
    const home = options.home ?? homedir();
    // agent-session-normalization.md §2.1: the adapter resolves `$XDG_DATA_HOME`; an explicit home means that home.
    const opencode = new OpenCodeAdapter(options.opencode ?? (options.home === undefined ? {} : { dbPath: join(home, ".local", "share", "opencode", "opencode.db") }));
    const brainDir = options.agy?.baseBrainDir ?? join(home, ".gemini", "antigravity-cli", "brain");
    const agy = new AgyAdapter({ baseBrainDir: brainDir });
    for (const s of [new ClaudeSource(home), new CodexSource(home), new PiSource(home), new AgySource(agy, brainDir), new OpenCodeSource(opencode)]) {
      this.sources.set(s.agent, s);
    }
  }

  public getSourceErrors(): Array<{ agent: string; op: string; message: string; at: number }> {
    return Array.from(this.sourceErrors.values());
  }

  private callSource<T>(agent: string, op: string, fallback: T, fn: (source: SessionSource) => T): T {
    const normalized = agent.toLowerCase();
    const source = this.sources.get(normalized);
    if (!source) return fallback;
    const key = `${normalized}:${op}`;
    try {
      const value = fn(source);
      this.sourceErrors.delete(key);
      return value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sourceErrors.set(key, { agent: normalized, op, message, at: Date.now() });
      console.error(`[pigeon] ${normalized} source error (${op}):`, err);
      return fallback;
    }
  }

  public isSupported(agent: string): boolean {
    return this.sources.has(agent.toLowerCase());
  }

  /**
   * §2.0 rule 1: the exact session, when the agent records one for its process (claude), else the
   * session file the process or a descendant holds open.
   */
  public exactSession(facts: PaneFacts): string | null {
    return this.callSource(facts.agent, "exact", null, (source) => {
      if (source.exact) return source.exact(facts);
      if (!source.sessionOfFile || !facts.pid) return null;
      for (const file of openFilesOf(facts.pid)) {
        const id = source.sessionOfFile(file);
        if (id) return id;
      }
      return null;
    });
  }

  /** §2.0 rule 6: when the session was last written. */
  public lastWritten(agent: string, sessionId: string): number | null {
    return this.callSource(agent, "lastWritten", null, (source) => source.lastWritten(sessionId));
  }

  /** §2.0 rule 2. */
  public newestSession(facts: PaneFacts, exclude: Set<string>): string | null {
    return this.callSource(facts.agent, "newest", null, (source) => source.newest(facts, exclude));
  }

  public getTurns(agent: string, sessionId: string, incremental = false): SessionRead {
    return this.callSource(agent, "read", { turns: [] }, (source) => source.read(sessionId, incremental));
  }

  /** File whose changes mean the session has new records; watched instead of polling. */
  public getWatchPath(agent: string, sessionId: string): string | null {
    return this.callSource(agent, "watchPath", null, (source) => source.watchPath(sessionId));
  }

  public forget(agent: string, sessionId: string): void {
    this.callSource(agent, "forget", undefined, (source) => source.forget(sessionId));
  }

  public listSessions(agent: string, folder: string): PastSession[] {
    return this.callSource(agent, "list", [], (source) => source.list(folder));
  }

  public resumeTarget(agent: string, sessionId: string, folder: string): string | null {
    return this.callSource(agent, "resumeTarget", sessionId, (source) =>
      source.resumeTarget ? source.resumeTarget(sessionId, folder) : sessionId
    );
  }
}
