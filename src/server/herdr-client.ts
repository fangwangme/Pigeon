import { connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { CardClassifier, buildUnrecognizedPrompt } from "./card-classifier";
import { getAgentRecipe } from "./agent-recipes";
import type {
  AgentStatus,
  PaneStatePayload,
  SnapshotPayload,
  WorkspaceSummary,
  TabSummary,
  PaneSummary,
  WorkingAgentSummary,
} from "../types/protocol";
import type { HerdrSnapshotResult } from "../types/herdr";

export interface HerdrClientOptions {
  socketPath: string;
  debounceMs?: number;
  panePollMs?: number;
}

/** An error returned by Herdr (`{"error":{"code","message"}}`) or by the socket itself. */
export class HerdrError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "HerdrError";
  }
}

// Socket-level failures that mean Herdr is not reachable (as opposed to a rejected request).
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOENT", "ECONNRESET", "EPIPE"]);
const READ_LINES = 200;
const REQUEST_TIMEOUT_MS = 8000;
const SNAPSHOT_RECONCILE_MS = 30000;
const RECONNECT_MS = 3000;

const GLOBAL_SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "workspace.focused",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
];

interface KnownPane {
  workspaceId: string;
  tabId: string;
  agentKind: string | null;
  cwd: string | null;
  herdrStatus: AgentStatus;
}

export class HerdrClient extends EventEmitter {
  private socketPath: string;
  private debounceMs: number;
  private panePollMs: number;
  private subSocket: Socket | null = null;
  private subscribedStatusPanes = "";
  private connected = false;
  private stopped = true; // until connect(): nothing opens sockets or timers before then
  private requestId = 0;
  private classifier = new CardClassifier();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotPollTimer: ReturnType<typeof setInterval> | null = null;
  private panePollTimer: ReturnType<typeof setInterval> | null = null;

  // Settles every one-shot request still waiting, so disconnect() leaves no socket or timer behind.
  private pendingRequests = new Set<(err: Error) => void>();
  private paneStates = new Map<string, PaneStatePayload>();
  private paneContentHashes = new Map<string, string>();
  private paneReadsInFlight = new Map<string, Promise<PaneStatePayload>>();
  private paneDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Facts from the latest Herdr snapshot; rebuilt on every snapshot so closed panes drop out.
  private knownPanes = new Map<string, KnownPane>();
  private paneAgentSessions = new Map<string, { agent: string; sessionId: string }>();
  private currentSnapshot: SnapshotPayload = { workspaces: [], workingAgents: [] };
  private focusedPaneId: string | null = null;
  private monitoredPaneIds = new Set<string>();

  constructor(options: HerdrClientOptions) {
    super();
    this.socketPath = options.socketPath;
    this.debounceMs = options.debounceMs ?? 200;
    this.panePollMs = options.panePollMs ?? 1000;
  }

  public async connect(): Promise<void> {
    this.stopped = false;
    this.startSubscription();
    this.startPolling();
    try {
      await this.refreshSnapshot();
    } catch (err) {
      // Herdr offline at startup is an expected state; it surfaces as `upstream_status` and the
      // subscription loop keeps retrying.
      if (!(err instanceof HerdrError) || !UNREACHABLE_CODES.has(err.code)) throw err;
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.snapshotPollTimer = setInterval(() => {
      if (this.connected) this.refreshSnapshot().catch((err) => this.reportBackgroundError("session.snapshot", err));
    }, SNAPSHOT_RECONCILE_MS);

    // Herdr has no output-changed event, so the panes a client is looking at are polled;
    // unchanged screens are dropped by hash before classification.
    this.panePollTimer = setInterval(() => {
      if (!this.connected) return;
      for (const paneId of this.monitoredPaneIds) {
        if (!this.knownPanes.has(paneId)) continue;
        this.pollPane(paneId).catch((err) => this.reportBackgroundError("pane.read", err));
      }
    }, this.panePollMs);
  }

  private stopPolling(): void {
    if (this.snapshotPollTimer) clearInterval(this.snapshotPollTimer);
    if (this.panePollTimer) clearInterval(this.panePollTimer);
    this.snapshotPollTimer = null;
    this.panePollTimer = null;
  }

  /** Background poll failures: unreachable Herdr is reported through connection state; anything else is a bug. */
  private reportBackgroundError(method: string, err: unknown): void {
    if (err instanceof HerdrError && UNREACHABLE_CODES.has(err.code)) return;
    console.error(`[pigeon] Herdr ${method} failed:`, err);
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    this.emit(value ? "connected" : "disconnected");
  }

  public setMonitoredPanes(paneIds: Iterable<string>): void {
    this.monitoredPaneIds = new Set(paneIds);
  }

  public getMonitoredPaneIds(): string[] {
    return Array.from(this.monitoredPaneIds);
  }

  public getPaneAgentSession(paneId: string): { agent: string; sessionId: string } | null {
    return this.paneAgentSessions.get(paneId) || null;
  }

  public hasPane(paneId: string): boolean {
    return this.knownPanes.has(paneId);
  }

  public getPaneAgentKind(paneId: string): string | null {
    return this.knownPanes.get(paneId)?.agentKind ?? null;
  }

  public getPaneCwd(paneId: string): string | null {
    return this.knownPanes.get(paneId)?.cwd ?? null;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public disconnect(): void {
    this.stopped = true;
    this.stopPolling();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    for (const t of this.paneDebounceTimers.values()) clearTimeout(t);
    this.paneDebounceTimers.clear();
    this.reconnectTimer = null;
    this.snapshotTimer = null;
    this.subSocket?.destroy();
    this.subSocket = null;
    for (const cancel of Array.from(this.pendingRequests)) cancel(new HerdrError("closed", "Herdr client disconnected"));
    this.paneReadsInFlight.clear();
    this.setConnected(false);
  }

  /** One-shot Herdr RPC: a fresh connection per request, never on the subscription socket. */
  public request<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = `req_${++this.requestId}`;
      let buffer = "";
      let settled = false;
      const socket = connect(this.socketPath, () => {
        socket.write(JSON.stringify({ method, params, id }) + "\n");
      });

      const finish = (err: Error | null, result?: T) => {
        if (settled) return;
        settled = true;
        this.pendingRequests.delete(finish);
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(result as T);
      };

      const timer = setTimeout(() => {
        finish(new HerdrError("timeout", `Herdr request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.add(finish);

      const parse = () => {
        let res: any;
        try {
          res = JSON.parse(buffer.trim());
        } catch {
          return finish(new HerdrError("invalid_response", `Herdr returned malformed JSON for ${method}`));
        }
        this.setConnected(true);
        if (res.error) return finish(new HerdrError(res.error.code || "herdr_error", res.error.message || res.error.code));
        finish(null, res.result);
      };

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        if (buffer.includes("\n")) parse();
      });
      socket.on("end", () => {
        if (buffer.trim()) parse();
        else finish(new HerdrError("closed", `Herdr closed the connection without answering ${method}`));
      });
      socket.on("error", (err: NodeJS.ErrnoException) => {
        const code = err.code || "socket_error";
        if (UNREACHABLE_CODES.has(code)) this.setConnected(false);
        finish(new HerdrError(code, `Herdr socket error on ${method}: ${err.message}`));
      });
    });
  }

  /**
   * Event subscription on its own long-lived socket. Herdr resets a subscription socket that
   * receives any other request, and `pane.agent_status_changed` needs one entry per pane, so the
   * socket is rebuilt whenever the set of agent panes changes.
   */
  private startSubscription(): void {
    if (this.stopped) return;
    const statusPanes = Array.from(this.knownPanes.entries())
      .filter(([, p]) => p.agentKind)
      .map(([id]) => id)
      .sort();
    this.subscribedStatusPanes = statusPanes.join(",");

    const socket = connect(this.socketPath, () => {
      const subscriptions = [
        ...GLOBAL_SUBSCRIPTIONS.map((type) => ({ type })),
        ...statusPanes.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
      ];
      socket.write(JSON.stringify({ method: "events.subscribe", params: { subscriptions }, id: "sub-pigeon" }) + "\n");
    });
    this.subSocket = socket;

    let buffer = "";
    socket.on("connect", () => {
      this.setConnected(true);
      // Events between the last snapshot and this subscription would otherwise be lost.
      this.scheduleSnapshot();
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (UNREACHABLE_CODES.has(err.code || "")) this.setConnected(false);
      else console.error("[pigeon] Herdr subscription socket error:", err);
    });
    socket.on("close", () => {
      if (this.subSocket !== socket) return; // replaced by a rebuild
      this.subSocket = null;
      if (this.stopped) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.startSubscription();
      }, RECONNECT_MS);
    });
  }

  private rebuildSubscriptionIfNeeded(): void {
    const statusPanes = Array.from(this.knownPanes.entries())
      .filter(([, p]) => p.agentKind)
      .map(([id]) => id)
      .sort()
      .join(",");
    if (statusPanes === this.subscribedStatusPanes && this.subSocket) return;
    const old = this.subSocket;
    this.subSocket = null;
    old?.destroy();
    this.startSubscription();
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("[pigeon] Herdr sent a malformed event line:", line.slice(0, 200));
      return;
    }
    if (msg.id === "sub-pigeon") {
      if (msg.error) console.error("[pigeon] Herdr rejected events.subscribe:", msg.error);
      return;
    }
    if (msg.event) this.handleHerdrEvent(msg.event, msg.data || msg.params || {});
  }

  private handleHerdrEvent(event: string, data: any): void {
    const norm = event.replace(/_/g, ".");
    if (norm === "pane.agent.status.changed") {
      const paneId: string = data.pane_id;
      const status = this.normalizeStatus(data.agent_status);
      const known = this.knownPanes.get(paneId);
      if (known) known.herdrStatus = status;
      const state = this.paneStates.get(paneId);
      if (state && !state.pendingInteraction) state.agentStatus = status;
      this.emit("pane_status_changed", { paneId, status });
      if (status === "blocked" || state) this.scheduleDebouncedRead(paneId);
      this.scheduleSnapshot();
      return;
    }
    if (norm.startsWith("tab.") || norm.startsWith("workspace.") || norm.startsWith("pane.")) {
      this.scheduleSnapshot();
    }
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.refreshSnapshot().catch((err) => this.reportBackgroundError("session.snapshot", err));
    }, this.debounceMs);
  }

  public async refreshSnapshot(): Promise<SnapshotPayload> {
    const res: HerdrSnapshotResult = await this.request("session.snapshot", {});
    return this.applySnapshot(res);
  }

  /** Rebuilds the pane-derived caches from a Herdr snapshot response. */
  public applySnapshot(res: HerdrSnapshotResult): SnapshotPayload {
    const snap = res.snapshot;
    this.focusedPaneId = snap.focused_pane_id || null;

    const agentMap = new Map<string, any>();
    for (const ag of snap.agents || []) if (ag.pane_id) agentMap.set(ag.pane_id, ag);

    const panesByTab = new Map<string, any[]>();
    const nextKnown = new Map<string, KnownPane>();
    const nextSessions = new Map<string, { agent: string; sessionId: string }>();
    for (const p of snap.panes || []) {
      const list = panesByTab.get(p.tab_id) || [];
      list.push(p);
      panesByTab.set(p.tab_id, list);
      const ag = agentMap.get(p.pane_id);
      const agentKind = ag?.agent || p.agent || null;
      nextKnown.set(p.pane_id, {
        workspaceId: p.workspace_id,
        tabId: p.tab_id,
        agentKind,
        cwd: ag?.cwd || p.cwd || null,
        herdrStatus: this.normalizeStatus(ag?.agent_status || p.agent_status),
      });
      const sessionObj = p.agent_session || ag?.agent_session;
      if (sessionObj?.value) {
        nextSessions.set(p.pane_id, { agent: sessionObj.agent || agentKind || "unknown", sessionId: sessionObj.value });
      }
    }

    const tabsByWs = new Map<string, any[]>();
    for (const t of snap.tabs || []) {
      const list = tabsByWs.get(t.workspace_id) || [];
      list.push(t);
      tabsByWs.set(t.workspace_id, list);
    }

    // Drop state for panes that no longer exist so a reused pane id never shows old data.
    for (const id of Array.from(this.paneStates.keys())) {
      if (!nextKnown.has(id)) {
        this.paneStates.delete(id);
        this.paneContentHashes.delete(id);
      }
    }
    this.knownPanes = nextKnown;
    this.paneAgentSessions = nextSessions;

    const workingAgents: WorkingAgentSummary[] = [];
    const workspaces: WorkspaceSummary[] = (snap.workspaces || []).map((w) => {
      const rawTabs = w.tabs && w.tabs.length > 0 ? w.tabs : tabsByWs.get(w.workspace_id) || [];
      let wsHasWarn = false;
      let wsHasWorking = false;
      const workspaceLabel = w.label || `Workspace ${w.number}`;

      const tabs: TabSummary[] = rawTabs.map((t: any) => {
        const rawPanes = t.panes && t.panes.length > 0 ? t.panes : panesByTab.get(t.tab_id) || [];
        const panes: PaneSummary[] = rawPanes.map((p: any, idx: number) => {
          const ag = agentMap.get(p.pane_id);
          const agentStatus = this.effectiveStatus(p.pane_id);
          if (agentStatus === "blocked") wsHasWarn = true;
          if (agentStatus === "working") wsHasWorking = true;
          const agentName = ag?.name || p.title || p.pane_id;
          const agentKind = nextKnown.get(p.pane_id)?.agentKind ?? null;

          if (agentKind) {
            workingAgents.push({
              agent: agentKind,
              name: agentName,
              status: agentStatus,
              workspaceId: w.workspace_id,
              workspaceLabel,
              tabId: t.tab_id,
              paneId: p.pane_id,
              summary: this.summarizePane(p.pane_id, ag?.terminal_title),
            });
          }
          return { id: p.pane_id, agent: agentKind, agentStatus, isPrimary: idx === 0, name: agentName };
        });

        let tabLabel = t.label;
        if (!tabLabel || /^\d+$/.test(tabLabel.trim())) {
          const primary = panes[0];
          const recipe = primary?.agent ? getAgentRecipe(primary.agent) : undefined;
          tabLabel = recipe?.label || `Tab ${t.number || 1}`;
        }
        return { id: t.tab_id, label: tabLabel, paneCount: panes.length, panes };
      });

      return {
        id: w.workspace_id,
        label: workspaceLabel,
        tabCount: tabs.length,
        activeTabId: w.active_tab_id || (tabs[0]?.id ?? null),
        hasWarn: wsHasWarn,
        hasWorking: wsHasWorking,
        isFocused: !!w.focused,
        tabs,
      };
    });

    this.currentSnapshot = { workspaces, workingAgents };
    this.rebuildSubscriptionIfNeeded();
    this.emit("snapshot_updated", this.currentSnapshot);
    return this.currentSnapshot;
  }

  private summarizePane(paneId: string, terminalTitle?: string): string | undefined {
    const state = this.paneStates.get(paneId);
    if (state?.pendingInteraction) return state.pendingInteraction.question;
    const last = state?.cards[state.cards.length - 1];
    if (last?.kind === "tool_call") return `运行 ${last.command}`;
    if (last?.kind === "thought") return last.title || "正在思考";
    if (last?.kind === "markdown") return last.content.slice(0, 40);
    const title = terminalTitle?.trim();
    if (title && !["agy", "bash", "sh", "zsh", "opencode", "claude", "codex", "pi", "agent"].includes(title.toLowerCase())) return title;
    return undefined;
  }

  /** Herdr's status is authoritative; a recognized prompt on screen can only add `blocked`. */
  private effectiveStatus(paneId: string): AgentStatus {
    const state = this.paneStates.get(paneId);
    if (state?.pendingInteraction) return "blocked";
    return this.knownPanes.get(paneId)?.herdrStatus ?? "unknown";
  }

  public normalizeStatus(rawStatus?: string | null): AgentStatus {
    if (!rawStatus) return "unknown";
    const s = rawStatus.toLowerCase();
    if (s === "idle" || s === "working" || s === "blocked" || s === "done") return s;
    return "unknown";
  }

  public getSnapshot(): SnapshotPayload {
    return this.currentSnapshot;
  }

  public getFocusedPaneId(): string | null {
    return this.focusedPaneId;
  }

  public scheduleDebouncedRead(paneId: string): void {
    const timer = this.paneDebounceTimers.get(paneId);
    if (timer) clearTimeout(timer);
    this.paneDebounceTimers.set(
      paneId,
      setTimeout(() => {
        this.paneDebounceTimers.delete(paneId);
        if (!this.knownPanes.has(paneId)) return;
        this.readAndClassifyPane(paneId).catch((err) => this.reportBackgroundError("pane.read", err));
      }, this.debounceMs)
    );
  }

  /** Poll tick: skipped while a read of the same pane is still running. */
  private pollPane(paneId: string): Promise<PaneStatePayload> {
    return this.paneReadsInFlight.get(paneId) || this.readAndClassifyPane(paneId);
  }

  /**
   * Reads a pane, classifies it, and emits `cards_updated` when anything changed. Always reads
   * fresh: callers that just sent keys need the screen after the send, not a read already in flight.
   */
  public async readAndClassifyPane(paneId: string): Promise<PaneStatePayload> {
    const previous = this.paneReadsInFlight.get(paneId);
    const run = (async () => {
      if (previous) await previous.catch(() => undefined); // its failure is reported by its own caller
      const readRes = await this.request("pane.read", { pane_id: paneId, source: "recent_unwrapped", lines: READ_LINES });
      return this.applyScreen(paneId, readRes.read.text);
    })();
    this.paneReadsInFlight.set(paneId, run);
    try {
      return await run;
    } finally {
      if (this.paneReadsInFlight.get(paneId) === run) this.paneReadsInFlight.delete(paneId);
    }
  }

  /** Classifies a screen for a known pane. Split from the read so it can be driven directly. */
  public applyScreen(paneId: string, rawScreen: string): PaneStatePayload {
    const known = this.knownPanes.get(paneId);
    if (!known) throw new HerdrError("pane_not_found", `Pane ${paneId} is not in the Herdr snapshot`);
    const existing = this.paneStates.get(paneId);
    const contentHash = createHash("sha256").update(rawScreen).digest("hex");
    if (existing && this.paneContentHashes.get(paneId) === contentHash && existing.agentStatus === this.statusFor(existing, known.herdrStatus)) {
      return existing;
    }

    let { cards, pendingInteraction } = this.classifier.classifyScreen(rawScreen);
    if (!pendingInteraction && known.herdrStatus === "blocked") {
      pendingInteraction = buildUnrecognizedPrompt(rawScreen);
    }

    const payload: PaneStatePayload = {
      paneId,
      workspaceId: known.workspaceId,
      tabId: known.tabId,
      agentStatus: pendingInteraction ? "blocked" : known.herdrStatus,
      cards,
      pendingInteraction,
      rawScreen,
      revision: (existing?.revision || 0) + 1,
    };
    this.paneContentHashes.set(paneId, contentHash);
    this.paneStates.set(paneId, payload);
    this.emit("cards_updated", payload);
    return payload;
  }

  private statusFor(state: PaneStatePayload, herdrStatus: AgentStatus): AgentStatus {
    return state.pendingInteraction ? "blocked" : herdrStatus;
  }

  /** Latest classified state of a known pane, or null when it has not been read yet. */
  public getPaneState(paneId: string): PaneStatePayload | null {
    return this.paneStates.get(paneId) || null;
  }

  /**
   * Sends a prompt. Agent panes go through `agent.prompt` (Herdr handles bracketed paste and
   * submission); plain shell panes get the text followed by Enter.
   */
  public async sendPrompt(paneId: string, text: string): Promise<void> {
    if (this.getPaneAgentKind(paneId)) {
      await this.request("agent.prompt", { target: paneId, text });
    } else {
      await this.request("pane.send_text", { pane_id: paneId, text });
      await this.request("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
    }
    this.scheduleDebouncedRead(paneId);
  }

  /**
   * Answers a pending prompt with an exact key sequence, then re-reads the screen.
   * Returns true when that prompt is gone (no prompt, or a different one). Never retries:
   * a timed-out send may already have landed.
   */
  public async answerInteraction(paneId: string, interactionId: string, keys: string[]): Promise<boolean> {
    await this.request("pane.send_keys", { pane_id: paneId, keys });
    await new Promise((r) => setTimeout(r, 300));
    const state = await this.readAndClassifyPane(paneId);
    return state.pendingInteraction?.interactionId !== interactionId;
  }

  public async sendKeys(paneId: string, keys: string[]): Promise<void> {
    await this.request("pane.send_keys", { pane_id: paneId, keys });
    this.scheduleDebouncedRead(paneId);
  }

  public static validateAgentName(name: string): boolean {
    return /^[a-z][a-z0-9_-]{0,31}$/.test(name);
  }

  /**
   * Creates a tab and starts an agent in its root pane. `agentKind` must already be a known
   * recipe kind (checked at the WebSocket boundary). If the agent fails to start, the new tab
   * is closed again so no empty tab is left behind.
   */
  public async createTabAndAgent(
    workspaceId: string,
    agentKind: string,
    options: { modelId?: string; thinking?: string; cwd?: string } = {}
  ): Promise<{ tabId: string; paneId: string }> {
    const tabRes = await this.request("tab.create", {
      workspace_id: workspaceId,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const tabId: string = tabRes?.tab?.tab_id;
    const paneId: string = tabRes?.root_pane?.pane_id;
    if (!tabId || !paneId) throw new HerdrError("invalid_response", "tab.create did not return tab.tab_id and root_pane.pane_id");

    const recipe = getAgentRecipe(agentKind);
    if (recipe && recipe.kind !== "terminal") {
      const name = `p-${recipe.kind}-${randomBytes(3).toString("hex")}`;
      const args = recipe.launchArgs({ modelId: options.modelId, thinking: options.thinking });
      try {
        await this.request("agent.start", {
          pane_id: paneId,
          kind: recipe.kind,
          name,
          ...(args.length > 0 ? { args } : {}),
        });
      } catch (err) {
        await this.request("tab.close", { tab_id: tabId });
        throw err;
      }
    }

    await this.refreshSnapshot();
    return { tabId, paneId };
  }

  public async closeTab(tabId: string): Promise<void> {
    await this.request("tab.close", { tab_id: tabId });
    await this.refreshSnapshot();
  }
}
