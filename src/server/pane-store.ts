import { EventEmitter } from "node:events";
import { watch, type FSWatcher, existsSync } from "node:fs";
import type { AgentAdapterManager } from "./agent-adapters/index";
import type { NormalizedTurn, SessionStats } from "../shared/agent-session";

export interface PaneSessionState {
  paneId: string;
  agent: string;
  sessionId: string;
  turns: NormalizedTurn[];
  seqWatermark: number;
  stats?: SessionStats;
  sessionTitle?: string;
  watcher?: FSWatcher;
}

export interface TurnsDeltaPayload {
  paneId: string;
  seqWatermark: number;
  sinceTurnIndex: number;
  appendTurns: NormalizedTurn[];
  patchLastTurn?: NormalizedTurn;
  sessionStats?: SessionStats;
  sessionTitle?: string;
  isStreaming?: boolean;
}

export class PaneStore extends EventEmitter {
  private paneStates = new Map<string, PaneSessionState>();
  private adapters: AgentAdapterManager;
  private herdrConnected = false;
  private lastSyncTimestamp = Date.now();

  constructor(adapters: AgentAdapterManager) {
    super();
    this.adapters = adapters;
  }

  public setHerdrStatus(connected: boolean): void {
    this.herdrConnected = connected;
    this.lastSyncTimestamp = Date.now();
    this.emit("upstream_status", {
      herdrConnected: this.herdrConnected,
      lastSyncTimestamp: this.lastSyncTimestamp,
    });
  }

  public getHerdrStatus(): { herdrConnected: boolean; lastSyncTimestamp: number } {
    return {
      herdrConnected: this.herdrConnected,
      lastSyncTimestamp: this.lastSyncTimestamp,
    };
  }

  public registerPaneSession(paneId: string, agent: string, sessionId: string): void {
    const existing = this.paneStates.get(paneId);
    if (existing && existing.agent === agent && existing.sessionId === sessionId) {
      return;
    }

    existing?.watcher?.close();

    const state: PaneSessionState = {
      paneId,
      agent,
      sessionId,
      turns: [],
      seqWatermark: 0,
    };
    this.paneStates.set(paneId, state);

    this.refreshPaneTurns(paneId);

    // Log changes drive turn updates directly instead of riding on screen polls.
    const watchPath = this.adapters.getWatchPath(agent, sessionId);
    if (watchPath && existsSync(watchPath)) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      state.watcher = watch(watchPath, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => this.refreshPaneTurns(paneId, true), 100);
      });
    }
  }

  /**
   * Re-reads a pane's session. The first read after registration is full; reads triggered by the
   * log watcher are incremental so appends cost only the new bytes (agent-session-normalization.md §5).
   */
  public refreshPaneTurns(paneId: string, incremental = false): void {
    const state = this.paneStates.get(paneId);
    if (!state || !this.adapters.isSupported(state.agent)) return;

    let result: ReturnType<AgentAdapterManager["getTurns"]>;
    try {
      result = this.adapters.getTurns(state.agent, state.sessionId, incremental);
    } catch (err) {
      console.error(`[pigeon] reading ${state.agent} session ${state.sessionId} failed:`, err);
      return;
    }
    {
      const { turns, stats, sessionTitle } = result;

      const oldTurns = state.turns;
      const oldLen = oldTurns.length;
      const newLen = turns.length;

      state.turns = turns;
      state.stats = stats;
      state.sessionTitle = sessionTitle;
      state.seqWatermark += 1;

      // Calculate delta
      if (oldLen === 0) {
        // First broadcast full or delta from 0
        const delta: TurnsDeltaPayload = {
          paneId,
          seqWatermark: state.seqWatermark,
          sinceTurnIndex: 0,
          appendTurns: turns,
          sessionStats: stats,
          sessionTitle,
        };
        this.emit("turns_delta", delta);
      } else if (newLen > oldLen) {
        // Check if last turn in old was updated or if new turns were appended
        const lastOldTurn = oldTurns[oldLen - 1];
        const correspondingTurnInNew = turns[oldLen - 1];
        let patchLastTurn: NormalizedTurn | undefined;

        if (JSON.stringify(lastOldTurn) !== JSON.stringify(correspondingTurnInNew)) {
          patchLastTurn = correspondingTurnInNew;
        }

        const appendTurns = turns.slice(oldLen);
        const delta: TurnsDeltaPayload = {
          paneId,
          seqWatermark: state.seqWatermark,
          sinceTurnIndex: oldLen,
          appendTurns,
          patchLastTurn,
          sessionStats: stats,
          sessionTitle,
        };
        this.emit("turns_delta", delta);
      } else if (newLen === oldLen) {
        // Check if last turn changed (e.g. streaming update)
        const lastOldTurn = oldTurns[oldLen - 1];
        const lastNewTurn = turns[newLen - 1];
        if (JSON.stringify(lastOldTurn) !== JSON.stringify(lastNewTurn)) {
          const delta: TurnsDeltaPayload = {
            paneId,
            seqWatermark: state.seqWatermark,
            sinceTurnIndex: oldLen - 1,
            appendTurns: [],
            patchLastTurn: lastNewTurn,
            sessionStats: stats,
            sessionTitle,
            isStreaming: true,
          };
          this.emit("turns_delta", delta);
        }
      } else {
        // Reset/truncation: broadcast full
        const delta: TurnsDeltaPayload = {
          paneId,
          seqWatermark: state.seqWatermark,
          sinceTurnIndex: 0,
          appendTurns: turns,
          sessionStats: stats,
          sessionTitle,
        };
        this.emit("turns_delta", delta);
      }
    }
  }

  public getPaneTurns(paneId: string): { turns: NormalizedTurn[]; stats?: SessionStats; sessionTitle?: string; seqWatermark: number } {
    const state = this.paneStates.get(paneId);
    if (!state) return { turns: [], seqWatermark: 0 };
    return {
      turns: state.turns,
      stats: state.stats,
      sessionTitle: state.sessionTitle,
      seqWatermark: state.seqWatermark,
    };
  }

  public closePane(paneId: string): void {
    this.paneStates.get(paneId)?.watcher?.close();
    this.paneStates.delete(paneId);
  }

  public trackedPaneIds(): string[] {
    return Array.from(this.paneStates.keys());
  }

  public destroy(): void {
    for (const state of this.paneStates.values()) state.watcher?.close();
    this.paneStates.clear();
  }
}
