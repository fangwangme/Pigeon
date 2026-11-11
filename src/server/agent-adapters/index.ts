import { Database } from "bun:sqlite";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from "./opencode";
import { AgyAdapter, type AgyAdapterOptions } from "./agy";
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
  public list(): PastSession[] {
    return [];
  }
}

/** OpenCode: sessions are rows of `session_v2` (`agent-session-normalization.md` §2.1). */
const OPENCODE_PLACEHOLDER_TITLE = /^New session - \d{4}-\d{2}-\d{2}T/;

class OpenCodeSource implements SessionSource {
  public readonly agent = "opencode";
  constructor(private adapter: OpenCodeAdapter) {}
  private query<T>(sql: string, ...params: any[]): T[] {
    if (!this.adapter.isAvailable()) return [];
    const db = new Database(this.adapter.getDbPath(), { readonly: true });
    try {
      db.run("PRAGMA query_only = ON;");
      db.run("PRAGMA busy_timeout = 2000;");
      return db.query(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  }
  public newest(facts: PaneFacts, exclude: Set<string>): string | null {
    if (!facts.cwd) return null;
    const rows = this.query<{ id: string }>(
      "SELECT id FROM session_v2 WHERE directory = ? AND time_updated >= ? ORDER BY time_updated DESC LIMIT 20",
      facts.cwd,
      facts.createdMs
    );
    return rows.find((r) => !exclude.has(r.id))?.id ?? null;
  }
  public lastWritten(sessionId: string): number | null {
    return this.query<{ time_updated: number }>("SELECT time_updated FROM session_v2 WHERE id = ?", sessionId)[0]?.time_updated ?? null;
  }
  public watchPath(): string {
    return `${this.adapter.getDbPath()}-wal`;
  }
  private firstPrompt(sessionId: string): string | undefined {
    const row = this.query<{ data: string }>(
      "SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq ASC, time_created ASC LIMIT 1",
      sessionId
    )[0];
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
  private model(sessionId: string): string | undefined {
    const row = this.query<{ data: string }>(
      "SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC, time_created DESC LIMIT 1",
      sessionId
    )[0];
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
  public read(id: string): SessionRead {
    const rawTitle = this.query<{ title: string | null }>("SELECT title FROM session_v2 WHERE id = ?", id)[0]?.title;
    const isPlaceholder = rawTitle ? OPENCODE_PLACEHOLDER_TITLE.test(rawTitle) : false;
    const title = rawTitle && !isPlaceholder ? rawTitle : undefined;
    const model = this.model(id);
    return { ...this.adapter.getTurns(id), ...(title ? { sessionTitle: title } : {}), ...(model ? { model } : {}) };
  }
  public forget(): void {}
  public list(folder: string): PastSession[] {
    return this.query<{ id: string; title: string | null; time_updated: number }>(
      "SELECT id, title, time_updated FROM session_v2 WHERE (directory = ? OR directory LIKE ?) AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 50",
      folder,
      `${folder}/%`
    ).map((r) => {
      const isPlaceholder = r.title ? OPENCODE_PLACEHOLDER_TITLE.test(r.title) : false;
      const effectiveTitle = (!isPlaceholder && r.title) || this.firstPrompt(r.id) || r.id;
      return { id: r.id, title: effectiveTitle.slice(0, 120), updatedAt: r.time_updated };
    });
  }
}

/** Every agent's session store behind one interface (`agent-session-normalization.md` §2). */
export class AgentAdapterManager {
  private sources = new Map<string, SessionSource>();

  constructor(options: AgentAdapterManagerOptions = {}) {
    const home = options.home ?? homedir();
    const opencode = new OpenCodeAdapter(options.opencode ?? { dbPath: join(home, ".local", "share", "opencode", "opencode.db") });
    const brainDir = options.agy?.baseBrainDir ?? join(home, ".gemini", "antigravity-cli", "brain");
    const agy = new AgyAdapter({ baseBrainDir: brainDir });
    for (const s of [new ClaudeSource(home), new CodexSource(home), new PiSource(home), new AgySource(agy, brainDir), new OpenCodeSource(opencode)]) {
      this.sources.set(s.agent, s);
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
    const source = this.sources.get(facts.agent);
    if (!source) return null;
    if (source.exact) return source.exact(facts);
    if (!source.sessionOfFile || !facts.pid) return null;
    for (const file of openFilesOf(facts.pid)) {
      const id = source.sessionOfFile(file);
      if (id) return id;
    }
    return null;
  }

  /** §2.0 rule 6: when the session was last written. */
  public lastWritten(agent: string, sessionId: string): number | null {
    return this.sources.get(agent)?.lastWritten(sessionId) ?? null;
  }

  /** §2.0 rule 2. */
  public newestSession(facts: PaneFacts, exclude: Set<string>): string | null {
    return this.sources.get(facts.agent)?.newest(facts, exclude) ?? null;
  }

  public getTurns(agent: string, sessionId: string, incremental = false): SessionRead {
    const source = this.sources.get(agent.toLowerCase());
    return source ? source.read(sessionId, incremental) : { turns: [] };
  }

  /** File whose changes mean the session has new records; watched instead of polling. */
  public getWatchPath(agent: string, sessionId: string): string | null {
    return this.sources.get(agent.toLowerCase())?.watchPath(sessionId) ?? null;
  }

  public forget(agent: string, sessionId: string): void {
    this.sources.get(agent.toLowerCase())?.forget(sessionId);
  }

  public listSessions(agent: string, folder: string): PastSession[] {
    return this.sources.get(agent.toLowerCase())?.list(folder) ?? [];
  }

  public resumeTarget(agent: string, sessionId: string, folder: string): string | null {
    const source = this.sources.get(agent.toLowerCase());
    return source?.resumeTarget ? source.resumeTarget(sessionId, folder) : sessionId;
  }
}
