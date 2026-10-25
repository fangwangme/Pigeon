import { OpenCodeAdapter, type OpenCodeAdapterOptions } from "./opencode";
import { AgyAdapter, type AgyAdapterOptions } from "./agy";
import type { NormalizedTurn, SessionStats } from "../../shared/agent-session";

export interface AgentAdapterManagerOptions {
  opencode?: OpenCodeAdapterOptions;
  agy?: AgyAdapterOptions;
}

export class AgentAdapterManager {
  private opencode: OpenCodeAdapter;
  private agy: AgyAdapter;

  constructor(options: AgentAdapterManagerOptions = {}) {
    this.opencode = new OpenCodeAdapter(options.opencode);
    this.agy = new AgyAdapter(options.agy);
  }

  public isSupported(agent: string): boolean {
    const a = agent.toLowerCase();
    return a === "opencode" || a === "agy";
  }

  public getTurns(
    agent: string,
    sessionId: string,
    incremental = false
  ): { turns: NormalizedTurn[]; stats?: SessionStats; sessionTitle?: string } {
    const a = agent.toLowerCase();
    if (a === "opencode") {
      return this.opencode.getTurns(sessionId);
    }
    if (a === "agy") {
      return this.agy.getTurns(sessionId, incremental);
    }
    return { turns: [] };
  }

  /** File whose changes mean the session has new records; watched instead of polling. */
  public getWatchPath(agent: string, sessionId: string): string | null {
    const a = agent.toLowerCase();
    if (a === "agy") return this.agy.getSessionLogPath(sessionId);
    if (a === "opencode") return `${this.opencode.getDbPath()}-wal`;
    return null;
  }

  public getOpenCodeAdapter(): OpenCodeAdapter {
    return this.opencode;
  }

  public getAgyAdapter(): AgyAdapter {
    return this.agy;
  }
}
