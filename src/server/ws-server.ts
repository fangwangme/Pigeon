import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ServerWebSocket } from "bun";
import { HerdrError, UNREACHABLE_CODES, type HerdrClient } from "./herdr-client";
import type { DeviceSession, PairingManager } from "./pairing";
import type { UploadStore } from "./uploads";
import type { PushManager, PushMessage } from "./push";
import { type ConfigManager, resolveProductionPort, DEFAULT_PORT } from "./config-manager";
import { AgentAdapterManager } from "./agent-adapters/index";
import { PaneStore } from "./pane-store";
import { SkillScanner } from "./skill-scanner";
import { getAgentRecipe, listAgentRecipes } from "./agent-recipes";
import { ModelCatalog } from "./model-catalog";
import { validateClientMessage } from "./ws-validate";
import { computeInteractionFingerprint } from "./card-classifier";
import {
  type ClientMessage,
  type ServerMessage,
  ProtocolErrors,
  type ClientConfig,
  type AgentRecipeSummary,
  type PaneStatePayload,
  type InteractionCardData,
  type InteractionOption,
  type QueuedPrompt,
  type HaveInfo,
  type TurnsDeltaPayload,
  type NormalizedTurnsPayload,
  type NormalizedTurn,
  type PaneTailPayload,
  type AgentStatus,
  toLightTurn,
  toLightStats,
  hashTurn,
} from "../types/protocol";

const PROTOCOL_VERSION = "1.0.0";
import pkg from "../../package.json";
export const SERVER_VERSION = pkg.version;
const PUSH_DEDUPE_MS = 60_000;

import { QuotaService } from "./quota/index";
import { UsageService } from "./usage/index";

export interface WsServerOptions {
  /** Identifies the client bundle being served (protocol.md §3.2). */
  buildId: string;
  herdrClient: HerdrClient;
  pushManager: PushManager;
  configManager: ConfigManager;
  agentAdapters?: AgentAdapterManager;
  skillScanner?: SkillScanner;
  /** Attachments (`protocol.md` §7); without it, prompts with attachments are refused. */
  uploadStore?: UploadStore;
  /** Device management from the phone (`protocol.md` §4.12). */
  pairingManager?: PairingManager;
  /** Every agent's model list (`herdr-adapter.md` §7.1); without it only the static lists are known. */
  modelCatalog?: ModelCatalog;
  quotaService?: QuotaService;
  usageService?: UsageService;
  queueFilePath?: string;
  queueSendTimeoutMs?: number;
  port?: number;
  productionPort?: number;
  environmentKind?: "production" | "dev" | "test";
}

export interface ClientConnectionData {
  session: DeviceSession;
  connectionId: string;
  subscribedPaneId: string | null;
  watchingScreenPaneId?: string;
  lastPingTime: number;
}

type Ws = ServerWebSocket<ClientConnectionData>;

/** Herdr error codes the spec lists (herdr-adapter.md §6) and the protocol code each maps to. */
// herdr-adapter.md §6: Herdr Core error kinds.
const HERDR_ERROR_MAP: Record<string, string> = {
  blocked: ProtocolErrors.ERR_AGENT_BLOCKED,
  unavailable: ProtocolErrors.ERR_AGENT_NOT_READY,
  not_found: ProtocolErrors.ERR_NOT_FOUND,
  finished: ProtocolErrors.ERR_NOT_FOUND,
  timeout: ProtocolErrors.ERR_TIMEOUT,
  ECONNREFUSED: ProtocolErrors.ERR_UPSTREAM_OFFLINE,
  ENOENT: ProtocolErrors.ERR_UPSTREAM_OFFLINE,
  ECONNRESET: ProtocolErrors.ERR_UPSTREAM_OFFLINE,
  EPIPE: ProtocolErrors.ERR_UPSTREAM_OFFLINE,
  closed: ProtocolErrors.ERR_UPSTREAM_OFFLINE,
  socket_error: ProtocolErrors.ERR_UPSTREAM_OFFLINE,
};

export function newConnectionId(): string {
  return `conn_${randomBytes(6).toString("hex")}`;
}

export class WsServer {
  private buildId: string;
  private herdrClient: HerdrClient;
  private pushManager: PushManager;
  private modelCatalog: ModelCatalog;
  public configManager: ConfigManager;
  public agentAdapters: AgentAdapterManager;
  public paneStore: PaneStore;
  public skillScanner: SkillScanner;
  private clients = new Set<Ws>();
  private configVersion = 1;
  private lastStatus = new Map<string, string>();
  private lastPushAt = new Map<string, number>();
  // Panes whose prompt answer is still being sent; a second answer meanwhile is stale (protocol.md §4.1).
  private answeringPanes = new Set<string>();
  private uploadStore?: UploadStore;
  private pairingManager?: PairingManager;
  private quotaService?: QuotaService;
  private usageService?: UsageService;
  // protocol.md §4.2: prompts waiting for the pane's turn to end, oldest first.
  /** `item` is what the phone sees (its own text and upload ids, so **编辑** can restore them); `send` is the composed prompt. */
  private queueFilePath?: string;
  private queueSendTimeoutMs: number;
  private queues = new Map<string, Array<{ item: QueuedPrompt; send: string; created_ms: number }>>();
  private queueStates = new Map<string, { state: "idle" | "sending"; sawWorking: boolean; unboundSent: boolean; timer?: ReturnType<typeof setTimeout> }>();
  private restoredPaneIds = new Set<string>();
  private firstSnapshotSeen = false;

  private environment: { kind: "production" | "dev" | "test"; port: number };

  private onHerdrConnected: () => void;
  private onHerdrDisconnected: () => void;
  private onSnapshotUpdated: (snapshot: any) => void;
  private onCardsUpdated: (state: PaneStatePayload) => void;
  private onPaneStatusChanged: (event: { paneId: string; status: string }) => void;

  constructor(options: WsServerOptions) {
    this.buildId = options.buildId;
    this.queueFilePath = options.queueFilePath;
    this.queueSendTimeoutMs = options.queueSendTimeoutMs ?? 30_000;
    this.loadQueues();
    this.herdrClient = options.herdrClient;
    this.pushManager = options.pushManager;
    this.modelCatalog = options.modelCatalog ?? new ModelCatalog();
    this.configManager = options.configManager;
    this.agentAdapters = options.agentAdapters || new AgentAdapterManager();
    this.paneStore = new PaneStore(this.agentAdapters);
    this.skillScanner = options.skillScanner || new SkillScanner();
    this.uploadStore = options.uploadStore;
    this.pairingManager = options.pairingManager;
    this.quotaService = options.quotaService;
    this.usageService = options.usageService;
    const port = options.port ?? options.configManager?.getServerConfig().port ?? DEFAULT_PORT;
    const prodPort = options.productionPort ?? resolveProductionPort(options.configManager?.env);
    const isCompiled = process.execPath.endsWith("/pigeon") || !process.argv[1]?.endsWith(".ts");
    const isDev = options.environmentKind === "dev" || (!isCompiled && options.environmentKind !== "production");
    const isTest = options.environmentKind === "test" || (port !== prodPort && !isDev);
    const kind = options.environmentKind ?? (isDev ? "dev" : isTest ? "test" : "production");
    this.environment = { kind, port };
    // security-and-pairing.md §5: a revoked device (from the phone or `pigeon devices revoke`) is cut off at once.
    this.pairingManager?.on("device_revoked", (deviceId: string) => this.closeDevice(deviceId));

    this.onHerdrConnected = () => this.paneStore.setHerdrStatus(true);
    this.onHerdrDisconnected = () => this.paneStore.setHerdrStatus(false);
    this.herdrClient.on("connected", this.onHerdrConnected);
    this.herdrClient.on("disconnected", this.onHerdrDisconnected);

    this.paneStore.on("upstream_status", (status) => this.broadcast({ type: "upstream_status", payload: status }));
    this.paneStore.on("turns_delta", (delta) => {
      const lightDelta: TurnsDeltaPayload = {
        ...delta,
        appendTurns: delta.appendTurns?.map(toLightTurn),
        ...(delta.patchLastTurn ? { patchLastTurn: toLightTurn(delta.patchLastTurn) } : {}),
        ...(delta.sessionStats ? { sessionStats: toLightStats(delta.sessionStats) } : {}),
      };
      this.sendToSubscribers(delta.paneId, { type: "turns_delta", payload: lightDelta });
      if (delta.appendTurns && delta.appendTurns.length > 0) {
        const hasUser = delta.appendTurns.some((t: NormalizedTurn) => !!t.userPrompt);
        if (hasUser) this.transitionQueue(delta.paneId, { type: "user_turn" });
      }
      this.syncTranscriptInteraction(delta.paneId);
      const wasPaused = this.wasQueuePaused.get(delta.paneId) ?? false;
      const nowPaused = this.isQueuePaused(delta.paneId);
      this.wasQueuePaused.set(delta.paneId, nowPaused);
      if (wasPaused && !nowPaused) {
        this.sendQueue(delta.paneId);
        this.kickQueue(delta.paneId);
      }
      this.maybeSendPaneTail(delta.paneId);
    });
    this.paneStore.on("session_changed", (paneId: string) => {
      const payload = this.paneStore.getPayload(paneId, this.herdrClient.getPaneAgentKind(paneId));
      const lightPayload: NormalizedTurnsPayload = {
        ...payload,
        turns: payload.turns.map(toLightTurn),
        ...(payload.sessionStats ? { sessionStats: toLightStats(payload.sessionStats) } : {}),
      };
      this.sendToSubscribers(paneId, { type: "normalized_turns", payload: lightPayload });
      this.syncTranscriptInteraction(paneId);
      const wasPaused = this.wasQueuePaused.get(paneId) ?? false;
      const nowPaused = this.isQueuePaused(paneId);
      this.wasQueuePaused.set(paneId, nowPaused);
      if (wasPaused && !nowPaused) {
        this.sendQueue(paneId);
        this.kickQueue(paneId);
      }
      this.maybeSendPaneTail(paneId);
    });

    // herdr-adapter.md §7.1: a model named in a session's records that the catalog lacks fills it again.
    this.paneStore.on("session_model", (agent: string, model: string) => {
      void this.modelCatalog.noteModel(agent, model).then((changed) => changed && this.broadcastRecipes());
      queueMicrotask(() => this.herdrClient.relabelTabs());
    });
    this.paneStore.setModelResolver((agent, idOrLabel) => this.modelCatalog.resolve(agent, idOrLabel));
    this.herdrClient.setSessionTitleSource((paneId) => this.paneStore.sessionTitle(paneId));
    this.herdrClient.setSessionModelSource((paneId) => this.paneStore.sessionInfo(paneId, null).model.value ?? undefined);
    // Titles change while a snapshot is being handled (binding reads the session), so relabel after it.
    this.paneStore.on("title_changed", () => queueMicrotask(() => this.herdrClient.relabelTabs()));

    this.onSnapshotUpdated = (snapshot) => {
      if (!this.firstSnapshotSeen) {
        this.firstSnapshotSeen = true;
        for (const paneId of Array.from(this.restoredPaneIds)) {
          const entries = this.queues.get(paneId);
          if (!entries) continue;
          const paneFacts = this.herdrClient.getPaneFacts(paneId);
          const currentCreatedMs = paneFacts?.createdMs;
          const kept: Array<{ item: QueuedPrompt; send: string; created_ms: number }> = [];
          for (const entry of entries) {
            if (paneFacts && currentCreatedMs === entry.created_ms) {
              kept.push(entry);
            } else {
              console.log(`[Pigeon] Dropping restored queue item ${entry.item.queueId} for ${paneId}: terminal creation time mismatch (stored ${entry.created_ms}, current ${currentCreatedMs})`);
            }
          }
          if (kept.length > 0) {
            this.queues.set(paneId, kept);
            const status = this.herdrClient.getPaneHerdrStatus(paneId);
            if (status === "idle" || status === "done") {
              this.kickQueue(paneId);
            }
          } else {
            this.queues.delete(paneId);
          }
        }
        this.restoredPaneIds.clear();
      }

      for (const paneId of this.paneStore.trackedPaneIds()) {
        if (!this.herdrClient.hasPane(paneId)) this.paneStore.closePane(paneId);
      }
      for (const paneId of Array.from(this.queues.keys())) {
        if (!this.herdrClient.hasPane(paneId)) {
          this.transitionQueue(paneId, { type: "remove_pane" });
        }
      }
      for (const paneId of Array.from(this.lastStatus.keys())) {
        if (!this.herdrClient.hasPane(paneId)) {
          this.lastStatus.delete(paneId);
          this.lastPaneTailAt.delete(paneId);
          this.lastPushAt.delete(`${paneId}:blocked`);
          this.lastPushAt.delete(`${paneId}:done`);
        }
      }
      this.saveQueues();
      this.broadcast({ type: "snapshot_update", payload: snapshot });
      this.rebindSessions();
    };
    this.herdrClient.on("snapshot_updated", this.onSnapshotUpdated);
    this.rebindSessions();

    this.onCardsUpdated = (state: PaneStatePayload) => {
      this.sendToSubscribers(state.paneId, { type: "pane_state", payload: state });
    };
    this.herdrClient.on("cards_updated", this.onCardsUpdated);

    this.onPaneStatusChanged = ({ paneId, status }: { paneId: string; status: string }) => {
      const previous = this.lastStatus.get(paneId);
      this.lastStatus.set(paneId, status);
      this.transitionQueue(paneId, { type: "status", status });
      // herdr-adapter.md §4: finishing while a phone visibly watches it is finishing seen.
      if (status === "done" && this.pushManager.shouldSuppressPush(paneId)) this.herdrClient.markSeen(paneId);

      // pane_tail §5.10: push to non-viewing connections when working or blocked, and once more when leaving.
      const wasActive = previous === "working" || previous === "blocked";
      const isActive = status === "working" || status === "blocked";
      if (isActive) {
        this.maybeSendPaneTail(paneId);
      } else if (wasActive) {
        this.maybeSendPaneTail(paneId, true);
      }

      const isBlocked = status === "blocked" && previous !== "blocked";
      const isDone = status === "done" && previous !== "done";
      if (!isBlocked && !isDone) return;
      const pushEvent = isBlocked ? "blocked" : "done";
      const dedupeKey = `${paneId}:${pushEvent}`;
      const now = Date.now();
      if (now - (this.lastPushAt.get(dedupeKey) || 0) < PUSH_DEDUPE_MS) return;
      const result = this.pushManager.sendNotification(this.pushMessage(paneId, pushEvent));
      if (!result.suppressed && result.delivered) {
        this.lastPushAt.set(dedupeKey, now);
      }
    };
    this.herdrClient.on("pane_status_changed", this.onPaneStatusChanged);
  }

  /** herdr-adapter.md §7.1: fill the model catalog again; every client hears of a changed list. */
  public async refreshModels(forceAgent?: string): Promise<void> {
    if (await this.modelCatalog.refresh(forceAgent)) this.broadcastRecipes();
  }

  private broadcastRecipes(): void {
    this.broadcast({ type: "recipes_sync", payload: { recipes: this.recipeSummaries() } });
  }

  /** `push.md` §4: the blocked or done pane's agent, workspace and tab, as data. */
  private pushMessage(paneId: string, event: "blocked" | "done" = "blocked"): PushMessage {
    for (const ws of this.herdrClient.getSnapshot().workspaces) {
      for (const tab of ws.tabs) {
        const pane = tab.panes.find((p) => p.id === paneId);
        if (pane) return { event, agent: pane.agent, workspace: ws.label, tab: tab.label, paneId };
      }
    }
    return { event, agent: null, workspace: "", tab: "", paneId };
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
    if (msg.type === "pane_state") {
      const isBound = !!this.paneStore.getPaneState(paneId);
      for (const ws of this.clients) {
        if (ws.data.subscribedPaneId === paneId) {
          const watching = ws.data.watchingScreenPaneId === paneId;
          if (isBound && !watching) {
            const { rawScreen, ...rest } = msg.payload;
            ws.send(JSON.stringify({ ...msg, payload: { ...rest, cards: [] } }));
          } else {
            ws.send(JSON.stringify(msg));
          }
        }
      }
      return;
    }
    const text = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.data.subscribedPaneId === paneId) ws.send(text);
  }

  private recipeSummaries(): Record<string, AgentRecipeSummary> {
    const recipes: Record<string, AgentRecipeSummary> = {};
    for (const r of listAgentRecipes()) {
      recipes[r.kind] = {
        kind: r.kind,
        label: r.label,
        models: this.modelCatalog.models(r.kind),
        defaultModel: r.defaultModel,
        defaultThinking: r.defaultThinking,
        interruptKeys: r.interruptKeys,
        resumable: r.resumable,
        launchModel: r.launchModel !== false,
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
        const code = HERDR_ERROR_MAP[err.code] || (UNREACHABLE_CODES.has(err.code) ? ProtocolErrors.ERR_UPSTREAM_OFFLINE : ProtocolErrors.ERR_INTERNAL);
        this.sendError(ws, replyTo, code, err.message);
      } else {
        const errCode = (err as any)?.code;
        if (typeof errCode === "string" && (UNREACHABLE_CODES.has(errCode) || errCode === "ECONNREFUSED" || errCode === "ENOENT")) {
          this.sendError(ws, replyTo, ProtocolErrors.ERR_UPSTREAM_OFFLINE, err instanceof Error ? err.message : String(err));
        } else {
          console.error(`[pigeon] handling '${msg.type}' failed:`, err);
          this.sendError(ws, replyTo, ProtocolErrors.ERR_INTERNAL, err instanceof Error ? err.message : String(err));
        }
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
            buildId: this.buildId,
            environment: this.environment,
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
        if (paneId && this.herdrClient.hasPane(paneId)) {
          const have = requested === paneId ? msg.payload.have : undefined;
          await this.bootstrapPane(ws, paneId, have);
        }
        return;
      }

      case "ping":
        data.lastPingTime = Date.now();
        this.send(ws, { type: "pong", timestamp: Date.now() });
        return;

      case "presence_update":
        this.pushManager.updatePresence(data.connectionId, msg.isVisible, msg.viewingPaneId);
        if (msg.isVisible && msg.viewingPaneId) this.herdrClient.markSeen(msg.viewingPaneId);
        return;

      case "select_view": {
        ws.data.watchingScreenPaneId = undefined;
        if (msg.payload.paneId === null) {
          ws.data.subscribedPaneId = null;
          this.syncMonitoredPanes();
          this.sendAck(ws, msg.id);
          return;
        }
        if (!this.herdrClient.hasPane(msg.payload.paneId)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Unknown pane ${msg.payload.paneId}`);
          return;
        }
        await this.bootstrapPane(ws, msg.payload.paneId, msg.payload.have);
        this.sendAck(ws, msg.id);
        return;
      }

      case "agent_prompt": {
        const { targetPaneId, text, attachments } = msg.payload;
        if (!this.requireKnownPane(ws, msg.id, targetPaneId)) return;
        const paths: string[] = [];
        for (const id of attachments ?? []) {
          const info = this.uploadStore?.get(id);
          if (!info) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `Unknown upload '${id}'`);
            return;
          }
          paths.push(info.path);
        }
        const full = this.composePrompt(targetPaneId, text, paths);
        await this.submitPrompt(ws, msg.id, targetPaneId, full, { text, attachments: attachments ?? [] });
        return;
      }

      case "queue_resume": {
        const { paneId } = msg.payload;
        if (!this.requireKnownPane(ws, msg.id, paneId)) return;
        const currentFp = this.getErrorFingerprint(paneId);
        if (currentFp) {
          this.resumedErrorKey.set(paneId, currentFp);
        }
        this.sendAck(ws, msg.id, { paneId });
        this.sendQueue(paneId);
        this.kickQueue(paneId);
        return;
      }

      case "queue_cancel": {
        const { targetPaneId, queueId } = msg.payload;
        const queue = this.queues.get(targetPaneId) ?? [];
        const idx = queue.findIndex((q) => q.item.queueId === queueId);
        if (idx === -1 || queue[idx].item.sending) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, "That prompt is no longer queued.");
          return;
        }
        queue.splice(idx, 1);
        this.saveQueues();
        this.sendQueue(targetPaneId);
        this.sendAck(ws, msg.id, { queueId });
        return;
      }

      case "queue_update": {
        const { targetPaneId, queueId, text, attachments } = msg.payload;
        if (!this.requireKnownPane(ws, msg.id, targetPaneId)) return;
        const queue = this.queues.get(targetPaneId) ?? [];
        const entry = queue.find((q) => q.item.queueId === queueId);
        if (!entry || entry.item.sending) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, "That prompt is no longer queued.");
          return;
        }
        const paths: string[] = [];
        for (const id of attachments ?? []) {
          const info = this.uploadStore?.get(id);
          if (!info) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `Unknown upload '${id}'`);
            return;
          }
          paths.push(info.path);
        }
        const full = this.composePrompt(targetPaneId, text, paths);
        entry.item.text = text;
        entry.item.attachments = attachments ?? [];
        entry.send = full;
        this.saveQueues();
        this.sendQueue(targetPaneId);
        this.sendAck(ws, msg.id, { queueId, updated: true });
        return;
      }

      case "models_refresh": {
        await this.refreshModels(msg.payload?.agent);
        this.sendAck(ws, msg.id, { recipes: this.recipeSummaries() });
        return;
      }

      case "sessions_list": {
        const folder = this.herdrClient.getWorkspaceFolder(msg.payload.workspaceId);
        if (!folder) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Unknown workspace ${msg.payload.workspaceId}`);
          return;
        }
        const recipe = getAgentRecipe(msg.payload.agentKind);
        const sessions = recipe?.resumable ? this.agentAdapters.listSessions(recipe.kind, folder) : [];
        this.sendAck(ws, msg.id, { sessions });
        return;
      }

      case "tab_rename": {
        const name = msg.payload.name.trim();
        if (!this.herdrClient.hasTab(msg.payload.tabId)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Unknown tab ${msg.payload.tabId}`);
          return;
        }
        await this.herdrClient.renameTab(msg.payload.tabId, name);
        this.sendAck(ws, msg.id, { tabId: msg.payload.tabId, name });
        return;
      }

      case "devices_list": {
        const devices = (this.pairingManager?.listDevices() ?? []).sort((a, b) => b.createdAt - a.createdAt).map((d) => ({
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          createdAt: d.createdAt,
          lastUsedAt: d.lastUsedAt,
          isThisDevice: d.deviceId === data.session.deviceId,
        }));
        this.sendAck(ws, msg.id, { devices });
        return;
      }

      case "device_revoke": {
        // §4.12: ack first; revoking then closes the device's connections, this one included.
        const { deviceId } = msg.payload;
        if (!this.pairingManager?.listDevices().some((d) => d.deviceId === deviceId)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Unknown device ${deviceId}`);
          return;
        }
        this.sendAck(ws, msg.id, { deviceId });
        this.pairingManager.revokeDevice(deviceId);
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
        if (this.answeringPanes.has(targetPaneId)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INTERACTION_STALE, "This prompt is already being answered.");
          return;
        }
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
        this.answeringPanes.add(targetPaneId);
        let approved: boolean;
        try {
          approved = await this.herdrClient.answerInteraction(targetPaneId, interactionId, [option.keyShortcut]);
        } finally {
          this.answeringPanes.delete(targetPaneId);
        }
        this.sendAck(ws, msg.id, { approved, interactionId });
        return;
      }

      case "create_tab_and_agent": {
        const { workspaceId, agentKind, modelId, thinking, cwd, firstMessage, resumeSessionId } = msg.payload;
        const recipe = getAgentRecipe(agentKind);
        if (!recipe) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `Unknown agent kind '${agentKind}'`);
          return;
        }
        if (modelId && recipe.launchModel === false) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `${recipe.label} takes no model at launch`);
          return;
        }
        const models = this.modelCatalog.models(recipe.kind);
        const model = modelId ? models.find((m) => m.id === modelId) : undefined;
        if (modelId && !model) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `Unknown model '${modelId}' for ${agentKind}`);
          return;
        }
        if (thinking && !(model?.thinkingLevels || []).includes(thinking)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `Thinking level '${thinking}' is not offered for this model`);
          return;
        }
        let resume: string | undefined;
        if (resumeSessionId) {
          const folder = cwd ?? this.herdrClient.getWorkspaceFolder(workspaceId);
          const target = recipe.resumable && folder ? this.agentAdapters.resumeTarget(recipe.kind, resumeSessionId, folder) : null;
          if (!target) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `${recipe.label} cannot resume session '${resumeSessionId}'`);
            return;
          }
          resume = target;
        }
        const res = await this.herdrClient.createTabAndAgent(workspaceId, recipe.kind, { modelId, thinking, cwd, firstMessage, resume });
        this.paneStore.setLaunch(res.paneId, { agent: recipe.kind, modelId, thinking, resumeSessionId });
        this.rebindSessions();
        this.sendAck(ws, msg.id, { workspaceId, tabId: res.tabId, paneId: res.paneId });
        return;
      }

      case "close_tab":
        if (!this.herdrClient.hasTab(msg.payload.tabId)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Unknown tab ${msg.payload.tabId}`);
          return;
        }
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
        this.usageService?.updateConfig();
        this.quotaService?.updateConfig();
        this.configVersion++;
        this.sendAck(ws, msg.id, { version: this.configVersion, client });
        this.broadcastConfigUpdated(client, ws);
        return;
      }

      case "quota_get": {
        if (this.configManager.getClientConfig().quotaUsageEnabled === false) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_FEATURE_DISABLED, "Quota and usage are disabled in settings");
          return;
        }
        this.quotaService ??= new QuotaService({ configManager: this.configManager });
        const res = await this.quotaService.getQuota(this.configManager.getClientConfig());
        this.sendAck(ws, msg.id, { providers: res.providers, fetchedAt: res.fetchedAt });
        return;
      }

      case "usage_get":
        if (this.configManager.getClientConfig().quotaUsageEnabled === false) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_FEATURE_DISABLED, "Quota and usage are disabled in settings");
          return;
        }
        this.sendAck(ws, msg.id, (await this.usage().getUsage(msg.payload)) as any);
        return;

      case "usage_day":
        if (this.configManager.getClientConfig().quotaUsageEnabled === false) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_FEATURE_DISABLED, "Quota and usage are disabled in settings");
          return;
        }
        this.sendAck(ws, msg.id, (await this.usage().getDay(msg.payload)) as any);
        return;

      case "usage_model":
        if (this.configManager.getClientConfig().quotaUsageEnabled === false) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_FEATURE_DISABLED, "Quota and usage are disabled in settings");
          return;
        }
        this.sendAck(ws, msg.id, (await this.usage().getModel(msg.payload)) as any);
        return;

      case "detail_get": {
        const { paneId, kind } = msg.payload;
        const sessionState = this.paneStore.getPaneState(paneId);
        if (!sessionState) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `No bound session for pane ${paneId}`);
          return;
        }
        if (kind === "tool") {
          const { turnId, callId } = msg.payload;
          const turn = sessionState.turns.find((t) => t.turnId === turnId);
          if (!turn) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Turn ${turnId} not found`);
            return;
          }
          let call = turn.toolCalls?.find((c) => c.id === callId);
          if (!call && turn.items) {
            const item = turn.items.find((i: any) => i.kind === "tool" && i.call?.id === callId);
            if (item && item.kind === "tool") call = item.call;
          }
          if (!call) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Tool call ${callId} not found`);
            return;
          }
          this.sendAck(ws, msg.id, { call });
          return;
        }
        if (kind === "reasoning") {
          const { turnId } = msg.payload;
          const turn = sessionState.turns.find((t) => t.turnId === turnId);
          if (!turn) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Turn ${turnId} not found`);
            return;
          }
          const item = turn.items?.find((i: any) => i.kind === "reasoning" && i.text) as { kind: "reasoning"; text?: string } | undefined;
          const reasoningText = item?.text || turn.reasoning?.text;
          if (!reasoningText) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Reasoning text not found in turn ${turnId}`);
            return;
          }
          this.sendAck(ws, msg.id, { text: reasoningText });
          return;
        }
        if (kind === "file") {
          const { filePath } = msg.payload;
          const diff = ((sessionState.stats as any)?.files || sessionState.stats?.diffs || []).find((d: any) => d.filePath === filePath);
          if (!diff) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Diff for ${filePath} not found`);
            return;
          }
          this.sendAck(ws, msg.id, { diff });
          return;
        }
        this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `Unknown detail kind ${kind}`);
        return;
      }

      case "screen_watch": {
        const { paneId, on } = msg.payload;
        if (on) {
          ws.data.watchingScreenPaneId = paneId;
        } else if (ws.data.watchingScreenPaneId === paneId) {
          ws.data.watchingScreenPaneId = undefined;
        }
        this.sendAck(ws, msg.id);
        return;
      }
    }
  }

  /** Subscribes the connection to one pane and sends everything the client needs to render it. */
  private async bootstrapPane(ws: Ws, paneId: string, have?: HaveInfo): Promise<void> {
    const startMs = Date.now();
    ws.data.subscribedPaneId = paneId;
    this.syncMonitoredPanes();

    const agentKind = this.herdrClient.getPaneAgentKind(paneId);
    const sessionState = this.paneStore.getPaneState(paneId);

    let turnsPayload: NormalizedTurnsPayload | null = null;
    let resumePayload: TurnsDeltaPayload | null = null;

    if (
      have &&
      typeof have === "object" &&
      typeof have.sessionId === "string" &&
      typeof have.turnCount === "number" &&
      Number.isInteger(have.turnCount) &&
      sessionState &&
      sessionState.sessionId === have.sessionId &&
      sessionState.turns.length >= have.turnCount
    ) {
      if (have.turnCount >= 2 && typeof have.anchorHash === "string") {
        const anchorTurn = sessionState.turns[have.turnCount - 2];
        if (anchorTurn && hashTurn(anchorTurn) === have.anchorHash) {
          resumePayload = {
            paneId,
            seq: sessionState.seqWatermark,
            seqWatermark: sessionState.seqWatermark,
            sinceTurnIndex: have.turnCount - 1,
            appendTurns: sessionState.turns.slice(have.turnCount - 1).map(toLightTurn),
            ...(sessionState.stats ? { sessionStats: toLightStats(sessionState.stats) } : {}),
            ...(sessionState.sessionTitle ? { sessionTitle: sessionState.sessionTitle } : {}),
            ...(sessionState.todos ? { todos: sessionState.todos } : {}),
            session: this.paneStore.sessionInfo(paneId, agentKind),
          };
        }
      } else if (have.turnCount > 0 && typeof have.lastTurnHash === "string") {
        const lastTurn = sessionState.turns[have.turnCount - 1];
        if (lastTurn && hashTurn(lastTurn) === have.lastTurnHash) {
          resumePayload = {
            paneId,
            seq: sessionState.seqWatermark,
            seqWatermark: sessionState.seqWatermark,
            sinceTurnIndex: have.turnCount,
            appendTurns: sessionState.turns.slice(have.turnCount).map(toLightTurn),
            ...(sessionState.stats ? { sessionStats: toLightStats(sessionState.stats) } : {}),
            ...(sessionState.sessionTitle ? { sessionTitle: sessionState.sessionTitle } : {}),
            ...(sessionState.todos ? { todos: sessionState.todos } : {}),
            session: this.paneStore.sessionInfo(paneId, agentKind),
          };
        }
      }
    }

    if (!resumePayload) {
      turnsPayload = this.paneStore.getPayload(paneId, agentKind);
    }

    this.syncTranscriptInteraction(paneId);
    const cached = this.herdrClient.getPaneState(paneId);
    const queueItems = (this.queues.get(paneId) ?? []).map((q) => q.item);
    const serverMs = Date.now() - startMs;

    const lightTurns = turnsPayload
      ? {
          ...turnsPayload,
          turns: turnsPayload.turns.map(toLightTurn),
          ...(turnsPayload.sessionStats ? { sessionStats: toLightStats(turnsPayload.sessionStats) } : {}),
        }
      : null;
    this.send(ws, {
      type: "pane_bootstrap",
      payload: {
        paneId,
        turns: lightTurns,
        resume: resumePayload,
        queue: queueItems,
        queuePaused: this.isQueuePaused(paneId),
        state: cached ?? null,
        serverMs,
      },
    });
    if (cached) this.send(ws, { type: "pane_state", payload: cached });
    await this.herdrClient.readAndClassifyPane(paneId);
  }

  private lastPaneTailAt = new Map<string, number>();

  /**
   * protocol.md §5.10: For every pane whose status is working or blocked and that has a bound session,
   * push to connections not viewing that pane the last turns in light form fitting in 32 KB.
   * At most one pane_tail per pane per second, and one more when leaving working or blocked.
   */
  private maybeSendPaneTail(paneId: string, force = false): void {
    const sessionState = this.paneStore.getPaneState(paneId);
    if (!sessionState) return;
    const herdrStatus = this.herdrClient.getPaneHerdrStatus(paneId);
    const inActiveState = herdrStatus === "working" || herdrStatus === "blocked";
    if (!inActiveState && !force) return;

    const now = Date.now();
    const last = this.lastPaneTailAt.get(paneId) || 0;
    if (!force && now - last < 1000) return;
    this.lastPaneTailAt.set(paneId, now);

    const rawTurns = sessionState.turns;
    const lightTurns: NormalizedTurn[] = [];
    let size = 0;
    for (let i = rawTurns.length - 1; i >= 0; i--) {
      const lt = toLightTurn(rawTurns[i]);
      const turnSize = Buffer.byteLength(JSON.stringify(lt));
      if (size + turnSize > 32 * 1024 && lightTurns.length > 0) break;
      lightTurns.unshift(lt);
      size += turnSize;
    }

    const payload: PaneTailPayload = {
      paneId,
      agentStatus: (herdrStatus as AgentStatus) || "idle",
      seq: sessionState.seqWatermark,
      sessionId: sessionState.sessionId,
      turns: lightTurns,
    };

    const msg = JSON.stringify({ type: "pane_tail", payload });
    for (const ws of this.clients) {
      if (ws.data.subscribedPaneId !== paneId) {
        ws.send(msg);
      }
    }
  }

  /** The daemon injects its usage service; tests without one get a service on first use. */
  private usage(): UsageService {
    this.usageService ??= new UsageService({ configManager: this.configManager });
    return this.usageService;
  }

  /** Skills are per pane: they depend on the agent kind and the project directory. */
  private sendSkills(ws: Ws, paneId: string | null, replyTo?: string): void {
    const skills = paneId
      ? this.skillScanner.listSkills(this.herdrClient.getPaneAgentKind(paneId), this.herdrClient.getPaneCwd(paneId))
      : [];
    this.send(ws, { type: "skills_sync", replyTo, payload: { paneId, skills, recipes: this.recipeSummaries() } });
  }

  /**
   * agent-session-normalization.md §2.0: rule 1 (exact) first, then a resumed or already-bound pane
   * keeps its session (rules 5, 6), then unbound panes take the newest unclaimed session (rule 2), and
   * last a kept pane moves to a newer unclaimed session of its folder (rule 6: `/clear`, `/new`).
   */
  private rebindSessions(): void {
    const panes = this.herdrClient
      .paneIds()
      .map((paneId) => ({ paneId, facts: this.herdrClient.getPaneFacts(paneId)! }))
      .filter((p) => p.facts.agentKind && this.agentAdapters.isSupported(p.facts.agentKind));
    const claimed = new Set<string>(); // "agent|session"
    const result = new Map<string, string>();
    const keyOf = (agent: string, id: string) => `${agent}|${id}`;
    const factsOf = (p: (typeof panes)[number]) => ({ agent: p.facts.agentKind!, pid: p.facts.pid, cwd: p.facts.cwd, createdMs: p.facts.createdMs });
    const take = (p: (typeof panes)[number], id: string | null | undefined): boolean => {
      if (!id || result.has(p.paneId) || claimed.has(keyOf(p.facts.agentKind!, id))) return false;
      claimed.add(keyOf(p.facts.agentKind!, id));
      result.set(p.paneId, id);
      return true;
    };
    const claimedOf = (agent: string) => new Set([...claimed].filter((k) => k.startsWith(agent + "|")).map((k) => k.slice(agent.length + 1)));
    for (const p of panes) take(p, this.agentAdapters.exactSession(factsOf(p)));
    const kept: typeof panes = [];
    for (const p of panes) {
      const launch = this.paneStore.getLaunch(p.paneId);
      const bound = this.paneStore.boundSession(p.paneId);
      // The bound session first: once rule 6 moved the pane past the session it was resumed with, it stays moved.
      if (bound?.agent === p.facts.agentKind && take(p, bound.sessionId)) kept.push(p);
      else if (launch?.resumeSessionId && launch.agent === p.facts.agentKind && take(p, launch.resumeSessionId)) kept.push(p);
    }
    for (const p of panes) {
      if (result.has(p.paneId)) continue;
      take(p, this.agentAdapters.newestSession(factsOf(p), claimedOf(p.facts.agentKind!)));
    }
    for (const p of kept) {
      const agent = p.facts.agentKind!;
      const current = result.get(p.paneId)!;
      const candidate = this.agentAdapters.newestSession(factsOf(p), claimedOf(agent));
      if (!candidate) continue;
      const since = this.agentAdapters.lastWritten(agent, current);
      const written = this.agentAdapters.lastWritten(agent, candidate);
      if (written === null || (since !== null && written <= since)) continue;
      claimed.delete(keyOf(agent, current));
      claimed.add(keyOf(agent, candidate));
      result.set(p.paneId, candidate);
    }
    for (const p of panes) {
      const id = result.get(p.paneId);
      if (id) this.paneStore.registerPaneSession(p.paneId, p.facts.agentKind!, id);
      else this.paneStore.unbind(p.paneId);
    }
    // Rule 7: a pane that no longer runs a supported agent drops its session.
    const live = new Set(panes.map((p) => p.paneId));
    for (const paneId of this.paneStore.trackedPaneIds()) if (!live.has(paneId)) this.paneStore.unbind(paneId);
  }

  /** protocol.md §4.2: attachments as paths after a blank line, with the recipe's mention prefix. */
  private composePrompt(paneId: string, text: string, paths: string[]): string {
    if (paths.length === 0) return text;
    const kind = this.herdrClient.getPaneAgentKind(paneId);
    const recipe = kind ? getAgentRecipe(kind) : undefined;
    const prefix = recipe?.mentionPrefix ?? "";
    const sep = recipe?.attachmentSeparator ?? "\n\n";
    const lines = paths.map((p) => prefix + p).join(sep === " " ? " " : "\n");
    return text.trim() ? `${text}${sep}${lines}` : lines;
  }

  private resumedErrorKey = new Map<string, string>();
  private wasQueuePaused = new Map<string, boolean>();

  private getErrorFingerprint(paneId: string): string | null {
    const sessionState = this.paneStore.getPaneState(paneId);
    if (!sessionState || sessionState.turns.length === 0) return null;
    const lastTurn = sessionState.turns[sessionState.turns.length - 1];
    if (!lastTurn.items || lastTurn.items.length === 0) return null;
    const lastItem = lastTurn.items[lastTurn.items.length - 1];
    if (lastItem.kind !== "error") return null;
    return `${lastTurn.turnId}:${lastTurn.items.length}:${(lastItem as any).text}`;
  }

  private isQueuePaused(paneId: string): boolean {
    const fp = this.getErrorFingerprint(paneId);
    if (!fp) return false;
    return this.resumedErrorKey.get(paneId) !== fp;
  }

  private syncTranscriptInteraction(paneId: string): void {
    const sessionState = this.paneStore.getPaneState(paneId);
    const lastTurn = sessionState?.turns[sessionState.turns.length - 1];
    let interaction: InteractionCardData | null = null;
    if (lastTurn?.pendingQuestion) {
      const pq = lastTurn.pendingQuestion;
      const firstQ = pq.questions[0]?.question ?? "";
      const options: InteractionOption[] = [];
      for (let k = 0; k < pq.questions.length; k++) {
        const q = pq.questions[k];
        for (let n = 0; n < q.options.length; n++) {
          const opt = q.options[n];
          options.push({
            id: `q${k + 1}_opt_${n + 1}`,
            label: opt.label,
            keyShortcut: "",
          });
        }
      }
      const hash = createHash("sha256").update(pq.id).digest("hex").slice(0, 10);
      interaction = {
        id: `card_interaction_${hash}`,
        kind: "interaction",
        source: "transcript",
        interactionId: `int_${hash}`,
        title: "",
        question: firstQ,
        payload: "",
        fingerprint: computeInteractionFingerprint(firstQ, "", options),
        options,
        fallbackKeys: ["enter", "esc", "up", "down"],
      };
    } else if (lastTurn?.pendingPlan) {
      const hash = createHash("sha256").update(lastTurn.pendingPlan.markdown).digest("hex").slice(0, 10);
      interaction = {
        id: `card_interaction_${hash}`,
        kind: "interaction",
        source: "transcript",
        interactionId: `int_${hash}`,
        title: "",
        question: "",
        payload: lastTurn.pendingPlan.markdown,
        fingerprint: computeInteractionFingerprint("", lastTurn.pendingPlan.markdown, []),
        options: [],
        fallbackKeys: ["enter", "esc", "up", "down"],
      };
    }
    this.herdrClient.setTranscriptInteraction(paneId, interaction);
  }

  private getQueueState(paneId: string): { state: "idle" | "sending"; sawWorking: boolean; unboundSent: boolean; timer?: ReturnType<typeof setTimeout> } {
    let s = this.queueStates.get(paneId);
    if (!s) {
      s = { state: "idle", sawWorking: false, unboundSent: false };
      this.queueStates.set(paneId, s);
    }
    return s;
  }

  /** Queues while the agent works or others wait; sends otherwise (protocol.md §4.2). */
  private async submitPrompt(ws: Ws, replyTo: string | null, paneId: string, send: string, shown: { text: string; attachments: string[] }): Promise<void> {
    const queue = this.queues.get(paneId) ?? [];
    const state = this.getQueueState(paneId);
    const herdrStatus = this.herdrClient.getPaneHerdrStatus(paneId);
    const paused = this.isQueuePaused(paneId);
    if (herdrStatus === "working" || queue.length > 0 || state.state === "sending" || paused) {
      const facts = this.herdrClient.getPaneFacts(paneId);
      const created_ms = facts?.createdMs ?? 0;
      const item: QueuedPrompt = { queueId: `q_${randomBytes(6).toString("hex")}`, ...shown, createdAt: Date.now() };
      queue.push({ item, send, created_ms });
      this.queues.set(paneId, queue);
      this.saveQueues();
      this.sendQueue(paneId);
      if (replyTo) this.sendAck(ws, replyTo, { queued: true, queueId: item.queueId });
      return;
    }
    await this.herdrClient.sendPrompt(paneId, send);
    if (replyTo) this.sendAck(ws, replyTo, { queued: false });
  }

  public clearSendingPrompt(paneId: string, queueId?: string): void {
    const head = this.queues.get(paneId)?.[0];
    const qId = queueId ?? head?.item.queueId ?? "";
    this.transitionQueue(paneId, { type: "timeout", queueId: qId });
  }

  public getQueueStatus(): Record<string, { length: number; state: "idle" | "sending" }> {
    const result: Record<string, { length: number; state: "idle" | "sending" }> = {};
    for (const [paneId, queue] of this.queues.entries()) {
      const qs = this.queueStates.get(paneId);
      result[paneId] = {
        length: queue.length,
        state: qs?.state ?? "idle",
      };
    }
    return result;
  }

  private transitionQueue(
    paneId: string,
    event:
      | { type: "status"; status: string }
      | { type: "user_turn" }
      | { type: "send_result"; success: boolean; error?: unknown; queueId: string }
      | { type: "timeout"; queueId: string }
      | { type: "remove_pane" }
  ): void {
    const queueState = this.getQueueState(paneId);
    const queue = this.queues.get(paneId) ?? [];


    if (event.type === "remove_pane") {
      if (queueState.timer) clearTimeout(queueState.timer);
      this.queueStates.delete(paneId);
      this.queues.delete(paneId);
      this.lastPaneTailAt.delete(paneId);
      this.lastStatus.delete(paneId);
      this.lastPushAt.delete(`${paneId}:blocked`);
      this.lastPushAt.delete(`${paneId}:done`);
      this.saveQueues();
      return;
    }

    if (queueState.state === "sending") {
      let settled = false;
      const head = queue[0];

      if (event.type === "user_turn") {
        const canFlushImmediately =
          queueState.sawWorking &&
          (this.herdrClient.getPaneHerdrStatus(paneId) === "idle" || this.herdrClient.getPaneHerdrStatus(paneId) === "done");
        if (queueState.timer) {
          clearTimeout(queueState.timer);
          queueState.timer = undefined;
        }
        if (!queueState.unboundSent && head) {
          queue.shift();
        }
        queueState.state = "idle";
        queueState.sawWorking = false;
        queueState.unboundSent = false;
        this.saveQueues();
        this.sendQueue(paneId);

        if (canFlushImmediately) {
          this.kickQueue(paneId);
        }
        return;
      } else if (event.type === "timeout") {
        if (!event.queueId || event.queueId === head?.item.queueId) {
          settled = true;
        }
      } else if (event.type === "status") {
        if (event.status === "working") {
          queueState.sawWorking = true;
          const currentFp = this.getErrorFingerprint(paneId);
          if (currentFp) this.resumedErrorKey.set(paneId, currentFp);
        } else if ((event.status === "idle" || event.status === "done")) {
          // Idle after working settles the head prompt for all panes (protocol §4.2).
          if (queueState.sawWorking) {
            settled = true;
          }
        }
      } else if (event.type === "send_result") {
        if (!event.success) {
          if (queueState.timer) {
            clearTimeout(queueState.timer);
            queueState.timer = undefined;
          }
          if (head && head.item.queueId === event.queueId) {
            queue.shift();
          }
          queueState.state = "idle";
          queueState.sawWorking = false;
          queueState.unboundSent = false;
          this.saveQueues();
          this.sendQueue(paneId);

          const err = event.error;
          const isOffline =
            err instanceof HerdrError && (UNREACHABLE_CODES.has(err.code) || err.code === "closed" || err.code === "ERR_UPSTREAM_OFFLINE");
          const code = isOffline
            ? ProtocolErrors.ERR_UPSTREAM_OFFLINE
            : err instanceof HerdrError
              ? HERDR_ERROR_MAP[err.code] || ProtocolErrors.ERR_INTERNAL
              : ProtocolErrors.ERR_INTERNAL;
          this.sendToSubscribers(paneId, {
            type: "error",
            error: { code, message: err instanceof Error ? err.message : String(err), details: { queueId: event.queueId, paneId } },
          });

          this.kickQueue(paneId);
          return;
        } else {
          // Success
          if (!this.paneStore.boundSession(paneId)) {
            // Unbound pane: leaves the queue right after successful send, but queue still waits for it to settle
            if (head && head.item.queueId === event.queueId && !queueState.unboundSent) {
              queue.shift();
              queueState.unboundSent = true;
              this.saveQueues();
              this.sendQueue(paneId);
            }
          }
        }
      }

      if (settled) {
        if (queueState.timer) {
          clearTimeout(queueState.timer);
          queueState.timer = undefined;
        }
        if (!queueState.unboundSent && head) {
          queue.shift();
        }
        queueState.state = "idle";
        queueState.sawWorking = false;
        queueState.unboundSent = false;
        this.saveQueues();
        this.sendQueue(paneId);

        this.kickQueue(paneId);
        return;
      }
    }

    if (queueState.state === "idle") {
      this.kickQueue(paneId);
    }
  }

  private kickQueue(paneId: string): void {
    const queueState = this.getQueueState(paneId);
    if (queueState.state !== "idle") return;
    if (this.isQueuePaused(paneId)) return;
    const queue = this.queues.get(paneId);
    if (!queue || queue.length === 0) return;

    const herdrStatus = this.herdrClient.getPaneHerdrStatus(paneId);
    if (herdrStatus !== "idle" && herdrStatus !== "done") return;

    const entry = queue[0];
    if (entry.item.sending) return;

    entry.item.sending = true;
    queueState.state = "sending";
    queueState.sawWorking = false;
    queueState.unboundSent = false;

    const queueId = entry.item.queueId;
    queueState.timer = setTimeout(() => {
      this.transitionQueue(paneId, { type: "timeout", queueId });
    }, this.queueSendTimeoutMs);

    this.saveQueues();
    this.sendQueue(paneId);

    void (async () => {
      try {
        await this.herdrClient.sendPrompt(paneId, entry.send);
        this.transitionQueue(paneId, { type: "send_result", success: true, queueId });
      } catch (err) {
        this.transitionQueue(paneId, { type: "send_result", success: false, error: err, queueId });
      }
    })();
  }

  private sendQueue(paneId: string): void {
    this.sendToSubscribers(paneId, {
      type: "prompt_queue",
      payload: {
        paneId,
        paused: this.isQueuePaused(paneId),
        items: (this.queues.get(paneId) ?? []).map((q) => q.item),
      },
    });
  }

  private loadQueues(): void {
    if (!this.queueFilePath || !existsSync(this.queueFilePath)) return;
    let data: any;
    try {
      const raw = readFileSync(this.queueFilePath, "utf8");
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Failed to parse queue file '${this.queueFilePath}': ${e instanceof Error ? e.message : String(e)}`);
    }
    if (typeof data === "object" && data !== null) {
      for (const [paneId, items] of Object.entries(data)) {
        if (Array.isArray(items)) {
          const pending = (items as Array<{ item: QueuedPrompt; send: string; created_ms: number }>).filter((entry) => !entry?.item?.sending);
          if (pending.length > 0) {
            this.queues.set(paneId, pending);
            this.restoredPaneIds.add(paneId);
          }
        }
      }
    }
  }

  private saveQueues(): void {
    if (!this.queueFilePath) return;
    try {
      const obj: Record<string, Array<{ item: QueuedPrompt; send: string; created_ms: number }>> = {};
      for (const [paneId, list] of this.queues.entries()) {
        const notSending = list.filter((e) => !e.item.sending);
        if (notSending.length > 0) obj[paneId] = notSending;
      }
      const dir = dirname(this.queueFilePath);
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.queueFilePath}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
      renameSync(tmp, this.queueFilePath);
    } catch (e) {
      console.error("[Pigeon] failed to save queues to disk:", e);
    }
  }

  private requireKnownPane(ws: Ws, replyTo: string, paneId: string): boolean {
    if (this.herdrClient.hasPane(paneId)) return true;
    this.sendError(ws, replyTo, ProtocolErrors.ERR_NOT_FOUND, `Unknown pane ${paneId}`);
    return false;
  }

  private broadcastConfigUpdated(client: ClientConfig, origin?: Ws): void {
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

  private broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const ws of this.clients) ws.send(text);
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
    for (const state of this.queueStates.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.queueStates.clear();
    this.herdrClient.off("connected", this.onHerdrConnected);
    this.herdrClient.off("disconnected", this.onHerdrDisconnected);
    this.herdrClient.off("snapshot_updated", this.onSnapshotUpdated);
    this.herdrClient.off("cards_updated", this.onCardsUpdated);
    this.herdrClient.off("pane_status_changed", this.onPaneStatusChanged);
    this.usageService?.destroy();
    this.quotaService?.destroy();
    this.paneStore.destroy();
  }
}
