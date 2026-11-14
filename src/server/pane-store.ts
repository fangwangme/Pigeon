import { EventEmitter } from "node:events";
import { watch, type FSWatcher, existsSync } from "node:fs";
import type { AgentAdapterManager } from "./agent-adapters/index";
import type { NormalizedTurn, SessionStats, TodoItem } from "../shared/agent-session";
import type { NormalizedTurnsPayload, SessionInfo, TurnsDeltaPayload } from "../types/protocol";

export type { TurnsDeltaPayload } from "../types/protocol";

export interface PaneSessionState {
  paneId: string;
  agent: string;
  sessionId: string;
  turns: NormalizedTurn[];
  seqWatermark: number;
  stats?: SessionStats;
  sessionTitle?: string;
  todos?: TodoItem[];
  model?: string;
  watcher?: FSWatcher;
  reattachTimer?: ReturnType<typeof setTimeout>;
}

/** What Pigeon launched a pane with (`protocol.md` §4.5). */
export interface LaunchInfo {
  agent: string;
  modelId?: string;
  thinking?: string;
  resumeSessionId?: string;
}

/**
 * Per-pane structured sessions (`agent-session-normalization.md` §2.0, §4). Emits `turns_delta`
 * for changes inside a session and `session_changed` when a pane's binding changes.
 */
export class PaneStore extends EventEmitter {
  private paneStates = new Map<string, PaneSessionState>();
  private launches = new Map<string, LaunchInfo>();
  private adapters: AgentAdapterManager;
  private herdrConnected = false;
  private lastSyncTimestamp = Date.now();
  private modelResolver?: (agent: string, idOrLabel: string) => string;
  private watchDebounceMs: number;

  constructor(adapters: AgentAdapterManager, options: { watchDebounceMs?: number } = {}) {
    super();
    this.adapters = adapters;
    this.watchDebounceMs = options.watchDebounceMs ?? 100;
  }

  public setModelResolver(resolver: (agent: string, idOrLabel: string) => string): void {
    this.modelResolver = resolver;
  }

  public setHerdrStatus(connected: boolean): void {
    this.herdrConnected = connected;
    this.lastSyncTimestamp = Date.now();
    this.emit("upstream_status", this.getHerdrStatus());
  }

  public getHerdrStatus(): { herdrConnected: boolean; lastSyncTimestamp: number } {
    return { herdrConnected: this.herdrConnected, lastSyncTimestamp: this.lastSyncTimestamp };
  }

  public setLaunch(paneId: string, info: LaunchInfo): void {
    this.launches.set(paneId, info);
  }

  public getLaunch(paneId: string): LaunchInfo | undefined {
    return this.launches.get(paneId);
  }

  public sessionTitle(paneId: string): string | undefined {
    return this.paneStates.get(paneId)?.sessionTitle;
  }

  public boundSession(paneId: string): { agent: string; sessionId: string } | null {
    const s = this.paneStates.get(paneId);
    return s ? { agent: s.agent, sessionId: s.sessionId } : null;
  }

  public getSession(paneId: string): string | null {
    return this.boundSession(paneId)?.sessionId ?? null;
  }

  /** Binds a pane to a session; a different session replaces the old one. Returns whether it changed. */
  public registerPaneSession(paneId: string, agent: string, sessionId: string): boolean {
    const existing = this.paneStates.get(paneId);
    if (existing && existing.agent === agent && existing.sessionId === sessionId) {
      // A session can be bound before its file exists (claude writes it with the first prompt).
      if (!existing.watcher && this.watch(existing)) this.refreshPaneTurns(paneId, true);
      return false;
    }
    if (existing) this.release(existing);

    const state: PaneSessionState = { paneId, agent, sessionId, turns: [], seqWatermark: 0 };
    this.paneStates.set(paneId, state);
    this.refreshPaneTurns(paneId);
    this.watch(state);
    this.emit("session_changed", paneId);
    return true;
  }

  /** agent-session-normalization.md §4: log changes drive turn updates, debounced 100 ms. */
  private watch(state: PaneSessionState): boolean {
    const watchPath = this.adapters.getWatchPath(state.agent, state.sessionId);
    if (!watchPath || !existsSync(watchPath)) return false;
    state.watcher?.close();
    state.watcher = undefined;
    if (state.reattachTimer) {
      clearTimeout(state.reattachTimer);
      state.reattachTimer = undefined;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (this.paneStates.get(state.paneId) === state) {
          this.refreshPaneTurns(state.paneId, true);
        }
      }, this.watchDebounceMs);
    };
    const recover = () => {
      if (this.paneStates.get(state.paneId) !== state) return;
      state.watcher?.close();
      state.watcher = undefined;
      if (state.reattachTimer) clearTimeout(state.reattachTimer);
      let attempts = 0;
      const tryReattach = () => {
        if (this.paneStates.get(state.paneId) !== state) return;
        if (this.watch(state)) {
          scheduleRefresh();
          return;
        }
        if (++attempts < 20) {
          state.reattachTimer = setTimeout(tryReattach, 50);
        }
      };
      state.reattachTimer = setTimeout(tryReattach, 20);
    };
    try {
      const watcher = watch(watchPath, (eventType) => {
        scheduleRefresh();
        if (eventType === "rename") {
          recover();
        }
      });
      watcher.on("error", () => recover());
      state.watcher = watcher;
      return true;
    } catch {
      return false;
    }
  }

  public unbind(paneId: string): void {
    const state = this.paneStates.get(paneId);
    if (!state) return;
    this.release(state);
    this.paneStates.delete(paneId);
    this.emit("session_changed", paneId);
    if (state.sessionTitle) this.emit("title_changed", paneId);
  }

  private release(state: PaneSessionState): void {
    if (state.reattachTimer) {
      clearTimeout(state.reattachTimer);
      state.reattachTimer = undefined;
    }
    state.watcher?.close();
    state.watcher = undefined;
    this.adapters.forget(state.agent, state.sessionId);
  }

  /**
   * Re-reads a pane's session. The first read after binding is full; reads triggered by the log
   * watcher are incremental (`agent-session-normalization.md` §4).
   */
  private refreshPaneTurns(paneId: string, incremental = false): void {
    const state = this.paneStates.get(paneId);
    if (!state || !this.adapters.isSupported(state.agent)) return;

    let result: ReturnType<AgentAdapterManager["getTurns"]>;
    try {
      result = this.adapters.getTurns(state.agent, state.sessionId, incremental);
    } catch (err) {
      console.error(`[pigeon] reading ${state.agent} session ${state.sessionId} failed:`, err);
      return;
    }
    // Builders mutate their turns in place, so compare against a snapshot of the previous read.
    const oldTurns = state.turns;
    const turns = structuredClone(result.turns);
    const oldInfo = JSON.stringify([state.todos, state.model]);
    state.turns = turns;
    state.stats = result.stats;
    const titleChanged = state.sessionTitle !== result.sessionTitle;
    state.sessionTitle = result.sessionTitle;
    if (titleChanged) this.emit("title_changed", paneId);
    state.todos = result.todos;
    const oldModel = state.model;
    const resolvedModel = result.model ? (this.modelResolver ? this.modelResolver(state.agent, result.model) : result.model) : undefined;
    state.model = resolvedModel;
    if (state.model && state.model !== oldModel) this.emit("session_model", state.agent, state.model);
    const infoChanged = oldInfo !== JSON.stringify([state.todos, state.model]);
    const extra = {
      sessionStats: result.stats,
      sessionTitle: result.sessionTitle,
      ...(infoChanged ? { todos: result.todos, session: this.sessionInfo(paneId, state.agent) } : {}),
    };

    const oldLen = oldTurns.length;
    const newLen = turns.length;
    const same = (a: NormalizedTurn | undefined, b: NormalizedTurn | undefined) => JSON.stringify(a) === JSON.stringify(b);
    let delta: TurnsDeltaPayload | null = null;
    if (oldLen === 0 || newLen < oldLen) {
      state.seqWatermark += 1;
      delta = { paneId, seq: state.seqWatermark, seqWatermark: state.seqWatermark, sinceTurnIndex: 0, appendTurns: turns, ...extra };
    } else if (newLen > oldLen) {
      state.seqWatermark += 1;
      const patch = same(oldTurns[oldLen - 1], turns[oldLen - 1]) ? undefined : turns[oldLen - 1];
      delta = { paneId, seq: state.seqWatermark, seqWatermark: state.seqWatermark, sinceTurnIndex: oldLen, appendTurns: turns.slice(oldLen), ...(patch ? { patchLastTurn: patch } : {}), ...extra };
    } else if (!same(oldTurns[oldLen - 1], turns[newLen - 1]) || infoChanged) {
      state.seqWatermark += 1;
      delta = { paneId, seq: state.seqWatermark, seqWatermark: state.seqWatermark, sinceTurnIndex: oldLen - 1, appendTurns: [], patchLastTurn: turns[newLen - 1], isStreaming: true, ...extra };
    }
    if (delta) this.emit("turns_delta", delta);
  }

  /** `protocol.md` §5.6: the current values and where they come from. */
  public sessionInfo(paneId: string, agent: string | null): SessionInfo {
    const state = this.paneStates.get(paneId);
    const launch = this.launches.get(paneId);
    const model = state?.model
      ? { value: state.model, source: "log" as const }
      : launch?.modelId
        ? { value: launch.modelId, source: "launch" as const }
        : { value: null, source: "unknown" as const };
    const thinking = launch?.thinking ? { value: launch.thinking, source: "launch" as const } : { value: null, source: "unknown" as const };
    return {
      bound: !!state,
      agent: state?.agent ?? agent,
      ...(state ? { sessionId: state.sessionId } : {}),
      model,
      thinking,
    };
  }

  public getPayload(paneId: string, agent: string | null): NormalizedTurnsPayload {
    const state = this.paneStates.get(paneId);
    return {
      paneId,
      seq: state?.seqWatermark ?? 0,
      turns: state?.turns ?? [],
      ...(state?.stats ? { sessionStats: state.stats } : {}),
      ...(state?.sessionTitle ? { sessionTitle: state.sessionTitle } : {}),
      ...(state?.todos ? { todos: state.todos } : {}),
      session: this.sessionInfo(paneId, agent),
    };
  }

  public getPaneState(paneId: string): PaneSessionState | undefined {
    return this.paneStates.get(paneId);
  }

  public closePane(paneId: string): void {
    const state = this.paneStates.get(paneId);
    if (state) this.release(state);
    this.paneStates.delete(paneId);
    this.launches.delete(paneId);
  }

  public trackedPaneIds(): string[] {
    return Array.from(new Set([...this.paneStates.keys(), ...this.launches.keys()]));
  }

  public destroy(): void {
    for (const state of this.paneStates.values()) {
      if (state.reattachTimer) clearTimeout(state.reattachTimer);
      state.watcher?.close();
    }
    this.paneStates.clear();
  }
}
