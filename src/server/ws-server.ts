import { randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { HerdrError, type HerdrClient } from "./herdr-client";
import type { DeviceSession } from "./pairing";
import type { PushManager } from "./push";
import type { ConfigManager } from "./config-manager";
import { AgentAdapterManager } from "./agent-adapters/index";
import { PaneStore } from "./pane-store";
import { SkillScanner } from "./skill-scanner";
import { getAgentRecipe, listAgentRecipes } from "./agent-recipes";
import { validateClientMessage } from "./ws-validate";
import {
  type ClientMessage,
  type ServerMessage,
  ProtocolErrors,
  type ClientConfig,
  type AgentRecipeSummary,
  type PaneStatePayload,
} from "../types/protocol";

export const PROTOCOL_VERSION = "1.0.0";
export const SERVER_VERSION = "0.1.0";
const PUSH_DEDUPE_MS = 60_000;

export interface WsServerOptions {
  herdrClient: HerdrClient;
  pushManager: PushManager;
  configManager: ConfigManager;
  agentAdapters?: AgentAdapterManager;
  skillScanner?: SkillScanner;
}

export interface ClientConnectionData {
  session: DeviceSession;
  connectionId: string;
  subscribedPaneId: string | null;
  lastPingTime: number;
}

type Ws = ServerWebSocket<ClientConnectionData>;

/** Herdr error codes the spec lists (herdr-adapter.md §6) and the protocol code each maps to. */
const HERDR_ERROR_MAP: Record<string, string> = {
  agent_blocked: ProtocolErrors.ERR_AGENT_BLOCKED,
  agent_not_ready: ProtocolErrors.ERR_AGENT_NOT_READY,
  agent_prompt_stalled: ProtocolErrors.ERR_TIMEOUT,
  timeout: ProtocolErrors.ERR_TIMEOUT,
  pane_not_found: ProtocolErrors.ERR_NOT_FOUND,
};

export function newConnectionId(): string {
  return `conn_${randomBytes(6).toString("hex")}`;
}

export class WsServer {
  private herdrClient: HerdrClient;
  private pushManager: PushManager;
  public configManager: ConfigManager;
  public agentAdapters: AgentAdapterManager;
  public paneStore: PaneStore;
  public skillScanner: SkillScanner;
  private clients = new Set<Ws>();
  private configVersion = 1;
  private lastStatus = new Map<string, string>();
  private lastPushAt = new Map<string, number>();

  constructor(options: WsServerOptions) {
    this.herdrClient = options.herdrClient;
    this.pushManager = options.pushManager;
    this.configManager = options.configManager;
    this.agentAdapters = options.agentAdapters || new AgentAdapterManager();
    this.paneStore = new PaneStore(this.agentAdapters);
    this.skillScanner = options.skillScanner || new SkillScanner();

    this.herdrClient.on("connected", () => this.paneStore.setHerdrStatus(true));
    this.herdrClient.on("disconnected", () => this.paneStore.setHerdrStatus(false));
    this.paneStore.on("upstream_status", (status) => this.broadcast({ type: "upstream_status", payload: status }));
    this.paneStore.on("turns_delta", (delta) => this.sendToSubscribers(delta.paneId, { type: "turns_delta", payload: delta }));

    this.herdrClient.on("snapshot_updated", (snapshot) => {
      for (const paneId of this.paneStore.trackedPaneIds()) {
        if (!this.herdrClient.hasPane(paneId)) this.paneStore.closePane(paneId);
      }
      this.broadcast({ type: "snapshot_update", payload: snapshot });
    });

    this.herdrClient.on("cards_updated", (state: PaneStatePayload) => {
      this.sendToSubscribers(state.paneId, { type: "pane_state", payload: state });
    });

    this.herdrClient.on("pane_status_changed", ({ paneId, status }: { paneId: string; status: string }) => {
      const previous = this.lastStatus.get(paneId);
      this.lastStatus.set(paneId, status);
      // push.md §4: notify only on the transition into blocked, at most once per minute per pane.
      if (status !== "blocked" || previous === "blocked") return;
      const now = Date.now();
      if (now - (this.lastPushAt.get(paneId) || 0) < PUSH_DEDUPE_MS) return;
      this.lastPushAt.set(paneId, now);
      this.pushManager.sendNotification(paneId, { title: "Agent 等待确认", body: "有一个 Agent 需要你的回应" });
    });
  }

  public handleOpen(ws: Ws): void {
    this.clients.add(ws);
  }

  public handleClose(ws: Ws): void {
    this.clients.delete(ws);
    this.pushManager.removePresence(ws.data.connectionId);
    this.syncMonitoredPanes();
  }

  private syncMonitoredPanes(): void {
    const panes = new Set<string>();
    for (const ws of this.clients) if (ws.data.subscribedPaneId) panes.add(ws.data.subscribedPaneId);
    this.herdrClient.setMonitoredPanes(panes);
  }

  private sendToSubscribers(paneId: string, msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.data.subscribedPaneId === paneId) ws.send(text);
  }

  private recipeSummaries(): Record<string, AgentRecipeSummary> {
    const recipes: Record<string, AgentRecipeSummary> = {};
    for (const r of listAgentRecipes()) {
      recipes[r.kind] = {
        kind: r.kind,
        label: r.label,
        models: r.models(),
        defaultModel: r.defaultModel,
        defaultThinking: r.defaultThinking,
        interruptKeys: r.interruptKeys,
      };
    }
    return recipes;
  }

  public async handleMessage(ws: Ws, rawData: string | Buffer): Promise<void> {
    const text = typeof rawData === "string" ? rawData : rawData.toString("utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.sendError(ws, undefined, ProtocolErrors.ERR_INVALID_PAYLOAD, "Malformed JSON payload");
      return;
    }
    const validation = validateClientMessage(parsed);
    if (!validation.ok) {
      this.sendError(ws, validation.id, ProtocolErrors.ERR_INVALID_PAYLOAD, validation.error);
      return;
    }
    const msg = validation.msg;
    try {
      await this.dispatch(ws, msg);
    } catch (err) {
      const replyTo = "id" in msg ? msg.id : undefined;
      if (err instanceof HerdrError) {
        this.sendError(ws, replyTo, HERDR_ERROR_MAP[err.code] || ProtocolErrors.ERR_INTERNAL, err.message);
      } else {
        console.error(`[pigeon] handling '${msg.type}' failed:`, err);
        this.sendError(ws, replyTo, ProtocolErrors.ERR_INTERNAL, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async dispatch(ws: Ws, msg: ClientMessage): Promise<void> {
    const data = ws.data;
    switch (msg.type) {
      case "hello": {
        if (msg.payload.protocolVersion.split(".")[0] !== PROTOCOL_VERSION.split(".")[0]) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INCOMPATIBLE_PROTOCOL, `Server speaks protocol ${PROTOCOL_VERSION}`);
          ws.close(4409, "Incompatible protocol version");
          return;
        }
        this.send(ws, {
          type: "welcome",
          replyTo: msg.id,
          payload: {
            protocolVersion: PROTOCOL_VERSION,
            serverVersion: SERVER_VERSION,
            deviceId: data.session.deviceId,
            clientConfig: this.configManager.getClientConfig(),
            recipes: this.recipeSummaries(),
          },
        });
        this.send(ws, { type: "upstream_status", payload: this.paneStore.getHerdrStatus() });
        this.send(ws, { type: "snapshot_update", payload: this.herdrClient.getSnapshot() });

        const requested = msg.payload.subscribePaneId;
        const paneId =
          requested && this.herdrClient.hasPane(requested) ? requested : this.herdrClient.getFocusedPaneId();
        if (paneId && this.herdrClient.hasPane(paneId)) await this.bootstrapPane(ws, paneId);
        return;
      }

      case "ping":
        data.lastPingTime = Date.now();
        this.send(ws, { type: "pong", timestamp: Date.now() });
        return;

      case "presence_update":
        this.pushManager.updatePresence(data.connectionId, msg.isVisible, msg.viewingPaneId);
        return;

      case "select_view": {
        if (!this.herdrClient.hasPane(msg.payload.paneId)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Unknown pane ${msg.payload.paneId}`);
          return;
        }
        await this.bootstrapPane(ws, msg.payload.paneId);
        this.sendAck(ws, msg.id);
        return;
      }

      case "agent_prompt": {
        const { targetPaneId, text } = msg.payload;
        if (!this.requireKnownPane(ws, msg.id, targetPaneId)) return;
        await this.herdrClient.sendPrompt(targetPaneId, text);
        this.sendAck(ws, msg.id);
        return;
      }

      case "agent_send_keys": {
        const { targetPaneId, keys } = msg.payload;
        if (!this.requireKnownPane(ws, msg.id, targetPaneId)) return;
        await this.herdrClient.sendKeys(targetPaneId, keys);
        this.sendAck(ws, msg.id);
        return;
      }

      case "interaction_respond": {
        const { targetPaneId, interactionId, fingerprint, optionId } = msg.payload;
        if (!this.requireKnownPane(ws, msg.id, targetPaneId)) return;
        const pending = this.herdrClient.getPaneState(targetPaneId)?.pendingInteraction;
        if (!pending || pending.interactionId !== interactionId || pending.fingerprint !== fingerprint) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INTERACTION_STALE, "The prompt changed or was already answered.");
          return;
        }
        const option = pending.options.find((o) => o.id === optionId);
        if (!option?.keyShortcut) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `Unknown optionId '${optionId}'`);
          return;
        }
        // protocol.md §4.1: send exactly the option's key; a prompt still on screen afterwards
        // is reported as not approved so the client falls back to the terminal view.
        const approved = await this.herdrClient.answerInteraction(targetPaneId, interactionId, [option.keyShortcut]);
        this.sendAck(ws, msg.id, { approved, interactionId });
        return;
      }

      case "create_tab_and_agent": {
        const { workspaceId, agentKind, modelId, thinking, cwd } = msg.payload;
        const recipe = getAgentRecipe(agentKind);
        if (!recipe) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `Unknown agent kind '${agentKind}'`);
          return;
        }
        const model = modelId ? recipe.models().find((m) => m.id === modelId) : undefined;
        if (modelId && !model) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `Unknown model '${modelId}' for ${agentKind}`);
          return;
        }
        if (thinking && !(model?.thinkingLevels || []).includes(thinking)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `Thinking level '${thinking}' is not offered for this model`);
          return;
        }
        const res = await this.herdrClient.createTabAndAgent(workspaceId, recipe.kind, { modelId, thinking, cwd });
        this.sendAck(ws, msg.id, { workspaceId, tabId: res.tabId, paneId: res.paneId });
        return;
      }

      case "close_tab":
        await this.herdrClient.closeTab(msg.payload.tabId);
        this.sendAck(ws, msg.id, { closedTabId: msg.payload.tabId });
        return;

      case "skills_get":
        this.sendSkills(ws, data.subscribedPaneId, msg.id);
        return;

      case "config_get":
        this.send(ws, {
          type: "config_sync",
          replyTo: msg.id,
          payload: { version: this.configVersion, client: this.configManager.getClientConfig() },
        });
        return;

      case "config_patch": {
        const client = this.configManager.patchClientConfig(msg.payload.client);
        this.configVersion++;
        this.sendAck(ws, msg.id, { version: this.configVersion, client });
        this.broadcastConfigUpdated(client, ws);
        return;
      }
    }
  }

  /** Subscribes the connection to one pane and sends everything the client needs to render it. */
  private async bootstrapPane(ws: Ws, paneId: string): Promise<void> {
    ws.data.subscribedPaneId = paneId;
    this.syncMonitoredPanes();

    const session = this.herdrClient.getPaneAgentSession(paneId);
    if (session && this.agentAdapters.isSupported(session.agent)) {
      this.paneStore.registerPaneSession(paneId, session.agent, session.sessionId);
    }
    // Always sent, empty for panes without a structured session, so the client never keeps
    // showing the previous pane's conversation.
    const { turns, stats, sessionTitle } = this.paneStore.getPaneTurns(paneId);
    this.send(ws, { type: "normalized_turns", payload: { paneId, turns, sessionStats: stats, sessionTitle } });

    this.sendSkills(ws, paneId);
    // The cached state renders at once; the fresh read reaches this subscriber as a `cards_updated`
    // pane_state only when the screen changed, so the client never gets the same state twice.
    const cached = this.herdrClient.getPaneState(paneId);
    if (cached) this.send(ws, { type: "pane_state", payload: cached });
    await this.herdrClient.readAndClassifyPane(paneId);
  }

  /** Skills are per pane: they depend on the agent kind and the project directory. */
  private sendSkills(ws: Ws, paneId: string | null, replyTo?: string): void {
    const skills = paneId
      ? this.skillScanner.listSkills(this.herdrClient.getPaneAgentKind(paneId), this.herdrClient.getPaneCwd(paneId))
      : [];
    this.send(ws, { type: "skills_sync", replyTo, payload: { paneId, skills, recipes: this.recipeSummaries() } });
  }

  private requireKnownPane(ws: Ws, replyTo: string, paneId: string): boolean {
    if (this.herdrClient.hasPane(paneId)) return true;
    this.sendError(ws, replyTo, ProtocolErrors.ERR_NOT_FOUND, `Unknown pane ${paneId}`);
    return false;
  }

  public broadcastConfigUpdated(client: ClientConfig, origin?: Ws): void {
    const text = JSON.stringify({ type: "config_updated", payload: { version: this.configVersion, client } } satisfies ServerMessage);
    for (const ws of this.clients) if (ws !== origin) ws.send(text);
  }

  private send(ws: Ws, msg: ServerMessage): void {
    ws.send(JSON.stringify(msg));
  }

  private sendAck(ws: Ws, replyTo: string, payload?: Record<string, any>): void {
    this.send(ws, { type: "ack", replyTo, payload: { status: "ok", ...(payload || {}) } });
  }

  private sendError(ws: Ws, replyTo: string | undefined, code: string, message: string): void {
    this.send(ws, { type: "error", replyTo, error: { code, message } });
  }

  public broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const ws of this.clients) ws.send(text);
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }

  public closeDevice(deviceId: string): void {
    for (const ws of Array.from(this.clients)) {
      if (ws.data.session.deviceId === deviceId) {
        ws.close(4403, "Device session revoked");
        this.clients.delete(ws);
      }
    }
    this.syncMonitoredPanes();
  }

  public destroy(): void {
    this.paneStore.destroy();
  }
}
