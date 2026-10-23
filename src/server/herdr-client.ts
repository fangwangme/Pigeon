import { connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { CardClassifier } from "./card-classifier";
import type {
  AgentStatus,
  Card,
  InteractionCardData,
  PaneStatePayload,
  SnapshotPayload,
  WorkspaceSummary,
  TabSummary,
  PaneSummary,
  WorkingAgentSummary,
} from "../types/protocol";
import type { HerdrSnapshotResult } from "../types/herdr";

export interface HerdrClientOptions {
  socketPath?: string;
  debounceMs?: number;
}

export class HerdrClient extends EventEmitter {
  private socketPath: string;
  private subSocket: Socket | null = null;
  private connected = false;
  private requestId = 0;
  private classifier: CardClassifier;
  private debounceMs: number;
  private reconnectTimer: any = null;

  // Cache
  private paneStates = new Map<string, PaneStatePayload>();
  private paneLocations = new Map<string, { workspaceId: string; tabId: string }>();
  private paneDebounceTimers = new Map<string, NodeJS.Timeout>();
  private paneAgentSessions = new Map<string, { agent: string; sessionId: string }>();
  private paneContentHashes = new Map<string, string>();
  private currentSnapshot: SnapshotPayload = { workspaces: [], workingAgents: [] };
  private focusedPaneId: string | null = null;
  private monitoredPaneIds = new Set<string>();
  private snapshotPollTimer: any = null;
  private activePanePollTimer: any = null;

  constructor(options: HerdrClientOptions = {}) {
    super();
    this.socketPath =
      options.socketPath ||
      (process.env.HOME ? `${process.env.HOME}/.config/herdr/herdr.sock` : "/tmp/herdr.sock");
    this.debounceMs = options.debounceMs || 200; // 150-250ms per spec
    this.classifier = new CardClassifier();
  }

  public async connect(): Promise<void> {
    try {
      // 1. Initial snapshot check
      await this.refreshSnapshot();
      this.connected = true;
      this.emit("connected");
    } catch {
      // Allow proceeding even if Herdr is offline initially
      this.connected = false;
    }

    // 2. Start persistent event stream
    this.startSubscription();

    // 3. Start robust polling per spec
    this.startPolling();
  }

  public startPolling(): void {
    this.stopPolling();
    // Gentle heartbeat fallback (30s) per spec event-driven model when event stream is inactive
    this.snapshotPollTimer = setInterval(() => {
      if (this.connected && !this.subSocket) {
        this.refreshSnapshot().catch(() => {});
      }
    }, 30000);

    // Active pane reading: iterates over all panes actively monitored by any connected mobile client,
    // using a gentle fallback interval (3s) rather than hammering Herdr's pty
    this.activePanePollTimer = setInterval(() => {
      if (this.connected && this.monitoredPaneIds.size > 0) {
        for (const paneId of this.monitoredPaneIds) {
          this.readAndClassifyPane(paneId).catch(() => {});
        }
      }
    }, 3000);
  }

  public stopPolling(): void {
    if (this.snapshotPollTimer) {
      clearInterval(this.snapshotPollTimer);
      this.snapshotPollTimer = null;
    }
    if (this.activePanePollTimer) {
      clearInterval(this.activePanePollTimer);
      this.activePanePollTimer = null;
    }
  }

  public addMonitoredPane(paneId: string): void {
    if (paneId) this.monitoredPaneIds.add(paneId);
  }

  public removeMonitoredPane(paneId: string): void {
    if (paneId) this.monitoredPaneIds.delete(paneId);
  }

  public getMonitoredPaneIds(): string[] {
    return Array.from(this.monitoredPaneIds);
  }

  public setMonitoredPaneId(paneId: string | null): void {
    this.monitoredPaneIds.clear();
    if (paneId) {
      this.monitoredPaneIds.add(paneId);
    }
  }

  public getPaneAgentSession(paneId: string): { agent: string; sessionId: string } | null {
    return this.paneAgentSessions.get(paneId) || null;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public disconnect(): void {
    this.stopPolling();
    clearTimeout(this.reconnectTimer);
    if (this.subSocket) {
      try {
        this.subSocket.end();
        this.subSocket.destroy();
      } catch {}
      this.subSocket = null;
    }
    this.connected = false;
  }

  /**
   * Herdr RPC request. Opens a one-shot connection per command,
   * matching Herdr 0.9.5 server lifecycle.
   */
  public request<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = `req_${++this.requestId}`;
      let socket: Socket;

      try {
        socket = connect(this.socketPath, () => {
          socket.write(JSON.stringify({ method, params, id }) + "\n");
        });
      } catch (err) {
        return reject(err);
      }

      let buffer = "";
      const timer = setTimeout(() => {
        try {
          socket.destroy();
        } catch {}
        reject(new Error(`Herdr request ${method} timed out`));
      }, 8000);

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        // Herdr responds with a single JSON line
        if (buffer.includes("\n")) {
          clearTimeout(timer);
          try {
            socket.end();
          } catch {}
          try {
            const res = JSON.parse(buffer.trim());
            if (res.error) {
              reject(new Error(res.error.message || res.error.code));
            } else {
              this.connected = true;
              resolve(res.result);
            }
          } catch (e) {
            reject(e);
          }
        }
      });

      socket.on("end", () => {
        clearTimeout(timer);
        if (buffer.trim()) {
          try {
            const res = JSON.parse(buffer.trim());
            if (res.error) {
              reject(new Error(res.error.message || res.error.code));
            } else {
              this.connected = true;
              resolve(res.result);
            }
          } catch (e) {
            reject(e);
          }
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private startSubscription(): void {
    try {
      this.subSocket = connect(this.socketPath, () => {
        this.connected = true;
        this.subSocket?.write(
          JSON.stringify({
            method: "events.subscribe",
            params: {
              subscriptions: [
                { type: "workspace.created" },
                { type: "workspace.updated" },
                { type: "workspace.closed" },
                { type: "tab.created" },
                { type: "tab.closed" },
                { type: "tab.focused" },
                { type: "pane.created" },
                { type: "pane.closed" },
                { type: "pane.updated" },
                { type: "pane.focused" },
                { type: "pane.agent_detected" },
                { type: "layout.updated" },
              ],
            },
            id: "sub-pigeon",
          }) + "\n"
        );
      });

      let buffer = "";
      this.subSocket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line) {
            this.handleLine(line);
          }
        }
      });

      this.subSocket.on("error", () => {
        // Handled silently to avoid unhandled exception crash
      });

      this.subSocket.on("close", () => {
        this.subSocket = null;
        // Reconnect after 3s
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          this.startSubscription();
        }, 3000);
      });
    } catch {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.startSubscription();
      }, 3000);
    }
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line);
      if (msg.event) {
        this.handleHerdrEvent(msg.event, msg.params || msg.data);
      } else if (msg.type === "event" || msg.type === "notification") {
        this.handleHerdrEvent(msg.event || msg.name, msg.params || msg.data);
      }
    } catch {}
  }

  public async refreshSnapshot(): Promise<SnapshotPayload> {
    try {
      const res: HerdrSnapshotResult = await this.request("session.snapshot", {});
      if (res && res.snapshot) {
        const snap = res.snapshot;
        this.focusedPaneId = snap.focused_pane_id || null;

        const snapWorkspaces = snap.workspaces || [];
        const allTabs = snap.tabs || [];
        const allPanes = snap.panes || [];
        const allAgents = snap.agents || [];

        const agentMap = new Map<string, any>();
        for (const ag of allAgents) {
          if (ag.pane_id) agentMap.set(ag.pane_id, ag);
        }

        const panesByTab = new Map<string, any[]>();
        for (const p of allPanes) {
          const list = panesByTab.get(p.tab_id) || [];
          list.push(p);
          panesByTab.set(p.tab_id, list);

          if (p.pane_id) {
            this.paneLocations.set(p.pane_id, {
              workspaceId:
                p.workspace_id || (p.pane_id.includes(":") ? p.pane_id.split(":")[0] : "w1"),
              tabId: p.tab_id || "t1",
            });

            const ag = agentMap.get(p.pane_id);
            const sessionObj = p.agent_session || ag?.agent_session;
            if (sessionObj && sessionObj.value) {
              this.paneAgentSessions.set(p.pane_id, {
                agent: sessionObj.agent || p.agent || ag?.agent || ag?.kind || "unknown",
                sessionId: sessionObj.value,
              });
            }
          }
        }

        const tabsByWs = new Map<string, any[]>();
        for (const t of allTabs) {
          const list = tabsByWs.get(t.workspace_id) || [];
          list.push(t);
          tabsByWs.set(t.workspace_id, list);
        }

        const workingAgents: WorkingAgentSummary[] = [];

        const workspaces: WorkspaceSummary[] = snapWorkspaces.map((w) => {
          const rawTabs = w.tabs && w.tabs.length > 0 ? w.tabs : tabsByWs.get(w.workspace_id) || [];
          let wsHasWarn = false;
          let wsHasWorking = false;

          const tabs: TabSummary[] = rawTabs.map((t: any) => {
            const rawPanes = t.panes && t.panes.length > 0 ? t.panes : panesByTab.get(t.tab_id) || [];
            const panes: PaneSummary[] = rawPanes.map((p: any, idx: number) => {
              const ag = agentMap.get(p.pane_id);
              const cached = this.paneStates.get(p.pane_id);
              const rawStatus = ag?.status || p.agent_status || cached?.agentStatus;
              const agentStatus = this.normalizeStatus(rawStatus);

              if (agentStatus === "blocked") wsHasWarn = true;
              if (agentStatus === "working") wsHasWorking = true;

              const agentName = ag?.name || p.title || p.pane_id;
              const agentKind = ag?.kind || p.agent || null;

              if (ag || agentKind || agentStatus === "working" || agentStatus === "blocked") {
                const paneState = this.paneStates.get(p.pane_id);
                let summary = "";
                if (paneState?.pendingInteraction) {
                  summary = paneState.pendingInteraction.question || paneState.pendingInteraction.title;
                } else if (paneState?.cards && paneState.cards.length > 0) {
                  const lastCard = paneState.cards[paneState.cards.length - 1];
                  if (lastCard.kind === "tool_call") summary = `运行 ${lastCard.command}`;
                  else if (lastCard.kind === "thought") summary = lastCard.title || "正在思考";
                  else if (lastCard.kind === "markdown") summary = lastCard.content.slice(0, 40);
                } else if (ag?.terminal_title && !["agy", "bash", "sh", "zsh", "opencode", "claude", "agent"].includes(ag.terminal_title.toLowerCase().trim())) {
                  summary = ag.terminal_title;
                }

                workingAgents.push({
                  agent: agentKind || agentName,
                  name: agentName,
                  status: agentStatus,
                  workspaceId: w.workspace_id,
                  workspaceLabel: w.label || `Workspace ${w.number}`,
                  tabId: t.tab_id,
                  paneId: p.pane_id,
                  summary: summary || undefined,
                });
              }

              return {
                id: p.pane_id,
                agent: agentKind,
                agentStatus,
                isPrimary: idx === 0,
                name: agentName,
              };
            });

            let tabLabel = t.label;
            // If tab label is missing or just a raw digit like "1", resolve friendly name from primary pane
            if (!tabLabel || /^\d+$/.test(tabLabel.trim())) {
              const primaryPane = panes[0];
              if (primaryPane?.agent === "opencode") tabLabel = "OpenCode";
              else if (primaryPane?.agent === "agy") tabLabel = "Antigravity";
              else if (primaryPane?.agent === "claude") tabLabel = "Claude Code";
              else if (primaryPane?.name && !primaryPane.name.startsWith(primaryPane.id) && !primaryPane.name.includes(":p")) {
                tabLabel = primaryPane.name;
              } else {
                tabLabel = `Tab ${t.number || 1}`;
              }
            }

            return {
              id: t.tab_id,
              label: tabLabel,
              paneCount: panes.length,
              panes,
            };
          });

          return {
            id: w.workspace_id,
            label: w.label || `Workspace ${w.number}`,
            tabCount: tabs.length,
            activeTabId: w.active_tab_id || (tabs[0]?.id ?? null),
            hasWarn: wsHasWarn,
            hasWorking: wsHasWorking,
            isFocused: !!w.focused,
            tabs,
          };
        });

        this.currentSnapshot = {
          workspaces,
          workingAgents,
        };
        this.emit("snapshot_updated", this.currentSnapshot);
        return this.currentSnapshot;
      }
    } catch {}
    return this.currentSnapshot;
  }

  public normalizeStatus(rawStatus?: string): AgentStatus {
    if (!rawStatus) return "unknown";
    const s = rawStatus.toLowerCase();
    if (s === "idle") return "idle";
    if (s === "working" || s === "busy" || s === "running") return "working";
    if (s === "blocked" || s === "waiting" || s === "prompt") return "blocked";
    if (s === "done" || s === "finished" || s === "completed") return "done";
    return "unknown";
  }

  public getSnapshot(): SnapshotPayload {
    return this.currentSnapshot;
  }

  public getFocusedPaneId(): string | null {
    return this.focusedPaneId;
  }

  private handleHerdrEvent(event: string, params: any = {}): void {
    if (!event) return;
    const norm = event.replace(/_/g, ".");

    if (
      norm.startsWith("tab.") ||
      norm.startsWith("workspace.") ||
      norm === "pane.created" ||
      norm === "pane.closed"
    ) {
      this.refreshSnapshot();
    }

    if (norm === "pane.agent.status.changed" || norm === "pane.agent_status_changed") {
      const paneId = params.pane_id || params.paneId;
      const status = this.normalizeStatus(params.status || params.agent_status);
      this.updatePaneStatus(paneId, status);
    }

    if (
      norm === "pane.output.changed" ||
      norm === "pane.updated" ||
      norm === "pane.scroll.changed"
    ) {
      const paneId = params.pane_id || params.paneId;
      if (paneId) {
        this.scheduleDebouncedRead(paneId);
      }
    }
  }

  public updatePaneStatus(paneId: string, status: AgentStatus): void {
    const existing = this.paneStates.get(paneId);
    if (existing) {
      existing.agentStatus = status;
      this.emit("pane_status_changed", { paneId, status });
    }
  }

  public scheduleDebouncedRead(paneId: string): void {
    const timer = this.paneDebounceTimers.get(paneId);
    if (timer) clearTimeout(timer);

    const newTimer = setTimeout(async () => {
      this.paneDebounceTimers.delete(paneId);
      await this.readAndClassifyPane(paneId);
    }, this.debounceMs);

    this.paneDebounceTimers.set(paneId, newTimer);
  }

  public async readAndClassifyPane(paneId: string): Promise<PaneStatePayload | null> {
    try {
      let rawScreen = "";
      let readWsId: string | undefined;
      let readTabId: string | undefined;
      try {
        const readRes = await this.request("pane.read", {
          pane_id: paneId,
          source: "recent_unwrapped",
        });
        rawScreen = readRes?.read?.text || readRes?.text || readRes?.data || "";
        readWsId = readRes?.read?.workspace_id;
        readTabId = readRes?.read?.tab_id;
      } catch {
        // Fallback to visible
        const readRes = await this.request("pane.read", {
          pane_id: paneId,
          source: "visible",
        });
        rawScreen = readRes?.read?.text || readRes?.text || readRes?.data || "";
        readWsId = readRes?.read?.workspace_id;
        readTabId = readRes?.read?.tab_id;
      }

      if (readWsId && readTabId) {
        this.paneLocations.set(paneId, { workspaceId: readWsId, tabId: readTabId });
      }

      // SHA-256 deduplication
      const contentHash = createHash("sha256").update(rawScreen).digest("hex");
      const prevHash = this.paneContentHashes.get(paneId);
      const existing = this.paneStates.get(paneId);

      const { cards, pendingInteraction } = this.classifier.classifyScreen(rawScreen);
      let agentStatus = existing?.agentStatus || "idle";
      if (pendingInteraction) {
        agentStatus = "blocked";
      }

      if (
        prevHash === contentHash &&
        existing &&
        existing.agentStatus === agentStatus &&
        ((!existing.pendingInteraction && !pendingInteraction) ||
          (existing.pendingInteraction?.fingerprint === pendingInteraction?.fingerprint))
      ) {
        // No changes, skip emitting update
        return existing;
      }

      this.paneContentHashes.set(paneId, contentHash);
      const revision = (existing?.revision || 0) + 1;

      let loc = this.paneLocations.get(paneId);
      if (!loc && this.currentSnapshot) {
        for (const w of this.currentSnapshot.workspaces) {
          for (const t of w.tabs) {
            if (t.panes?.some((p) => p.id === paneId)) {
              loc = { workspaceId: w.id, tabId: t.id };
              this.paneLocations.set(paneId, loc);
              break;
            }
          }
          if (loc) break;
        }
      }

      const workspaceId =
        readWsId ||
        loc?.workspaceId ||
        existing?.workspaceId ||
        (paneId.includes(":") ? paneId.split(":")[0] : "w1");
      const tabId = readTabId || loc?.tabId || existing?.tabId || "t1";

      const payload: PaneStatePayload = {
        paneId,
        workspaceId,
        tabId,
        agentStatus,
        cards,
        pendingInteraction,
        activeGhost: null,
        rawScreen,
        revision,
      };

      this.paneStates.set(paneId, payload);
      this.emit("cards_updated", { paneId, cards, pendingInteraction, revision, rawScreen });
      return payload;
    } catch {
      return null;
    }
  }

  public getPaneState(paneId: string): PaneStatePayload {
    const existing = this.paneStates.get(paneId);
    if (existing) return existing;

    let loc = this.paneLocations.get(paneId);
    if (!loc && this.currentSnapshot) {
      for (const w of this.currentSnapshot.workspaces) {
        for (const t of w.tabs) {
          if (t.panes?.some((p) => p.id === paneId)) {
            loc = { workspaceId: w.id, tabId: t.id };
            this.paneLocations.set(paneId, loc);
            break;
          }
        }
        if (loc) break;
      }
    }

    const initial: PaneStatePayload = {
      paneId,
      workspaceId:
        loc?.workspaceId || (paneId.includes(":") ? paneId.split(":")[0] : "w1"),
      tabId: loc?.tabId || "t1",
      agentStatus: "idle",
      cards: [],
      pendingInteraction: null,
      activeGhost: null,
      rawScreen: "",
      revision: 1,
    };
    this.paneStates.set(paneId, initial);
    return initial;
  }

  public async sendAgentPrompt(paneId: string, text: string): Promise<void> {
    try {
      await this.request("agent.prompt", { pane_id: paneId, text });
    } catch (err: any) {
      const msg = (err?.message || String(err)).toLowerCase();
      // If agent is blocked or request timed out, fail loudly per AGENTS.md rather than double-sending
      if (msg.includes("blocked") || msg.includes("timeout")) {
        throw err;
      }
      // Only fallback to sendInput if the agent.prompt method is unsupported by Herdr / agent
      if (msg.includes("not found") || msg.includes("not recognized") || msg.includes("unknown_method")) {
        await this.sendInput(paneId, text);
        return;
      }
      throw err;
    }
    this.scheduleDebouncedRead(paneId);
  }

  public async sendInteractionApproval(paneId: string, keys: string[]): Promise<boolean> {
    try {
      await this.request("agent.send_keys", { pane_id: paneId, keys });
    } catch {
      await this.request("pane.send_keys", { pane_id: paneId, keys });
    }

    // Wait 150ms and re-read screen to confirm prompt disappeared per spec
    await new Promise((r) => setTimeout(r, 150));
    await this.readAndClassifyPane(paneId);
    const state = this.getPaneState(paneId);
    return state.pendingInteraction === null;
  }

  public async sendInput(paneId: string, text: string): Promise<void> {
    await this.request("pane.send_text", { pane_id: paneId, text });
    await this.request("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
    this.scheduleDebouncedRead(paneId);
  }

  public async sendKeys(paneId: string, keys: string[]): Promise<void> {
    await this.request("pane.send_keys", { pane_id: paneId, keys });
    this.scheduleDebouncedRead(paneId);
  }

  public validateAgentName(name: string): boolean {
    return /^[a-z][a-z0-9_-]{0,31}$/.test(name);
  }

  public async createTabAndAgent(workspaceId: string, agentKind: string, cwd?: string): Promise<any> {
    const isTerminal = agentKind === "terminal" || agentKind === "shell";
    if (!isTerminal && !this.validateAgentName(agentKind)) {
      throw new Error(`Invalid agent name '${agentKind}'. Must match [a-z][a-z0-9_-]{0,31}`);
    }

    const tabRes = await this.request("tab.create", {
      workspace_id: workspaceId,
      ...(cwd ? { cwd } : {}),
    });

    const tabId = tabRes?.tab?.tab_id || tabRes?.tab_id || tabRes?.id;
    const rootPaneId = tabRes?.root_pane?.pane_id || tabRes?.pane_id || tabRes?.root_pane_id;

    if (rootPaneId && !isTerminal) {
      const hex4 = Math.random().toString(16).substring(2, 6);
      const name = `p-${agentKind}-${hex4}`;
      await this.request("agent.start", {
        pane_id: rootPaneId,
        kind: agentKind,
        name,
      });
    }

    await this.refreshSnapshot();
    return { tabId, paneId: rootPaneId };
  }
}
