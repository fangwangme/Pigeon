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
import { claudeQuestionSteps, getAgentRecipe, listAgentRecipes, type AnswerStep, type QuestionAnswer } from "./agent-recipes";
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
  watchDebounceMs?: number;
  port?: number;
  productionPort?: number;
  environmentKind?: "production" | "dev" | "test";
  logger?: (msg: string) => void;
}

export interface ClientConnectionData {
  session: DeviceSession;
  connectionId: string;
  subscribedPaneId: string | null;
  watchingScreenPaneId?: string;
  lastPingTime: number;
}

type Ws = ServerWebSocket<ClientConnectionData>;

/** protocol.md §4.2: a pane's queue; `batch` holds the queue ids out in the current send. */
interface QueueState {
  state: "idle" | "sending";
  sawWorking: boolean;
  unboundSent: boolean;
  batch: string[];
  timer?: ReturnType<typeof setTimeout>;
}

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
  private queueStates = new Map<string, QueueState>();
  private restoredPaneIds = new Set<string>();
  private firstSnapshotSeen = false;
  private lastSavedQueuesJson: string | null = null;
  private herdrDisconnected = false;
  private offlineQueuedPanes = new Set<string>();

  private environment: { kind: "production" | "dev" | "test"; port: number };

  private onHerdrConnected: () => void;
  private onHerdrDisconnected: () => void;
  private onSnapshotUpdated: (snapshot: any, meta?: { paneId?: string }) => void;
  private onCardsUpdated: (state: PaneStatePayload) => void;
  private onPaneStatusChanged: (event: { paneId: string; status: string }) => void;
  private logger?: (msg: string) => void;

  constructor(options: WsServerOptions) {
    this.logger = options.logger;
    this.buildId = options.buildId;
    this.queueFilePath = options.queueFilePath;
    this.queueSendTimeoutMs = options.queueSendTimeoutMs ?? 30_000;
    this.loadQueues();
    this.herdrClient = options.herdrClient;
    this.pushManager = options.pushManager;
    this.modelCatalog = options.modelCatalog ?? new ModelCatalog();
    this.configManager = options.configManager;
    this.agentAdapters = options.agentAdapters || new AgentAdapterManager();
    this.paneStore = new PaneStore(this.agentAdapters, { watchDebounceMs: options.watchDebounceMs });
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

    this.onHerdrConnected = () => {
      this.herdrDisconnected = false;
      this.offlineQueuedPanes.clear();
      this.paneStore.setHerdrStatus(true);
    };
    this.onHerdrDisconnected = () => {
      this.herdrDisconnected = true;
      this.paneStore.setHerdrStatus(false);
    };
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
      this.updateQueuePause(delta.paneId);
      this.maybeSendPaneTail(delta.paneId);
    });
    this.paneStore.on("session_changed", (paneId: string) => {
      const bound = this.paneStore.boundSession(paneId);
      this.logger?.(`${this.paneLogLabel(paneId)} session binding: ${bound ? `bound ${bound.sessionId} (${bound.agent})` : "unbound"}`);
      const payload = this.paneStore.getPayload(paneId, this.herdrClient.getPaneAgentKind(paneId));
      const lightPayload: NormalizedTurnsPayload = {
        ...payload,
        turns: payload.turns.map(toLightTurn),
        ...(payload.sessionStats ? { sessionStats: toLightStats(payload.sessionStats) } : {}),
      };
      this.sendToSubscribers(paneId, { type: "normalized_turns", payload: lightPayload });
      this.syncTranscriptInteraction(paneId);
      this.updateQueuePause(paneId);
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

    this.onSnapshotUpdated = (snapshot, meta) => {
      // protocol.md §4.2: restored prompts go out only after binding has read the session, so a
      // pause derived from it holds them.
      const restoredToSend: string[] = [];
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
              this.logger?.(`${this.paneLogLabel(paneId)} queue: dropped restored ${entry.item.queueId} (terminal creation time mismatch)`);
              console.log(`[Pigeon] Dropping restored queue item ${entry.item.queueId} for ${paneId}: terminal creation time mismatch (stored ${entry.created_ms}, current ${currentCreatedMs})`);
            }
          }
          if (kept.length > 0) {
            this.queues.set(paneId, kept);
            restoredToSend.push(paneId);
          } else {
            this.queues.delete(paneId);
          }
        }
        this.restoredPaneIds.clear();
      }

      if (!meta?.paneId) {
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
      }
      this.broadcast({ type: "snapshot_update", payload: snapshot });
      if (!meta?.paneId) {
        this.herdrDisconnected = false;
        this.offlineQueuedPanes.clear();
        this.rebindSessions();
        for (const paneId of new Set([...restoredToSend, ...this.queues.keys()])) this.kickQueue(paneId);
      } else {
        for (const paneId of restoredToSend) this.kickQueue(paneId);
      }
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
      this.rebindPane(paneId);
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
      const result = this.pushManager.sendNotification(this.pushMessage(paneId, pushEvent), () => {
        if (this.lastPushAt.get(dedupeKey) === now) this.lastPushAt.delete(dedupeKey);
      });
      if (!result.suppressed && result.delivered) {
        this.lastPushAt.set(dedupeKey, now);
      }
    };
    this.herdrClient.on("pane_status_changed", this.onPaneStatusChanged);
  }

  /** herdr-adapter.md §7.1: fill the model catalog again; every client hears of a changed list. */
  public async refreshModels(): Promise<void> {
    if (await this.modelCatalog.refresh()) this.broadcastRecipes();
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

  private paneLogLabel(paneId: string): string {
    return this.herdrClient.paneLogLabel(paneId);
  }

  public handleOpen(ws: Ws): void {
    this.clients.add(ws);
    this.logger?.(`ws connect: ${ws.data?.session?.deviceName || "client"} (conn=${ws.data?.connectionId})`);
  }

  public handleClose(ws: Ws): void {
    this.clients.delete(ws);
    this.pushManager.removePresence(ws.data.connectionId);
    this.syncMonitoredPanes();
    this.logger?.(`ws disconnect: ${ws.data?.session?.deviceName || "client"} (conn=${ws.data?.connectionId})`);
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
      const lastUsed = r.launchModel === false ? this.modelCatalog.lastUsed(r.kind) : undefined;
      if (lastUsed) recipes[r.kind].lastUsed = lastUsed;
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
        this.releaseQueuePause(paneId);
        this.logger?.(`${this.paneLogLabel(paneId)} queue: resumed`);
        this.sendAck(ws, msg.id, { paneId });
        this.updateQueuePause(paneId);
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
        this.logger?.(`${this.paneLogLabel(targetPaneId)} queue: canceled ${queueId}`);
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
        this.logger?.(`${this.paneLogLabel(targetPaneId)} queue: updated ${queueId}`);
        this.sendAck(ws, msg.id, { queueId, updated: true });
        return;
      }

      case "models_refresh": {
        this.logger?.("models refresh requested");
        const agent = msg.payload?.agent;
        if (agent !== undefined && !getAgentRecipe(agent)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `Unknown agent kind '${agent}'`);
          return;
        }
        if (await this.modelCatalog.refreshAsked(agent)) this.broadcastRecipes();
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
        // agent-session-normalization.md §2.6: a listed model resolved through the catalog.
        const sessions = (recipe?.resumable ? this.agentAdapters.listSessions(recipe.kind, folder) : []).map((s) =>
          s.model ? { ...s, model: this.modelCatalog.resolve(recipe!.kind, s.model) } : s
        );
        this.sendAck(ws, msg.id, { sessions });
        return;
      }

      case "tab_rename": {
        const name = msg.payload.name.trim();
        if (!this.herdrClient.hasTab(msg.payload.tabId)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Unknown tab ${msg.payload.tabId}`);
          return;
        }
        const oldLabel = this.herdrClient.getTabLabel(msg.payload.tabId);
        this.logger?.(`tab renamed: ${msg.payload.tabId}${oldLabel ? ` ("${oldLabel}")` : ""} -> "${name}"`);
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
        this.logger?.(`${this.paneLogLabel(targetPaneId)} keys dispatched: ${keys.join(",")}`);
        await this.herdrClient.sendKeys(targetPaneId, keys);
        this.sendAck(ws, msg.id);
        return;
      }

      case "interaction_respond": {
        const { targetPaneId, interactionId, fingerprint, optionId, optionIds, otherTexts } = msg.payload;
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
        if (pending.source === "transcript") {
          // protocol.md §4.1: every question's picks at once; the agent's checked keys (herdr-adapter.md §7.2).
          const steps = optionIds ? this.transcriptAnswerSteps(targetPaneId, optionIds, otherTexts ?? {}) : null;
          if (!steps) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, "optionIds must pick every question, and the agent needs checked keys");
            return;
          }
          this.answeringPanes.add(targetPaneId);
          try {
            await this.herdrClient.answerSteps(targetPaneId, steps);
          } finally {
            this.answeringPanes.delete(targetPaneId);
          }
          this.logger?.(`${this.paneLogLabel(targetPaneId)} interaction respond: ${optionIds!.join(",")} (transcript)`);
          this.herdrClient.markAnswered(targetPaneId, interactionId);
          this.sendAck(ws, msg.id, { approved: true, interactionId });
          return;
        }
        let steps: AnswerStep[];
        if (pending.multiSelect !== undefined && this.herdrClient.getPaneAgentKind(targetPaneId) === "claude") {
          // herdr-adapter.md §8.2: a question menu, single- or multi-select, maybe with other text.
          const answer = this.menuAnswer(pending, optionId, optionIds, otherTexts ?? {});
          if (!answer) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, "The picks do not answer this question menu");
            return;
          }
          steps = claudeQuestionSteps(answer);
        } else {
          const option = optionId === undefined || otherTexts ? undefined : pending.options.find((o) => o.id === optionId);
          if (!option?.keyShortcut) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `Unknown optionId '${optionId}'`);
            return;
          }
          steps = [{ keys: [option.keyShortcut] }];
        }
        // protocol.md §4.1: send the answer once; a prompt still on screen afterwards is acked
        // as not approved, and the card stays.
        this.answeringPanes.add(targetPaneId);
        let approved: boolean;
        try {
          approved = await this.herdrClient.answerInteraction(targetPaneId, interactionId, steps);
        } finally {
          this.answeringPanes.delete(targetPaneId);
        }
        this.logger?.(`${this.paneLogLabel(targetPaneId)} interaction respond: ${optionId ?? optionIds!.join(",")} (approved=${approved})`);
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
        this.logger?.(`tab created: ${res.tabId} (${this.paneLogLabel(res.paneId)}, agent=${recipe.kind})`);
        this.rebindSessions();
        this.sendAck(ws, msg.id, { workspaceId, tabId: res.tabId, paneId: res.paneId });
        return;
      }

      case "close_tab": {
        if (!this.herdrClient.hasTab(msg.payload.tabId)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Unknown tab ${msg.payload.tabId}`);
          return;
        }
        const tabLabel = this.herdrClient.getTabLabel(msg.payload.tabId);
        this.logger?.(`tab closed: ${msg.payload.tabId}${tabLabel ? ` ("${tabLabel}")` : ""}`);
        await this.herdrClient.closeTab(msg.payload.tabId);
        this.sendAck(ws, msg.id, { closedTabId: msg.payload.tabId });
        return;
      }

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
        this.logger?.("config patched: client settings updated");
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
    const queuePaused = this.isQueuePaused(paneId);
    this.wasQueuePaused.set(paneId, queuePaused);
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
        queuePaused,
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

  public getSourceErrors() {
    return this.agentAdapters.getSourceErrors();
  }

  public getPluginError(): string | null {
    return this.skillScanner.getPluginError();
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
    const erroredAgents = new Set(this.agentAdapters.getSourceErrors().map((e) => e.agent));
    for (const p of panes) {
      const id = result.get(p.paneId);
      if (id) this.paneStore.registerPaneSession(p.paneId, p.facts.agentKind!, id);
      else if (!erroredAgents.has(p.facts.agentKind!)) this.paneStore.unbind(p.paneId);
    }
    // Rule 7: a pane that no longer runs a supported agent drops its session.
    const live = new Set(panes.map((p) => p.paneId));
    for (const paneId of this.paneStore.trackedPaneIds()) if (!live.has(paneId)) this.paneStore.unbind(paneId);
  }

  private rebindPane(paneId: string): void {
    const facts = this.herdrClient.getPaneFacts(paneId);
    if (!facts?.agentKind || !this.agentAdapters.isSupported(facts.agentKind)) {
      this.paneStore.unbind(paneId);
      return;
    }
    const agent = facts.agentKind;
    const claimed = new Set<string>();
    for (const id of this.paneStore.trackedPaneIds()) {
      if (id === paneId) continue;
      const other = this.paneStore.boundSession(id);
      if (other?.agent === agent) claimed.add(other.sessionId);
    }
    const paneFacts = { agent, pid: facts.pid, cwd: facts.cwd, createdMs: facts.createdMs };
    let selectedId = this.agentAdapters.exactSession(paneFacts);
    if (selectedId && claimed.has(selectedId)) selectedId = null;

    let isKept = false;
    if (!selectedId) {
      const bound = this.paneStore.boundSession(paneId);
      const launch = this.paneStore.getLaunch(paneId);
      if (bound?.agent === agent && !claimed.has(bound.sessionId)) {
        selectedId = bound.sessionId;
        isKept = true;
      } else if (launch?.resumeSessionId && launch.agent === agent && !claimed.has(launch.resumeSessionId)) {
        selectedId = launch.resumeSessionId;
        isKept = true;
      }
    }
    if (!selectedId) {
      selectedId = this.agentAdapters.newestSession(paneFacts, claimed);
    } else if (isKept) {
      claimed.add(selectedId);
      const candidate = this.agentAdapters.newestSession(paneFacts, claimed);
      if (candidate) {
        const since = this.agentAdapters.lastWritten(agent, selectedId);
        const written = this.agentAdapters.lastWritten(agent, candidate);
        if (written !== null && (since === null || written > since)) {
          selectedId = candidate;
        }
      }
    }

    if (selectedId) {
      this.paneStore.registerPaneSession(paneId, agent, selectedId);
    } else {
      const erroredAgents = new Set(this.agentAdapters.getSourceErrors().map((e) => e.agent));
      if (!erroredAgents.has(agent)) this.paneStore.unbind(paneId);
    }
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
  /** The `paused` viewers last heard in `prompt_queue`. */
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

  /** protocol.md §4.2: the current agent error no longer holds the queue. */
  private releaseQueuePause(paneId: string): void {
    const fp = this.getErrorFingerprint(paneId);
    if (fp) this.resumedErrorKey.set(paneId, fp);
  }

  /** protocol.md §4.2: viewers hear every change of `paused`; a released queue sends its head. */
  private updateQueuePause(paneId: string): void {
    const now = this.isQueuePaused(paneId);
    if ((this.wasQueuePaused.get(paneId) ?? false) === now) return;
    this.logger?.(`${this.paneLogLabel(paneId)} queue: ${now ? "paused (error in transcript)" : "unpaused"}`);
    this.sendQueue(paneId);
    if (!now) this.kickQueue(paneId);
  }

  /** herdr-adapter.md §7.2: the keys for a transcript question's picks; null when they do not pick every question. */
  /** protocol.md §4.1: a question menu's picks, `opt_other` standing for the text of question 1. */
  private menuAnswer(pending: InteractionCardData, optionId: string | undefined, optionIds: string[] | undefined, otherTexts: Record<string, string>): QuestionAnswer | null {
    const ids = optionIds ?? (optionId !== undefined ? [optionId] : []);
    if (new Set(ids).size !== ids.length || (!pending.multiSelect && (optionIds || ids.length !== 1))) return null;
    const wantsOther = ids.includes("opt_other");
    const keys = Object.keys(otherTexts);
    if (wantsOther ? !pending.allowsOther || keys.join() !== "1" : keys.length > 0) return null;
    const picks: number[] = [];
    for (const id of ids) {
      if (id === "opt_other") continue;
      const key = pending.options.find((o) => o.id === id)?.keyShortcut;
      if (!key) return null;
      picks.push(Number(key));
    }
    return { multiSelect: !!pending.multiSelect, picks, ...(wantsOther ? { other: otherTexts["1"].trim() } : {}) };
  }

  /** protocol.md §4.1: every question answered, in question order, by picks or other text. */
  private transcriptAnswerSteps(paneId: string, optionIds: string[], otherTexts: Record<string, string>): AnswerStep[] | null {
    const turns = this.paneStore.getPaneState(paneId)?.turns ?? [];
    const pq = turns[turns.length - 1]?.pendingQuestion;
    const kind = this.herdrClient.getPaneAgentKind(paneId);
    const questionSteps = kind ? getAgentRecipe(kind)?.questionSteps : undefined;
    if (!pq || !questionSteps) return null;
    const answers: QuestionAnswer[] = pq.questions.map((q) => ({ multiSelect: !!q.multiSelect, picks: [] }));
    let reached = 0;
    for (const id of optionIds) {
      const m = /^q(\d+)_(?:opt_(\d+)|(other))$/.exec(id);
      const k = m ? Number(m[1]) - 1 : -1;
      if (k < reached || k >= answers.length) return null;
      reached = k;
      const a = answers[k];
      if (m![3]) {
        const text = otherTexts[String(k + 1)];
        if (a.other !== undefined || text === undefined) return null;
        a.other = text.trim();
        continue;
      }
      const n = Number(m![2]);
      if (n < 1 || n > pq.questions[k].options.length || a.picks.includes(n)) return null;
      a.picks.push(n);
    }
    const usedTexts = answers.filter((a) => a.other !== undefined).length;
    if (usedTexts !== Object.keys(otherTexts).length) return null;
    const count = (a: QuestionAnswer) => a.picks.length + (a.other !== undefined ? 1 : 0);
    if (answers.some((a) => count(a) === 0 || (!a.multiSelect && count(a) > 1))) return null;
    return questionSteps(answers);
  }

  private syncTranscriptInteraction(paneId: string): void {
    const kind = this.herdrClient.getPaneAgentKind(paneId);
    const keysChecked = !!(kind && getAgentRecipe(kind)?.questionSteps);
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
            keyShortcut: keysChecked ? String(n + 1) : "",
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
        ...(keysChecked ? { allowsOther: true } : {}),
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
    this.herdrClient.setTranscriptInteraction(paneId, interaction, !!lastTurn?.pendingQuestion && keysChecked);
  }

  private getQueueState(paneId: string): QueueState {
    let s = this.queueStates.get(paneId);
    if (!s) {
      s = { state: "idle", sawWorking: false, unboundSent: false, batch: [] };
      this.queueStates.set(paneId, s);
    }
    return s;
  }

  /** protocol.md §4.2: the batch out leaves the queue together. */
  private dropBatch(paneId: string, queueState: QueueState): void {
    const out = new Set(queueState.batch);
    this.queues.set(paneId, (this.queues.get(paneId) ?? []).filter((e) => !out.has(e.item.queueId)));
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
      this.logger?.(`${this.paneLogLabel(paneId)} queue: enqueued ${item.queueId}`);
      if (replyTo) this.sendAck(ws, replyTo, { queued: true, queueId: item.queueId });
      return;
    }
    this.logger?.(`${this.paneLogLabel(paneId)} prompt: sent immediate`);
    // Not queued on failure: the phone keeps the draft, so a resend would deliver it twice.
    await this.herdrClient.sendPrompt(paneId, send, shown.attachments.length > 0);
    if (replyTo) this.sendAck(ws, replyTo, { queued: false });
  }

  public clearSendingPrompt(paneId: string, queueId?: string): void {
    const qId = queueId ?? this.queueStates.get(paneId)?.batch[0] ?? "";
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


    // protocol.md §4.2: a pane turning `working` releases a paused queue.
    if (event.type === "status" && event.status === "working") {
      this.releaseQueuePause(paneId);
      this.updateQueuePause(paneId);
    }

    if (event.type === "remove_pane") {
      if (queueState.timer) clearTimeout(queueState.timer);
      for (const entry of queue) {
        this.logger?.(`${this.paneLogLabel(paneId)} queue: dropped ${entry.item.queueId} (pane removed)`);
      }
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
      let settleReason = "";

      if (event.type === "user_turn") {
        const canFlushImmediately =
          queueState.sawWorking &&
          (this.herdrClient.getPaneHerdrStatus(paneId) === "idle" || this.herdrClient.getPaneHerdrStatus(paneId) === "done");
        this.settleBatch(paneId, queueState, "user_turn");
        if (canFlushImmediately) {
          this.kickQueue(paneId);
        }
        return;
      } else if (event.type === "timeout") {
        if (!event.queueId || event.queueId === queueState.batch[0]) {
          settled = true;
          settleReason = "timeout";
        }
      } else if (event.type === "status") {
        if (event.status === "working") {
          queueState.sawWorking = true;
        } else if ((event.status === "idle" || event.status === "done")) {
          // Idle after working settles the head prompt for all panes (protocol §4.2).
          if (queueState.sawWorking) {
            settled = true;
            settleReason = "status";
          }
        }
      } else if (event.type === "send_result") {
        if (!event.success) {
          if (queueState.timer) {
            clearTimeout(queueState.timer);
            queueState.timer = undefined;
          }
          const err = event.error;
          const isOffline = err instanceof HerdrError && UNREACHABLE_CODES.has(err.code);
          if (isOffline) {
            this.offlineQueuedPanes.add(paneId);
            const out = new Set(queueState.batch);
            for (const entry of queue) {
              if (out.has(entry.item.queueId)) entry.item.sending = false;
            }
          } else if (queueState.batch[0] === event.queueId) {
            this.dropBatch(paneId, queueState);
          }
          queueState.state = "idle";
          queueState.sawWorking = false;
          queueState.unboundSent = false;
          queueState.batch = [];
          this.saveQueues();
          this.sendQueue(paneId);
          this.logger?.(`${this.paneLogLabel(paneId)} queue: send failed ${event.queueId}`);

          const code = isOffline
            ? ProtocolErrors.ERR_UPSTREAM_OFFLINE
            : err instanceof HerdrError
              ? HERDR_ERROR_MAP[err.code] || ProtocolErrors.ERR_INTERNAL
              : ProtocolErrors.ERR_INTERNAL;
          this.sendToSubscribers(paneId, {
            type: "error",
            error: { code, message: err instanceof Error ? err.message : String(err), details: { queueId: event.queueId, paneId } },
          });

          if (!isOffline) this.kickQueue(paneId);
          return;
        } else {
          // Success
          if (!this.paneStore.boundSession(paneId)) {
            // Unbound pane: leaves the queue right after successful send, but queue still waits for it to settle
            if (queueState.batch[0] === event.queueId && !queueState.unboundSent) {
              this.dropBatch(paneId, queueState);
              queueState.unboundSent = true;
              this.saveQueues();
              this.sendQueue(paneId);
            }
          }
        }
      }

      if (settled) {
        this.settleBatch(paneId, queueState, settleReason);
        this.kickQueue(paneId);
        return;
      }
    }

    if (queueState.state === "idle") {
      this.kickQueue(paneId);
    }
  }

  private settleBatch(paneId: string, queueState: QueueState, reason: string): void {
    if (queueState.timer) {
      clearTimeout(queueState.timer);
      queueState.timer = undefined;
    }
    if (!queueState.unboundSent) this.dropBatch(paneId, queueState);
    const settled = queueState.batch;
    queueState.state = "idle";
    queueState.sawWorking = false;
    queueState.unboundSent = false;
    queueState.batch = [];
    this.saveQueues();
    this.sendQueue(paneId);
    if (settled.length) this.logger?.(`${this.paneLogLabel(paneId)} queue: settled ${settled.join(",")} (${reason})`);
  }

  private kickQueue(paneId: string): void {
    if (this.herdrDisconnected || this.offlineQueuedPanes.has(paneId)) return;
    const queueState = this.getQueueState(paneId);
    if (queueState.state !== "idle") return;
    if (this.isQueuePaused(paneId)) return;
    const queue = this.queues.get(paneId);
    if (!queue || queue.length === 0) return;

    const herdrStatus = this.herdrClient.getPaneHerdrStatus(paneId);
    if (herdrStatus !== "idle" && herdrStatus !== "done") return;

    // protocol.md §4.2: everything queued goes out as one prompt, in queue order.
    const batch = [...queue];
    for (const e of batch) e.item.sending = true;
    queueState.state = "sending";
    queueState.sawWorking = false;
    queueState.unboundSent = false;
    queueState.batch = batch.map((e) => e.item.queueId);
    const send = batch.map((e) => e.send).join("\n\n");

    const queueId = queueState.batch[0];
    this.logger?.(`${this.paneLogLabel(paneId)} queue: sending ${queueState.batch.join(",")}`);
    queueState.timer = setTimeout(() => {
      this.transitionQueue(paneId, { type: "timeout", queueId });
    }, this.queueSendTimeoutMs);

    this.saveQueues();
    this.sendQueue(paneId);

    void (async () => {
      try {
        await this.herdrClient.sendPrompt(paneId, send, batch.some((e) => e.item.attachments.length > 0));
        this.transitionQueue(paneId, { type: "send_result", success: true, queueId });
      } catch (err) {
        this.transitionQueue(paneId, { type: "send_result", success: false, error: err, queueId });
      }
    })();
  }

  private sendQueue(paneId: string): void {
    const paused = this.isQueuePaused(paneId);
    this.wasQueuePaused.set(paneId, paused);
    this.sendToSubscribers(paneId, {
      type: "prompt_queue",
      payload: {
        paneId,
        paused,
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
      const json = JSON.stringify(obj, null, 2);
      if (json === this.lastSavedQueuesJson) return;
      if (this.lastSavedQueuesJson === null && Object.keys(obj).length === 0 && !existsSync(this.queueFilePath)) {
        this.lastSavedQueuesJson = json;
        return;
      }
      const dir = dirname(this.queueFilePath);
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.queueFilePath}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, json, "utf8");
      renameSync(tmp, this.queueFilePath);
      this.lastSavedQueuesJson = json;
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
