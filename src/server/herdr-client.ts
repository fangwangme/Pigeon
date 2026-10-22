import { connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { CardClassifier } from "./card-classifier";
import type { AgentStatus, Card, InteractionCardData, PaneStatePayload, SnapshotPayload } from "../types/protocol";
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
  private paneDebounceTimers = new Map<string, NodeJS.Timeout>();
  private currentSnapshot: SnapshotPayload = { workspaces: [], workingAgents: [] };
  private focusedPaneId: string | null = null;

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
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public disconnect(): void {
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
                { type: "tab.created" },
                { type: "tab.closed" },
                { type: "tab.focused" },
                { type: "pane.created" },
                { type: "pane.closed" },
                { type: "pane.focused" },
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
        this.focusedPaneId = snap.focused_pane_id;

        const workspaces = (snap.workspaces || []).map((w) => ({
          id: w.workspace_id,
          label: w.label || `Workspace ${w.number}`,
          tabCount: w.tab_count || 1,
          activeTabId: w.active_tab_id || null,
          tabs: (w.tabs || []).map((t) => ({
            id: t.tab_id,
            label: t.label || "tab",
            paneCount: t.panes?.length || 1,
            panes: (t.panes || []).map((p, idx) => ({
              id: p.pane_id,
              agent: p.agent || null,
              agentStatus: this.normalizeStatus(p.agent_status),
              isPrimary: idx === 0,
              name: p.title || p.pane_id,
            })),
          })),
        }));

        this.currentSnapshot = {
          workspaces,
          workingAgents: [],
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

    if (
      event.startsWith("tab.") ||
      event.startsWith("workspace.") ||
      event === "pane.created" ||
      event === "pane.closed"
    ) {
      this.refreshSnapshot();
    }

    if (event === "pane_agent_status_changed" || event === "pane.agent_status_changed") {
      const paneId = params.pane_id || params.paneId;
      const status = this.normalizeStatus(params.status || params.agent_status);
      this.updatePaneStatus(paneId, status);
    }

    if (event === "pane_output_changed" || event === "pane.updated" || event === "pane.scroll_changed") {
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
      try {
        const readRes = await this.request("pane.read", {
          pane_id: paneId,
          source: "recent_unwrapped",
        });
        rawScreen = readRes?.text || readRes?.data || "";
      } catch {
        // Fallback to visible
        const readRes = await this.request("pane.read", {
          pane_id: paneId,
          source: "visible",
        });
        rawScreen = readRes?.text || readRes?.data || "";
      }

      const { cards, pendingInteraction } = this.classifier.classifyScreen(rawScreen);
      const existing = this.paneStates.get(paneId);
      const revision = (existing?.revision || 0) + 1;

      const payload: PaneStatePayload = {
        paneId,
        workspaceId: existing?.workspaceId || "w1",
        tabId: existing?.tabId || "t1",
        agentStatus: existing?.agentStatus || "idle",
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

    const initial: PaneStatePayload = {
      paneId,
      workspaceId: "w1",
      tabId: "t1",
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

  public async sendInput(paneId: string, text: string): Promise<void> {
    await this.request("pane.send_text", { pane_id: paneId, text: text.endsWith("\n") ? text : text + "\n" });
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
    if (!this.validateAgentName(agentKind)) {
      throw new Error(`Invalid agent name '${agentKind}'. Must match [a-z][a-z0-9_-]{0,31}`);
    }

    const tabRes = await this.request("tab.create", { workspace_id: workspaceId });
    const tabId = tabRes?.tab_id || tabRes?.id;

    if (tabId) {
      await this.request("agent.start", {
        tab_id: tabId,
        agent: agentKind,
        cwd,
      });
    }

    await this.refreshSnapshot();
    return { tabId };
  }
}
