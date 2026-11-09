import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { HerdrError, type HerdrClient } from "./herdr-client";
import type { DeviceSession, PairingManager } from "./pairing";
import type { UploadStore } from "./uploads";
import type { PushManager, PushMessage } from "./push";
import type { ConfigManager } from "./config-manager";
import { AgentAdapterManager } from "./agent-adapters/index";
import { PaneStore } from "./pane-store";
import { SkillScanner } from "./skill-scanner";
import { getAgentRecipe, listAgentRecipes } from "./agent-recipes";
import { ModelCatalog } from "./model-catalog";
import { validateClientMessage } from "./ws-validate";
import {
  type ClientMessage,
  type ServerMessage,
  ProtocolErrors,
  type ClientConfig,
  type AgentRecipeSummary,
  type PaneStatePayload,
  type QueuedPrompt,
  type HaveInfo,
  type TurnsDeltaPayload,
  hashTurn,
} from "../types/protocol";

const PROTOCOL_VERSION = "1.0.0";
export const SERVER_VERSION = "0.1.5";
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
}

export interface ClientConnectionData {
  session: DeviceSession;
  connectionId: string;
  subscribedPaneId: string | null;
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
  private queues = new Map<string, Array<{ item: QueuedPrompt; send: string }>>();
  private flushing = new Set<string>();

  constructor(options: WsServerOptions) {
    this.buildId = options.buildId;
    this.queueFilePath = options.queueFilePath;
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
    this.usageService = options.usageService ?? (this.configManager ? new UsageService({ configManager: this.configManager }) : undefined);
    // security-and-pairing.md §5: a revoked device (from the phone or `pigeon devices revoke`) is cut off at once.
    this.pairingManager?.on("device_revoked", (deviceId: string) => this.closeDevice(deviceId));

    this.herdrClient.on("connected", () => this.paneStore.setHerdrStatus(true));
    this.herdrClient.on("disconnected", () => this.paneStore.setHerdrStatus(false));
    this.paneStore.on("upstream_status", (status) => this.broadcast({ type: "upstream_status", payload: status }));
    this.paneStore.on("turns_delta", (delta) => this.sendToSubscribers(delta.paneId, { type: "turns_delta", payload: delta }));
    this.paneStore.on("session_changed", (paneId: string) => {
      this.sendToSubscribers(paneId, { type: "normalized_turns", payload: this.paneStore.getPayload(paneId, this.herdrClient.getPaneAgentKind(paneId)) });
    });

    // herdr-adapter.md §7.1: a model named in a session's records that the catalog lacks fills it again.
    this.paneStore.on("session_model", (agent: string, model: string) => {
      void this.modelCatalog.noteModel(agent, model).then((changed) => changed && this.broadcastRecipes());
    });
    this.paneStore.setModelResolver((agent, idOrLabel) => this.modelCatalog.resolve(agent, idOrLabel));
    this.herdrClient.setSessionTitleSource((paneId) => this.paneStore.sessionTitle(paneId));
    // Titles change while a snapshot is being handled (binding reads the session), so relabel after it.
    this.paneStore.on("title_changed", () => queueMicrotask(() => this.herdrClient.relabelTabs()));
    this.herdrClient.on("snapshot_updated", (snapshot) => {
      for (const paneId of this.paneStore.trackedPaneIds()) {
        if (!this.herdrClient.hasPane(paneId)) this.paneStore.closePane(paneId);
      }
      for (const paneId of Array.from(this.queues.keys())) if (!this.herdrClient.hasPane(paneId)) this.queues.delete(paneId);
      this.saveQueues();
      this.rebindSessions();
      this.broadcast({ type: "snapshot_update", payload: snapshot });
    });
    this.rebindSessions();

    this.herdrClient.on("cards_updated", (state: PaneStatePayload) => {
      this.sendToSubscribers(state.paneId, { type: "pane_state", payload: state });
    });

    this.herdrClient.on("pane_status_changed", ({ paneId, status }: { paneId: string; status: string }) => {
      const previous = this.lastStatus.get(paneId);
      this.lastStatus.set(paneId, status);
      if (status === "idle" || status === "done") void this.flushQueue(paneId);
      // herdr-adapter.md §4: finishing while a phone visibly watches it is finishing seen.
      if (status === "done" && this.pushManager.shouldSuppressPush(paneId)) this.herdrClient.markSeen(paneId);
      // push.md §4: notify only on the transition into blocked, at most once per minute per pane.
      if (status !== "blocked" || previous === "blocked") return;
      const now = Date.now();
      if (now - (this.lastPushAt.get(paneId) || 0) < PUSH_DEDUPE_MS) return;
      this.lastPushAt.set(paneId, now);
      this.pushManager.sendNotification(this.pushMessage(paneId));
    });
  }

  /** herdr-adapter.md §7.1: fill the model catalog again; every client hears of a changed list. */
  public async refreshModels(): Promise<void> {
    if (await this.modelCatalog.refresh()) this.broadcastRecipes();
  }

  private broadcastRecipes(): void {
    this.broadcast({ type: "recipes_sync", payload: { recipes: this.recipeSummaries() } });
  }

  /** `push.md` §4: the blocked pane's agent, workspace and tab, as data. */
  private pushMessage(paneId: string): PushMessage {
    for (const ws of this.herdrClient.getSnapshot().workspaces) {
      for (const tab of ws.tabs) {
        const pane = tab.panes.find((p) => p.id === paneId);
        if (pane) return { event: "blocked", agent: pane.agent, workspace: ws.label, tab: tab.label, paneId };
      }
    }
    return { event: "blocked", agent: null, workspace: "", tab: "", paneId };
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
        models: this.modelCatalog.models(r.kind),
        defaultModel: r.defaultModel,
        defaultThinking: r.defaultThinking,
        interruptKeys: r.interruptKeys,
        resumable: r.resumable,
        launchModel: r.launchModel !== false,
        runtimeSwitch: { model: !!r.runtimeModelCommand, thinking: !!r.runtimeThinkingCommand },
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
            buildId: this.buildId,
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

      case "agent_set_model": {
        const { targetPaneId, modelId, thinking } = msg.payload;
        if (!this.requireKnownPane(ws, msg.id, targetPaneId)) return;
        const kind = this.herdrClient.getPaneAgentKind(targetPaneId);
        const recipe = kind ? getAgentRecipe(kind) : undefined;
        const models = kind ? this.modelCatalog.models(kind) : [];
        const commands: string[] = [];
        if (modelId) {
          if (!recipe?.runtimeModelCommand || !models.some((m) => m.id === modelId)) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `This agent cannot switch to model '${modelId}' at runtime`);
            return;
          }
          commands.push(recipe.runtimeModelCommand(modelId));
        }
        if (thinking) {
          const current = modelId ?? this.paneStore.sessionInfo(targetPaneId, kind).model.value;
          const levels = models.find((m) => m.id === current)?.thinkingLevels ?? [];
          if (!recipe?.runtimeThinkingCommand || !levels.includes(thinking)) {
            this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, `This agent cannot switch effort to '${thinking}' at runtime`);
            return;
          }
          commands.push(recipe.runtimeThinkingCommand(thinking));
        }
        for (const [i, text] of commands.entries()) await this.submitPrompt(ws, i === commands.length - 1 ? msg.id : null, targetPaneId, text, { text, attachments: [] });
        return;
      }

      case "queue_cancel": {
        const { targetPaneId, queueId } = msg.payload;
        const queue = this.queues.get(targetPaneId) ?? [];
        const idx = queue.findIndex((q) => q.item.queueId === queueId);
        if (idx === -1) {
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
        if (!entry) {
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
        await this.refreshModels();
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
        const model = modelId ? this.modelCatalog.models(recipe.kind).find((m) => m.id === modelId) : undefined;
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
        this.usageService?.updateConfig(client);
        this.configVersion++;
        this.sendAck(ws, msg.id, { version: this.configVersion, client });
        this.broadcastConfigUpdated(client, ws);
        return;
      }

      case "quota_get": {
        if (!this.quotaService) {
          this.quotaService = new QuotaService({ configManager: this.configManager });
        }
        const force = msg.payload?.force ?? false;
        const res = await this.quotaService.getQuota(force, this.configManager.getClientConfig());
        this.sendAck(ws, msg.id, { providers: res.providers });
        return;
      }

      case "usage_get": {
        if (!this.usageService) {
          this.usageService = new UsageService();
        }
        const res = await this.usageService.getUsage(msg.payload);
        this.sendAck(ws, msg.id, res as any);
        return;
      }

      case "usage_day": {
        if (!this.usageService) {
          this.usageService = new UsageService();
        }
        const res = await this.usageService.getDay(msg.payload);
        this.sendAck(ws, msg.id, res as any);
        return;
      }

      case "usage_model": {
        if (!this.usageService) {
          this.usageService = new UsageService();
        }
        const res = await this.usageService.getModel(msg.payload);
        this.sendAck(ws, msg.id, res as any);
        return;
      }
    }
  }

  /** Subscribes the connection to one pane and sends everything the client needs to render it. */
  private async bootstrapPane(ws: Ws, paneId: string, have?: HaveInfo): Promise<void> {
    ws.data.subscribedPaneId = paneId;
    this.syncMonitoredPanes();

    const agentKind = this.herdrClient.getPaneAgentKind(paneId);
    const sessionState = this.paneStore.getPaneState(paneId);

    let sentDelta = false;
    if (
      have &&
      typeof have === "object" &&
      typeof have.sessionId === "string" &&
      typeof have.turnCount === "number" &&
      Number.isInteger(have.turnCount) &&
      have.turnCount > 0 &&
      typeof have.lastTurnHash === "string" &&
      sessionState &&
      sessionState.sessionId === have.sessionId &&
      sessionState.turns.length >= have.turnCount
    ) {
      const turnToMatch = sessionState.turns[have.turnCount - 1];
      if (turnToMatch && hashTurn(turnToMatch) === have.lastTurnHash) {
        const payload: TurnsDeltaPayload = {
          paneId,
          seqWatermark: sessionState.seqWatermark,
          sinceTurnIndex: have.turnCount,
          appendTurns: sessionState.turns.slice(have.turnCount),
          ...(sessionState.stats ? { sessionStats: sessionState.stats } : {}),
          ...(sessionState.sessionTitle ? { sessionTitle: sessionState.sessionTitle } : {}),
          ...(sessionState.todos ? { todos: sessionState.todos } : {}),
          session: this.paneStore.sessionInfo(paneId, agentKind),
        };
        this.send(ws, { type: "turns_delta", payload });
        sentDelta = true;
      }
    }

    if (!sentDelta) {
      this.send(ws, { type: "normalized_turns", payload: this.paneStore.getPayload(paneId, agentKind) });
    }

    this.sendSkills(ws, paneId);
    this.send(ws, { type: "prompt_queue", payload: { paneId, items: (this.queues.get(paneId) ?? []).map((q) => q.item) } });
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
    const prefix = (kind && getAgentRecipe(kind)?.mentionPrefix) || "";
    const lines = paths.map((p) => prefix + p).join("\n");
    return text.trim() ? `${text}\n\n${lines}` : lines;
  }

  /** Queues while the agent works or others wait; sends otherwise (protocol.md §4.2). */
  private async submitPrompt(ws: Ws, replyTo: string | null, paneId: string, send: string, shown: { text: string; attachments: string[] }): Promise<void> {
    const queue = this.queues.get(paneId) ?? [];
    if (this.herdrClient.getPaneHerdrStatus(paneId) === "working" || queue.length > 0 || this.flushing.has(paneId)) {
      const item: QueuedPrompt = { queueId: `q_${randomBytes(6).toString("hex")}`, ...shown, createdAt: Date.now() };
      queue.push({ item, send });
      this.queues.set(paneId, queue);
      this.saveQueues();
      this.sendQueue(paneId);
      if (replyTo) this.sendAck(ws, replyTo, { queued: true, queueId: item.queueId });
      return;
    }
    await this.herdrClient.sendPrompt(paneId, send);
    if (replyTo) this.sendAck(ws, replyTo, { queued: false });
  }

  /** Sends the oldest queued prompt once the turn ended; the next waits for the next idle. */
  private async flushQueue(paneId: string): Promise<void> {
    const queue = this.queues.get(paneId);
    if (!queue?.length || this.flushing.has(paneId)) return;
    const { item, send } = queue.shift()!;
    this.flushing.add(paneId);
    this.saveQueues();
    this.sendQueue(paneId);
    try {
      await this.herdrClient.sendPrompt(paneId, send);
    } catch (err) {
      const code = err instanceof HerdrError ? HERDR_ERROR_MAP[err.code] || ProtocolErrors.ERR_INTERNAL : ProtocolErrors.ERR_INTERNAL;
      if (!(err instanceof HerdrError)) console.error(`[pigeon] sending queued prompt to ${paneId} failed:`, err);
      this.sendToSubscribers(paneId, {
        type: "error",
        error: { code, message: err instanceof Error ? err.message : String(err), details: { queueId: item.queueId, paneId } },
      });
    } finally {
      this.flushing.delete(paneId);
    }
  }

  private sendQueue(paneId: string): void {
    this.sendToSubscribers(paneId, { type: "prompt_queue", payload: { paneId, items: (this.queues.get(paneId) ?? []).map((q) => q.item) } });
  }

  private loadQueues(): void {
    if (!this.queueFilePath || !existsSync(this.queueFilePath)) return;
    try {
      const raw = readFileSync(this.queueFilePath, "utf8");
      const data = JSON.parse(raw);
      if (typeof data === "object" && data !== null) {
        for (const [paneId, items] of Object.entries(data)) {
          if (Array.isArray(items)) {
            this.queues.set(paneId, items as Array<{ item: QueuedPrompt; send: string }>);
          }
        }
      }
    } catch (e) {
      console.error("[Pigeon] failed to load queues from disk:", e);
    }
  }

  private saveQueues(): void {
    if (!this.queueFilePath) return;
    try {
      const obj: Record<string, Array<{ item: QueuedPrompt; send: string }>> = {};
      for (const [paneId, list] of this.queues.entries()) {
        if (list.length > 0) obj[paneId] = list;
      }
      writeFileSync(this.queueFilePath, JSON.stringify(obj, null, 2), "utf8");
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
    this.usageService?.destroy();
    this.paneStore.destroy();
  }
}
