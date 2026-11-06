import { randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { HerdrError, type HerdrClient } from "./herdr-client";
import type { DeviceSession, PairingManager } from "./pairing";
import type { UploadStore } from "./uploads";
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
  type QueuedPrompt,
} from "../types/protocol";

const PROTOCOL_VERSION = "1.0.0";
export const SERVER_VERSION = "0.1.0";
const PUSH_DEDUPE_MS = 60_000;

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
  // protocol.md §4.2: prompts waiting for the pane's turn to end, oldest first.
  private queues = new Map<string, QueuedPrompt[]>();
  private flushing = new Set<string>();

  constructor(options: WsServerOptions) {
    this.buildId = options.buildId;
    this.herdrClient = options.herdrClient;
    this.pushManager = options.pushManager;
    this.configManager = options.configManager;
    this.agentAdapters = options.agentAdapters || new AgentAdapterManager();
    this.paneStore = new PaneStore(this.agentAdapters);
    this.skillScanner = options.skillScanner || new SkillScanner();
    this.uploadStore = options.uploadStore;
    this.pairingManager = options.pairingManager;

    this.herdrClient.on("connected", () => this.paneStore.setHerdrStatus(true));
    this.herdrClient.on("disconnected", () => this.paneStore.setHerdrStatus(false));
    this.paneStore.on("upstream_status", (status) => this.broadcast({ type: "upstream_status", payload: status }));
    this.paneStore.on("turns_delta", (delta) => this.sendToSubscribers(delta.paneId, { type: "turns_delta", payload: delta }));
    this.paneStore.on("session_changed", (paneId: string) => {
      this.sendToSubscribers(paneId, { type: "normalized_turns", payload: this.paneStore.getPayload(paneId, this.herdrClient.getPaneAgentKind(paneId)) });
    });

    this.herdrClient.on("snapshot_updated", (snapshot) => {
      for (const paneId of this.paneStore.trackedPaneIds()) {
        if (!this.herdrClient.hasPane(paneId)) this.paneStore.closePane(paneId);
      }
      for (const paneId of Array.from(this.queues.keys())) if (!this.herdrClient.hasPane(paneId)) this.queues.delete(paneId);
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
        resumable: r.resumable,
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
        await this.submitPrompt(ws, msg.id, targetPaneId, full, attachments ?? []);
        return;
      }

      case "agent_set_model": {
        const { targetPaneId, modelId, thinking } = msg.payload;
        if (!this.requireKnownPane(ws, msg.id, targetPaneId)) return;
        const kind = this.herdrClient.getPaneAgentKind(targetPaneId);
        const recipe = kind ? getAgentRecipe(kind) : undefined;
        const models = recipe?.models() ?? [];
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
        for (const [i, text] of commands.entries()) await this.submitPrompt(ws, i === commands.length - 1 ? msg.id : null, targetPaneId, text, []);
        return;
      }

      case "queue_cancel": {
        const { targetPaneId, queueId } = msg.payload;
        const queue = this.queues.get(targetPaneId) ?? [];
        const idx = queue.findIndex((q) => q.queueId === queueId);
        if (idx === -1) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, "That prompt is no longer queued.");
          return;
        }
        queue.splice(idx, 1);
        this.sendQueue(targetPaneId);
        this.sendAck(ws, msg.id, { queueId });
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
        const devices = (this.pairingManager?.listDevices() ?? []).map((d) => ({
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
        const { deviceId } = msg.payload;
        if (!this.pairingManager?.revokeDevice(deviceId)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_NOT_FOUND, `Unknown device ${deviceId}`);
          return;
        }
        this.sendAck(ws, msg.id, { deviceId });
        this.closeDevice(deviceId);
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
        const model = modelId ? recipe.models().find((m) => m.id === modelId) : undefined;
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

    // Herdr Core reports no agent session (herdr-adapter.md §4), so the turns stay empty until a
    // session source exists. Always sent, so the client never keeps showing the previous pane's
    // conversation.
    this.send(ws, { type: "normalized_turns", payload: this.paneStore.getPayload(paneId, this.herdrClient.getPaneAgentKind(paneId)) });

    this.sendSkills(ws, paneId);
    this.send(ws, { type: "prompt_queue", payload: { paneId, items: this.queues.get(paneId) ?? [] } });
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
   * agent-session-normalization.md §2.0: exact matches first, then the newest session of the
   * folder, never one already bound to another pane. Panes keep a session while it still matches.
   */
  private rebindSessions(): void {
    const panes = this.herdrClient
      .paneIds()
      .map((paneId) => ({ paneId, facts: this.herdrClient.getPaneFacts(paneId)! }))
      .filter((p) => p.facts.agentKind && this.agentAdapters.isSupported(p.facts.agentKind));
    const claimed = new Map<string, string>(); // "agent|session" → pane
    const result = new Map<string, string | null>();
    const keyOf = (agent: string, id: string) => `${agent}|${id}`;
    const factsOf = (p: (typeof panes)[number]) => ({ agent: p.facts.agentKind!, pid: p.facts.pid, cwd: p.facts.cwd, createdMs: p.facts.createdMs });
    for (const p of panes) {
      const launch = this.paneStore.getLaunch(p.paneId);
      const exact = launch?.resumeSessionId && launch.agent === p.facts.agentKind ? launch.resumeSessionId : this.agentAdapters.exactSession(factsOf(p));
      if (exact && !claimed.has(keyOf(p.facts.agentKind!, exact))) {
        claimed.set(keyOf(p.facts.agentKind!, exact), p.paneId);
        result.set(p.paneId, exact);
      }
    }
    // Panes already bound go first, so a stable binding is not taken by a newer pane.
    const rest = panes
      .filter((p) => !result.has(p.paneId))
      .sort((a, b) => Number(!!this.paneStore.boundSession(b.paneId)) - Number(!!this.paneStore.boundSession(a.paneId)));
    for (const p of rest) {
      const agent = p.facts.agentKind!;
      const exclude = new Set(Array.from(claimed.keys()).filter((k) => k.startsWith(agent + "|")).map((k) => k.slice(agent.length + 1)));
      const id = this.agentAdapters.newestSession(factsOf(p), exclude);
      if (id) claimed.set(keyOf(agent, id), p.paneId);
      result.set(p.paneId, id);
    }
    for (const p of panes) {
      const id = result.get(p.paneId);
      if (id) this.paneStore.registerPaneSession(p.paneId, p.facts.agentKind!, id);
      else this.paneStore.unbind(p.paneId);
    }
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
  private async submitPrompt(ws: Ws, replyTo: string | null, paneId: string, text: string, attachments: string[]): Promise<void> {
    const queue = this.queues.get(paneId) ?? [];
    if (this.herdrClient.getPaneHerdrStatus(paneId) === "working" || queue.length > 0) {
      const item: QueuedPrompt = { queueId: `q_${randomBytes(6).toString("hex")}`, text, attachments, createdAt: Date.now() };
      queue.push(item);
      this.queues.set(paneId, queue);
      this.sendQueue(paneId);
      if (replyTo) this.sendAck(ws, replyTo, { queued: true, queueId: item.queueId });
      return;
    }
    await this.herdrClient.sendPrompt(paneId, text);
    if (replyTo) this.sendAck(ws, replyTo, { queued: false });
  }

  /** Sends the oldest queued prompt once the turn ended; the next waits for the next idle. */
  private async flushQueue(paneId: string): Promise<void> {
    const queue = this.queues.get(paneId);
    if (!queue?.length || this.flushing.has(paneId)) return;
    const item = queue.shift()!;
    this.flushing.add(paneId);
    this.sendQueue(paneId);
    try {
      await this.herdrClient.sendPrompt(paneId, item.text);
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
    this.sendToSubscribers(paneId, { type: "prompt_queue", payload: { paneId, items: this.queues.get(paneId) ?? [] } });
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
