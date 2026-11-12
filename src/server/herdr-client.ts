import { connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readGitBranch } from "./git-branch";
import { CardClassifier, buildUnrecognizedPrompt } from "./card-classifier";
import { getAgentRecipe } from "./agent-recipes";
import type {
  AgentStatus,
  InteractionCardData,
  PaneStatePayload,
  SnapshotPayload,
  WorkspaceSummary,
  TabSummary,
  PaneSummary,
  WorkingAgentSummary,
  SummaryKind,
} from "../types/protocol";
import type {
  HerdrAppLsResult,
  HerdrAppStatusResult,
  HerdrCoreListResult,
  HerdrCoreReadResult,
  HerdrCoreStatus,
  HerdrCoreTerminal,
  HerdrTopology,
} from "../types/herdr";

export interface HerdrClientOptions {
  /** Herdr App window socket (`herdr-app.sock`): spaces, tabs, creating and closing tabs. */
  appSocketPath: string;
  /** Herdr Core socket (JSON-RPC 2.0): terminals, status, screen, input, events. */
  coreSocketPath: string;
  debounceMs?: number;
  panePollMs?: number;
  requestTimeoutMs?: number;
  logger?: (msg: string) => void;
}

/**
 * An error returned by Herdr or by a socket. `code` is the Core's stable error kind, `app_error`
 * for an App `{"error": …}` reply, or the socket error code.
 */
export class HerdrError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "HerdrError";
  }
}

type Channel = "app" | "core";

// Socket-level failures that mean Herdr is not reachable (as opposed to a rejected request).
export const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOENT", "ECONNRESET", "EPIPE", "closed", "socket_error"]);
const READ_LINES = 200;
const REQUEST_TIMEOUT_MS = 8000;
const HISTORY_READ_TIMEOUT_MS = 2000;
const SNAPSHOT_RECONCILE_MS = 30000;
const RECONNECT_MS = 3000;
const SUBSCRIPTION_ID = "sub-pigeon";

// herdr-adapter.md §3.2: Core events that change which terminals exist or which tab holds them.
const TOPOLOGY_EVENTS = new Set(["created", "removed", "finished", "lost", "restarted", "labels"]);
// herdr-adapter.md §4: Core `status.app` words that differ from Pigeon's recipe kinds.
const APP_TO_AGENT_KIND: Record<string, string> = { "claude-code": "claude", antigravity: "agy" };

interface KnownPane {
  workspaceId: string;
  tabId: string;
  agentKind: string | null;
  cwd: string | null;
  herdrStatus: AgentStatus;
  title: string | undefined;
  /** Foreground process (`herdr-adapter.md` §3.1), used for session binding. */
  pid: number | null;
  program: string | undefined;
  createdMs: number;
}

/** What a pane's session binding needs (`agent-session-normalization.md` §2.0). */
export interface PaneProcessFacts {
  agentKind: string | null;
  pid: number | null;
  cwd: string | null;
  createdMs: number;
}

export class HerdrClient extends EventEmitter {
  private appSocketPath: string;
  private coreSocketPath: string;
  private debounceMs: number;
  private panePollMs: number;
  private requestTimeoutMs: number;
  private subSocket: Socket | null = null;
  private reachable: Record<Channel, boolean> = { app: false, core: false };
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
  // Screen hash plus the Herdr status each pane's current state was classified under.
  private paneClassifyKeys = new Map<string, string>();
  private paneReadsInFlight = new Map<string, Promise<PaneStatePayload>>();
  private paneDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private isConnecting = false;
  // Terminals whose read answered `how: "stitched"`; read without history from then on (§3.3).
  private stitchedPanes = new Set<string>();
  private timeoutDemotedAt = new Map<string, number>();
  private loggedEventShapes = new Set<string>();
  // Facts from the latest snapshot; rebuilt on every snapshot so closed panes drop out.
  private knownPanes = new Map<string, KnownPane>();
  private currentSnapshot: SnapshotPayload = { workspaces: [], workingAgents: [] };
  private focusedPaneId: string | null = null;
  /** herdr-adapter.md §4: `done` panes a phone has looked at, reported as `idle`. */
  private seenPanes = new Set<string>();
  private transcriptInteractions = new Map<string, InteractionCardData>();
  /** protocol.md §5.3: the title of the session bound to a pane, for tabs without a name of their own. */
  private sessionTitleOf: (paneId: string) => string | undefined = () => undefined;
  /** protocol.md §5.3: the active/latest model of the session bound to a pane. */
  private sessionModelOf: (paneId: string) => string | undefined = () => undefined;
  private lastTopology: HerdrTopology | null = null;
  private monitoredPaneIds = new Set<string>();
  private workspaceFolders = new Map<string, string>();
  private tabIds = new Set<string>();
  private logger?: (msg: string) => void;
  private lastReportedStatus = new Map<string, AgentStatus>();
  private lastHadPrompt = new Map<string, boolean>();

  constructor(options: HerdrClientOptions) {
    super();
    this.appSocketPath = options.appSocketPath;
    this.coreSocketPath = options.coreSocketPath;
    this.debounceMs = options.debounceMs ?? 200;
    this.panePollMs = options.panePollMs ?? 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.logger = options.logger;
  }

  public async connect(): Promise<void> {
    this.stopped = false;
    this.isConnecting = true;
    this.startSubscription();
    this.startPolling();
    try {
      await this.refreshSnapshot();
    } catch (err) {
      // Herdr offline at startup is an expected state; it surfaces as `upstream_status` and the
      // subscription and reconciliation loops keep retrying.
      if (!(err instanceof HerdrError) || !UNREACHABLE_CODES.has(err.code)) throw err;
    } finally {
      this.isConnecting = false;
    }
  }

  private startPolling(): void {
    this.stopPolling();
    // Runs while disconnected too: it is how a reopened Herdr window is noticed (§3.4).
    this.snapshotPollTimer = setInterval(() => {
      this.refreshSnapshot().catch((err) => this.reportBackgroundError("snapshot", err));
    }, SNAPSHOT_RECONCILE_MS);

    // Herdr has no output-changed event, so the panes a client is looking at are polled;
    // unchanged screens are dropped by hash before classification.
    this.panePollTimer = setInterval(() => {
      if (!this.connected) return;
      for (const paneId of this.monitoredPaneIds) {
        if (!this.knownPanes.has(paneId)) continue;
        this.pollPane(paneId).catch((err) => this.reportBackgroundError("terminal.read", err));
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
  private reportBackgroundError(what: string, err: unknown): void {
    if (err instanceof HerdrError && UNREACHABLE_CODES.has(err.code)) return;
    console.error(`[pigeon] Herdr ${what} failed:`, err);
  }

  /** herdr-adapter.md §3.4: connected while both the App and the Core answer. */
  private setReachable(channel: Channel, value: boolean): void {
    if (this.stopped) return;
    this.reachable[channel] = value;
    const connected = this.reachable.app && this.reachable.core;
    if (this.connected === connected) return;
    this.connected = connected;
    this.logger?.(`herdr connection ${connected ? "up" : "down"}`);
    this.emit(connected ? "connected" : "disconnected");
  }

  public setMonitoredPanes(paneIds: Iterable<string>): void {
    this.monitoredPaneIds = new Set(paneIds);
  }

  public getMonitoredPaneIds(): string[] {
    return Array.from(this.monitoredPaneIds);
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

  public getPaneFacts(paneId: string): PaneProcessFacts | null {
    const k = this.knownPanes.get(paneId);
    return k ? { agentKind: k.agentKind, pid: k.pid, cwd: k.cwd, createdMs: k.createdMs } : null;
  }

  /** Herdr's own status for the pane, without the on-screen prompt override. */
  public getPaneHerdrStatus(paneId: string): AgentStatus {
    return this.knownPanes.get(paneId)?.herdrStatus ?? "unknown";
  }

  public getWorkspaceFolder(workspaceId: string): string | null {
    return this.workspaceFolders.get(workspaceId) ?? null;
  }

  public hasTab(tabId: string): boolean {
    return this.tabIds.has(tabId);
  }

  public paneIds(): string[] {
    return Array.from(this.knownPanes.keys());
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public disconnect(): void {
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
    this.reachable = { app: false, core: false };
    if (this.connected) {
      this.connected = false;
      this.logger?.("herdr connection down");
      this.emit("disconnected");
    }
    this.stopped = true;
  }

  /** One Herdr Core JSON-RPC request on a fresh connection, never on the subscription socket. */
  public coreRequest<T = any>(method: string, params: Record<string, any> = {}, timeoutMs?: number): Promise<T> {
    const id = ++this.requestId;
    return this.oneShot("core", JSON.stringify({ jsonrpc: "2.0", id, method, params }), method, (res) => {
      if (res.error) {
        const kind = res.error.data?.kind || "core_error";
        throw new HerdrError(kind, res.error.message || kind);
      }
      return res.result as T;
    }, timeoutMs);
  }

  /** One Herdr App socket request (`{"ls":{}}`, `{"do":…}`); the reply is the result itself. */
  public appRequest<T = any>(body: Record<string, any>): Promise<T> {
    const label = typeof body.do === "string" ? body.do : Object.keys(body)[0];
    return this.oneShot("app", JSON.stringify(body), label, (res) => {
      if (typeof res.error === "string") throw new HerdrError("app_error", `Herdr App ${label}: ${res.error}`);
      return res as T;
    });
  }

  private oneShot<T>(channel: Channel, line: string, label: string, unwrap: (res: any) => T, timeoutMs?: number): Promise<T> {
    const socketPath = channel === "app" ? this.appSocketPath : this.coreSocketPath;
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const socket = connect(socketPath, () => socket.write(line + "\n"));

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
        finish(new HerdrError("timeout", `Herdr ${channel} request ${label} timed out`));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pendingRequests.add(finish);

      const parse = () => {
        let res: any;
        try {
          res = JSON.parse(buffer.trim());
        } catch {
          return finish(new HerdrError("invalid_response", `Herdr ${channel} returned malformed JSON for ${label}`));
        }
        this.setReachable(channel, true);
        try {
          finish(null, unwrap(res));
        } catch (err) {
          finish(err as Error);
        }
      };

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        if (buffer.includes("\n")) parse();
      });
      socket.on("end", () => {
        if (buffer.trim()) parse();
        else finish(new HerdrError("closed", `Herdr ${channel} closed the connection without answering ${label}`));
      });
      socket.on("error", (err: NodeJS.ErrnoException) => {
        const code = err.code || "socket_error";
        if (UNREACHABLE_CODES.has(code)) this.setReachable(channel, false);
        finish(new HerdrError(code, `Herdr ${channel} socket error on ${label}: ${err.message}`));
      });
    });
  }

  /**
   * herdr-adapter.md §3.2: Core `events.subscribe` for every terminal, on its own long-lived
   * connection. After the reply it carries only notifications.
   */
  private startSubscription(): void {
    if (this.stopped) return;
    const socket = connect(this.coreSocketPath, () => {
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: SUBSCRIPTION_ID, method: "events.subscribe", params: {} }) + "\n");
    });
    this.subSocket = socket;

    let buffer = "";
    socket.on("connect", () => {
      this.setReachable("core", true);
      // Events between the last snapshot and this subscription would otherwise be lost.
      if (!this.isConnecting) this.scheduleSnapshot();
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
      if (UNREACHABLE_CODES.has(err.code || "")) this.setReachable("core", false);
      else console.error("[pigeon] Herdr Core subscription socket error:", err);
    });
    socket.on("close", () => {
      if (this.subSocket !== socket) return;
      this.subSocket = null;
      if (this.stopped) return;
      this.setReachable("core", false);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.startSubscription();
      }, RECONNECT_MS);
    });
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("[pigeon] Herdr Core sent a malformed event line:", line.slice(0, 200));
      return;
    }
    if (msg.id === SUBSCRIPTION_ID) {
      if (msg.error) console.error("[pigeon] Herdr Core rejected events.subscribe:", msg.error);
      return;
    }
    if (msg.method === "event") this.handleCoreEvent(msg.params);
    else if (msg.method === "missed") this.scheduleSnapshot();
  }

  private handleCoreEvent(params: { type: string; terminal: string; data: any }): void {
    if (!params || typeof params !== "object") {
      this.scheduleSnapshot();
      return;
    }
    if (params.type === "status") {
      const paneId = params.terminal;
      if (!params.data || typeof params.data !== "object" || !params.data.status || typeof params.data.status.state !== "string") {
        const shape = params.data ? Object.keys(params.data).join(",") : "null";
        const key = `status:${shape}`;
        if (!this.loggedEventShapes.has(key)) {
          this.loggedEventShapes.add(key);
          console.warn(`[pigeon] Herdr Core status event has unknown shape (${key}); scheduling reconciliation snapshot`);
        }
        this.scheduleSnapshot();
        return;
      }
      const known = this.knownPanes.get(paneId);
      if (!known) return; // a terminal the window does not show
      const status = this.normalizeStatus(params.data.status);
      if (status !== "done") this.seenPanes.delete(paneId);
      known.herdrStatus = status;
      // relabelTabs() re-applies the last topology before the next snapshot arrives: keep it current.
      const term = this.lastTopology?.terminals.find((t) => t.address === paneId);
      if (term) term.status = params.data.status;
      this.emit("pane_status_changed", { paneId, status });
      this.checkReportedStatusChange(paneId);
      // The read re-classifies under the new status, which reaches viewers as a new pane_state.
      if (status === "blocked" || this.paneStates.has(paneId)) this.scheduleDebouncedRead(paneId);
      if (this.lastTopology) this.applySnapshot(this.lastTopology);
      return;
    }
    if (TOPOLOGY_EVENTS.has(params.type)) this.scheduleSnapshot();
  }

  private scheduleSnapshot(): void {
    if (this.stopped) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.refreshSnapshot().catch((err) => this.reportBackgroundError("snapshot", err));
    }, this.debounceMs);
  }

  /** herdr-adapter.md §3.1: App `ls` and `status` joined with Core `terminal.list`. */
  public async refreshSnapshot(): Promise<SnapshotPayload> {
    const [ls, status, list] = await Promise.all([
      this.appRequest<HerdrAppLsResult>({ ls: {} }),
      this.appRequest<HerdrAppStatusResult>({ status: {} }),
      this.coreRequest<HerdrCoreListResult>("terminal.list", {}),
    ]);
    return this.applySnapshot({ ls, status, terminals: list.terminals });
  }

  public setSessionTitleSource(source: (paneId: string) => string | undefined): void {
    this.sessionTitleOf = source;
  }

  public setSessionModelSource(source: (paneId: string) => string | undefined): void {
    this.sessionModelOf = source;
  }

  /** A bound session's title changed: rebuild the snapshot from the last topology, without asking Herdr. */
  public relabelTabs(): void {
    if (this.lastTopology) this.applySnapshot(this.lastTopology);
  }

  /** Rebuilds the pane-derived caches from one topology. */
  public applySnapshot(topology: HerdrTopology): SnapshotPayload {
    this.lastTopology = topology;
    const terminals = new Map<string, HerdrCoreTerminal>();
    for (const t of topology.terminals) terminals.set(t.address, t);

    const nextKnown = new Map<string, KnownPane>();
    let focusedPaneId: string | null = null;
    for (const space of topology.ls.spaces) {
      for (const tab of space.tabs) {
        for (const ref of tab.terminals) {
          const term = terminals.get(ref.terminal);
          nextKnown.set(ref.terminal, {
            workspaceId: space.id,
            tabId: tab.id,
            agentKind: this.agentKindOf(term?.status),
            cwd: term ? term.foreground?.cwd || term.cwd : null,
            herdrStatus: this.normalizeStatus(term?.status),
            title: term?.title,
            pid: term?.foreground?.pid || null,
            program: term?.foreground?.name || undefined,
            createdMs: term?.created_ms ?? 0,
          });
          if (ref.pane === topology.status.focused_pane) focusedPaneId = ref.terminal;
        }
      }
    }

    // Drop state for panes that no longer exist so a reused address never shows old data.
    for (const id of Array.from(this.paneStates.keys())) {
      if (nextKnown.has(id)) continue;
      this.paneStates.delete(id);
      this.paneClassifyKeys.delete(id);
    }
    for (const id of Array.from(this.stitchedPanes)) if (!nextKnown.has(id)) this.stitchedPanes.delete(id);
    for (const id of Array.from(this.timeoutDemotedAt.keys())) if (!nextKnown.has(id)) this.timeoutDemotedAt.delete(id);
    for (const id of Array.from(this.seenPanes)) if (nextKnown.get(id)?.herdrStatus !== "done") this.seenPanes.delete(id);
    const prevKnown = this.knownPanes;
    this.knownPanes = nextKnown;
    this.focusedPaneId = focusedPaneId;

    // herdr-adapter.md §3.1: a pane status in a snapshot that differs from the one Pigeon holds is handled like a status event
    for (const [paneId, next] of nextKnown.entries()) {
      const prev = prevKnown.get(paneId);
      if (prev && prev.herdrStatus !== next.herdrStatus) {
        this.emit("pane_status_changed", { paneId, status: next.herdrStatus });
      }
      this.checkReportedStatusChange(paneId);
    }
    // herdr-adapter.md §3.1: the App's space folder is where the space was started, not the project.
    const folderOf = (space: (typeof topology.ls.spaces)[number]): string => {
      const first = space.tabs[0]?.terminals[0]?.terminal;
      return (first ? nextKnown.get(first)?.cwd : null) || space.folder;
    };
    this.workspaceFolders = new Map(topology.ls.spaces.map((sp) => [sp.id, folderOf(sp)]));
    this.tabIds = new Set(topology.ls.spaces.flatMap((sp) => sp.tabs.map((t) => t.id)));
    const branches = new Map<string, string | undefined>();
    const branchOf = (folder: string | null | undefined): string | undefined => {
      if (!folder) return undefined;
      if (!branches.has(folder)) branches.set(folder, readGitBranch(folder) ?? undefined);
      return branches.get(folder);
    };

    const workingAgents: WorkingAgentSummary[] = [];
    const workspaces: WorkspaceSummary[] = topology.ls.spaces.map((space) => {
      let hasWarn = false;
      let hasWorking = false;
      const folder = this.workspaceFolders.get(space.id)!;
      const workspaceLabel = space.name || basename(folder);

      const tabs: TabSummary[] = space.tabs.map((tab, tabIdx) => {
        const panes: PaneSummary[] = tab.terminals.map((ref, idx) => {
          const known = nextKnown.get(ref.terminal)!;
          const agentStatus = this.effectiveStatus(ref.terminal);
          if (agentStatus === "blocked") hasWarn = true;
          if (agentStatus === "working") hasWorking = true;
          const name = ref.name || terminals.get(ref.terminal)?.name || ref.terminal;
          const { summary, summaryKind } = this.summarizePane(ref.terminal, known.title);
          if (known.agentKind) {
            workingAgents.push({
              agent: known.agentKind,
              name,
              status: agentStatus,
              workspaceId: space.id,
              workspaceLabel,
              tabId: tab.id,
              paneId: ref.terminal,
              summary,
              summaryKind,
            });
          }
          const model = this.sessionModelOf(ref.terminal);
          return {
            id: ref.terminal,
            agent: known.agentKind,
            agentStatus,
            isPrimary: idx === 0,
            name,
            ...(known.program ? { program: known.program } : {}),
            ...(model ? { model } : {}),
            ...(summaryKind ? { summary, summaryKind } : {}),
          };
        });

        // protocol.md §5.3: a name the user gave the tab, else the bound session's title, else the agent.
        let tabLabel = tab.name;
        if (!tabLabel || /^\d+$/.test(tabLabel.trim())) {
          const primary = panes[0];
          const recipe = primary?.agent ? getAgentRecipe(primary.agent) : undefined;
          tabLabel = (primary && this.sessionTitleOf(primary.id)) || recipe?.label || `Tab ${tabIdx + 1}`;
        }
        const tabBranch = branchOf(nextKnown.get(tab.terminals[0]?.terminal ?? "")?.cwd);
        return { id: tab.id, label: tabLabel, ...(tabBranch ? { branch: tabBranch } : {}), paneCount: panes.length, panes };
      });

      const branch = branchOf(folder);
      return {
        id: space.id,
        label: workspaceLabel,
        folder,
        ...(branch ? { branch } : {}),
        tabCount: tabs.length,
        activeTabId: space.tabs.find((t) => t.active)?.id ?? tabs[0]?.id ?? null,
        hasWarn,
        hasWorking,
        isFocused: space.active,
        tabs,
      };
    });

    this.currentSnapshot = { workspaces, workingAgents };
    this.emit("snapshot_updated", this.currentSnapshot);
    return this.currentSnapshot;
  }

  /** herdr-adapter.md §4: a terminal is an agent while its program reports a status. */
  private agentKindOf(status: HerdrCoreStatus | null | undefined): string | null {
    if (!status) return null;
    const app = status.app?.toLowerCase();
    if (!app) return null;
    return APP_TO_AGENT_KIND[app] ?? app;
  }

  /** `protocol.md` §5.3: data the phone renders; the daemon writes no UI text. */
  private summarizePane(paneId: string, terminalTitle?: string): { summary?: string; summaryKind?: SummaryKind } {
    const state = this.paneStates.get(paneId);
    if (state?.pendingInteraction?.question) return { summary: state.pendingInteraction.question, summaryKind: "text" };
    const last = state?.cards[state.cards.length - 1];
    if (last?.kind === "tool_call") return { summary: last.command, summaryKind: "run" };
    if (last?.kind === "thought") return { summary: last.title || "", summaryKind: "thinking" };
    if (last?.kind === "markdown") return { summary: last.content.slice(0, 40), summaryKind: "text" };
    const title = terminalTitle?.trim();
    if (title && !["agy", "bash", "sh", "zsh", "opencode", "claude", "codex", "pi", "agent"].includes(title.toLowerCase())) return { summary: title, summaryKind: "text" };
    return {};
  }

  /** Herdr's status is authoritative; a recognized prompt on screen can only add `blocked`. */
  private effectiveStatus(paneId: string): AgentStatus {
    const state = this.paneStates.get(paneId);
    if (state?.pendingInteraction || this.transcriptInteractions.has(paneId)) return "blocked";
    return this.reportedStatus(paneId);
  }

  public setTranscriptInteraction(paneId: string, interaction: InteractionCardData | null): void {
    const previous = this.transcriptInteractions.get(paneId);
    if (!interaction && !previous) return;
    if (interaction && previous && interaction.interactionId === previous.interactionId) return;
    if (interaction) {
      this.transcriptInteractions.set(paneId, interaction);
    } else {
      this.transcriptInteractions.delete(paneId);
    }
    const known = this.knownPanes.get(paneId);
    if (!known) return;
    const existing = this.paneStates.get(paneId);
    const screenPrompt = existing?.rawScreen ? this.classifier.classifyScreen(existing.rawScreen).pendingInteraction : null;
    const pendingInteraction = screenPrompt ?? interaction ?? (known.herdrStatus === "blocked" && existing ? buildUnrecognizedPrompt(existing.rawScreen) : null);
    const agentStatus = pendingInteraction ? "blocked" : this.reportedStatus(paneId);
    const payload: PaneStatePayload = {
      paneId,
      workspaceId: known.workspaceId,
      tabId: known.tabId,
      agentStatus,
      cards: existing?.cards ?? [],
      pendingInteraction,
      rawScreen: existing?.rawScreen ?? "",
      revision: (existing?.revision || 0) + 1,
    };
    this.paneStates.set(paneId, payload);
    this.checkPromptChange(paneId, Boolean(pendingInteraction));
    this.emit("cards_updated", payload);
    if (this.lastTopology) this.applySnapshot(this.lastTopology);
  }

  private checkReportedStatusChange(paneId: string, seen = false): void {
    const current = this.reportedStatus(paneId);
    const prev = this.lastReportedStatus.get(paneId);
    if (prev !== undefined && prev !== current) {
      this.logger?.(`pane ${paneId} status change: ${prev} -> ${current}${seen ? " (seen)" : ""}`);
    }
    this.lastReportedStatus.set(paneId, current);
  }

  private checkPromptChange(paneId: string, hasPrompt: boolean): void {
    const prev = this.lastHadPrompt.get(paneId) ?? false;
    if (hasPrompt !== prev) {
      this.lastHadPrompt.set(paneId, hasPrompt);
      this.logger?.(`pane ${paneId} prompt: ${hasPrompt ? "recognized" : "gone"}`);
    }
  }

  /** Herdr's status, with a seen `done` reported as `idle` (herdr-adapter.md §4). */
  private reportedStatus(paneId: string): AgentStatus {
    const status = this.knownPanes.get(paneId)?.herdrStatus ?? "unknown";
    return status === "done" && this.seenPanes.has(paneId) ? "idle" : status;
  }

  /**
   * herdr-adapter.md §4: a phone visibly viewed this pane. A `done` pane is reported `idle` from now on,
   * until the Core reports another status.
   */
  public markSeen(paneId: string): void {
    if (this.knownPanes.get(paneId)?.herdrStatus !== "done" || this.seenPanes.has(paneId)) return;
    this.seenPanes.add(paneId);
    this.checkReportedStatusChange(paneId, true);
    const state = this.paneStates.get(paneId);
    if (state) this.applyScreen(paneId, state.rawScreen);
    this.scheduleSnapshot();
  }

  /** herdr-adapter.md §4: the Core's `error` needs a person, like `blocked`. */
  private normalizeStatus(status: HerdrCoreStatus | null | undefined): AgentStatus {
    if (!status) return "unknown";
    const s = status.state.toLowerCase();
    if (s === "idle" || s === "working" || s === "blocked" || s === "done") return s;
    if (s === "error") return "blocked";
    return "unknown";
  }

  public getSnapshot(): SnapshotPayload {
    return this.currentSnapshot;
  }

  public getFocusedPaneId(): string | null {
    return this.focusedPaneId;
  }

  private scheduleDebouncedRead(paneId: string): void {
    const timer = this.paneDebounceTimers.get(paneId);
    if (timer) clearTimeout(timer);
    this.paneDebounceTimers.set(
      paneId,
      setTimeout(() => {
        this.paneDebounceTimers.delete(paneId);
        if (!this.knownPanes.has(paneId)) return;
        this.readAndClassifyPane(paneId).catch((err) => this.reportBackgroundError("terminal.read", err));
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
      // herdr-adapter.md §3.3: history reads scroll a full-screen program on the desktop.
      const isDemoted = this.stitchedPanes.has(paneId) || (this.timeoutDemotedAt.has(paneId) && Date.now() - this.timeoutDemotedAt.get(paneId)! < 5 * 60_000);
      const lines = isDemoted ? 0 : READ_LINES;
      let res: HerdrCoreReadResult;
      try {
        res = await this.coreRequest<HerdrCoreReadResult>(
          "terminal.read",
          { terminal: paneId, lines },
          lines > 0 ? Math.min(HISTORY_READ_TIMEOUT_MS, this.requestTimeoutMs) : undefined
        );
        if (lines > 0) this.timeoutDemotedAt.delete(paneId);
      } catch (err) {
        if (lines > 0 && err instanceof HerdrError && err.code === "timeout") {
          this.timeoutDemotedAt.set(paneId, Date.now());
          res = await this.coreRequest<HerdrCoreReadResult>("terminal.read", { terminal: paneId, lines: 0 });
        } else {
          throw err;
        }
      }
      if (res.how === "stitched") {
        this.stitchedPanes.add(paneId);
        this.timeoutDemotedAt.delete(paneId);
      }
      return this.applyScreen(paneId, res.text);
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
    if (!known) throw new HerdrError("not_found", `Pane ${paneId} is not in the Herdr snapshot`);
    const existing = this.paneStates.get(paneId);
    // herdr-adapter.md §3.3: a new Herdr status alone is classified again, even on an unchanged screen.
    const classifyKey = `${createHash("sha256").update(rawScreen).digest("hex")}|${known.herdrStatus}|${this.seenPanes.has(paneId)}|${this.transcriptInteractions.get(paneId)?.interactionId ?? ""}`;
    if (existing && this.paneClassifyKeys.get(paneId) === classifyKey) return existing;

    let { cards, pendingInteraction } = this.classifier.classifyScreen(rawScreen);
    if (!pendingInteraction) {
      const transcript = this.transcriptInteractions.get(paneId);
      if (transcript) {
        pendingInteraction = transcript;
      } else if (known.herdrStatus === "blocked") {
        pendingInteraction = buildUnrecognizedPrompt(rawScreen);
      }
    }

    const payload: PaneStatePayload = {
      paneId,
      workspaceId: known.workspaceId,
      tabId: known.tabId,
      agentStatus: pendingInteraction ? "blocked" : this.reportedStatus(paneId),
      cards,
      pendingInteraction,
      rawScreen,
      revision: (existing?.revision || 0) + 1,
    };
    this.paneClassifyKeys.set(paneId, classifyKey);
    this.paneStates.set(paneId, payload);
    this.checkPromptChange(paneId, Boolean(pendingInteraction));
    this.emit("cards_updated", payload);
    return payload;
  }

  /** Latest classified state of a known pane, or null when it has not been read yet. */
  public getPaneState(paneId: string): PaneStatePayload | null {
    return this.paneStates.get(paneId) || null;
  }

  /** herdr-adapter.md §6: the Core pastes the text and presses Enter, for agents and shells alike. */
  public async sendPrompt(paneId: string, text: string): Promise<void> {
    await this.coreRequest("terminal.send", { terminal: paneId, text });
    this.scheduleDebouncedRead(paneId);
  }

  /**
   * Answers a pending prompt with an exact key sequence, then re-reads the screen.
   * Returns true when that prompt is gone (no prompt, or a different one). Never retries:
   * a timed-out send may already have landed.
   */
  public async answerInteraction(paneId: string, interactionId: string, keys: string[]): Promise<boolean> {
    await this.coreRequest("terminal.keys", { terminal: paneId, keys });
    await new Promise((r) => setTimeout(r, 300));
    const state = await this.readAndClassifyPane(paneId);
    return state.pendingInteraction?.interactionId !== interactionId;
  }

  public async sendKeys(paneId: string, keys: string[]): Promise<void> {
    await this.coreRequest("terminal.keys", { terminal: paneId, keys });
    this.scheduleDebouncedRead(paneId);
  }

  /**
   * herdr-adapter.md §5: the App creates the tab and its terminal (running the recipe's command,
   * or the shell for the terminal recipe). `agentKind` is a known recipe kind (checked at the
   * WebSocket boundary).
   */
  public async createTabAndAgent(
    workspaceId: string,
    agentKind: string,
    options: { modelId?: string; thinking?: string; cwd?: string; firstMessage?: string; resume?: string } = {}
  ): Promise<{ tabId: string; paneId: string }> {
    const recipe = getAgentRecipe(agentKind)!;
    const argv = recipe.command
      ? [recipe.command, ...recipe.launchArgs({ modelId: options.modelId, thinking: options.thinking, resume: options.resume, firstMessage: options.firstMessage })]
      : null;
    const folder = options.cwd ?? this.workspaceFolders.get(workspaceId);
    const created = await this.appRequest<{ terminal?: string }>({
      do: "tab.new",
      args: {
        space: workspaceId,
        ...(folder ? { folder } : {}),
        ...(argv ? { argv } : {}),
        ...(options.firstMessage && !recipe.promptInArgv ? { task: options.firstMessage } : {}),
      },
    });
    const paneId = created.terminal;
    if (!paneId) throw new HerdrError("invalid_response", "Herdr App tab.new did not name the new terminal");
    await this.refreshSnapshot();
    const tabId = this.knownPanes.get(paneId)?.tabId;
    if (!tabId) throw new HerdrError("invalid_response", `The new terminal ${paneId} is in no Herdr tab`);
    return { tabId, paneId };
  }

  /** herdr-adapter.md §5: rename through the App, then refresh the snapshot. */
  public async renameTab(tabId: string, name: string): Promise<void> {
    await this.appRequest({ do: "tab.rename", args: { id: tabId, name } });
    await this.refreshSnapshot();
  }

  /** The phone's close dialog is the confirmation the App would otherwise ask for. */
  public async closeTab(tabId: string): Promise<void> {
    await this.appRequest({ do: "tab.close", args: { id: tabId, confirmed: true } });
    await this.refreshSnapshot();
  }
}
