import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from "./opencode";
import { AgyAdapter, type AgyAdapterOptions } from "./agy";
import { ClaudeSource } from "../sessions/claude";
import { CodexSource } from "../sessions/codex";
import { PiSource } from "../sessions/pi";
import type { SessionRead } from "../sessions/common";
import type { PaneFacts, SessionSource } from "../sessions/source";
import type { PastSession } from "../../types/protocol";

export type { PaneFacts } from "../sessions/source";

export interface AgentAdapterManagerOptions {
  /** Root under which every agent keeps its store (`~` by default). */
  home?: string;
  opencode?: OpenCodeAdapterOptions;
  agy?: AgyAdapterOptions;
}

/** AGY: brain folders carry no project folder, so only time binds (`agent-session-normalization.md` §2.2). */
class AgySource implements SessionSource {
  public readonly agent = "agy";
  constructor(private adapter: AgyAdapter, private brainDir: string) {}
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
  public read(id: string): SessionRead {
    const title = this.query<{ title: string | null }>("SELECT title FROM session_v2 WHERE id = ?", id)[0]?.title || this.firstPrompt(id)?.slice(0, 120);
    return { ...this.adapter.getTurns(id), ...(title ? { sessionTitle: title } : {}) };
  }
  public forget(): void {}
  public list(folder: string): PastSession[] {
    return this.query<{ id: string; title: string | null; time_updated: number }>(
      "SELECT id, title, time_updated FROM session_v2 WHERE (directory = ? OR directory LIKE ?) AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 50",
      folder,
      `${folder}/%`
    ).map((r) => ({ id: r.id, title: (r.title || this.firstPrompt(r.id) || r.id).slice(0, 120), updatedAt: r.time_updated }));
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

  /** §2.0 rule 1: the exact session, when the agent records one for its process. */
  public exactSession(facts: PaneFacts): string | null {
    return this.sources.get(facts.agent)?.exact?.(facts) ?? null;
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
