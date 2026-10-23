import { EventEmitter } from "node:events";
import type { ServerWebSocket } from "bun";
import type { HerdrClient } from "./herdr-client";
import type { PairingManager, DeviceSession } from "./pairing";
import type { PushManager } from "./push";
import { ConfigManager } from "./config-manager";
import { AgentAdapterManager } from "./agent-adapters/index";
import {
  type ClientMessage,
  type ServerMessage,
  ProtocolErrors,
  type PaneStatePayload,
  type ClientConfig,
} from "../types/protocol";

export interface WsServerOptions {
  herdrClient: HerdrClient;
  pairingManager: PairingManager;
  pushManager: PushManager;
  allowedOrigins?: string[];
  insecureDev?: boolean;
  configManager?: ConfigManager;
}

export interface ClientConnectionData {
  session: DeviceSession;
  subscribedPaneId: string | null;
  lastPingTime: number;
}

export class WsServer extends EventEmitter {
  private herdrClient: HerdrClient;
  private pairingManager: PairingManager;
  private pushManager: PushManager;
  private allowedOrigins: string[];
  private insecureDev: boolean;
  public configManager: ConfigManager;
  public agentAdapters: AgentAdapterManager;
  private clients = new Map<ServerWebSocket<ClientConnectionData>, ClientConnectionData>();

  constructor(options: WsServerOptions) {
    super();
    this.herdrClient = options.herdrClient;
    this.pairingManager = options.pairingManager;
    this.pushManager = options.pushManager;
    this.allowedOrigins = options.allowedOrigins || [];
    this.insecureDev = !!options.insecureDev;
    this.configManager = options.configManager || new ConfigManager();
    this.agentAdapters = new AgentAdapterManager();

    // Listen to Herdr updates to broadcast
    this.herdrClient.on("snapshot_updated", (snapshot) => {
      this.broadcast({
        type: "snapshot_update",
        payload: snapshot,
      });
    });

    this.herdrClient.on("cards_updated", (update) => {
      // Check if pane has recognized agent session for structured normalized turns
      const session = this.herdrClient.getPaneAgentSession(update.paneId);
      let structuredTurnsPayload: any = null;
      if (session && this.agentAdapters.isSupported(session.agent)) {
        const { turns, stats } = this.agentAdapters.getTurns(session.agent, session.sessionId, true);
        if (turns && turns.length > 0) {
          structuredTurnsPayload = {
            type: "normalized_turns",
            payload: {
              paneId: update.paneId,
              turns,
              sessionStats: stats,
            },
          };
        }
      }

      for (const [ws, data] of this.clients.entries()) {
        if (data.subscribedPaneId === update.paneId) {
          if (structuredTurnsPayload) {
            ws.send(JSON.stringify(structuredTurnsPayload));
          }

          ws.send(
            JSON.stringify({
              type: "cards_upsert",
              payload: {
                paneId: update.paneId,
                cards: update.cards,
                revision: update.revision,
              },
            })
          );

          if (update.pendingInteraction) {
            ws.send(
              JSON.stringify({
                type: "interaction_required",
                payload: {
                  ...update.pendingInteraction,
                  paneId: update.paneId,
                },
              })
            );
          }

          ws.send(
            JSON.stringify({
              type: "pane_screen",
              payload: {
                paneId: update.paneId,
                text: update.rawScreen,
                revision: update.revision,
              },
            })
          );
        }
      }
    });

    this.herdrClient.on("pane_status_changed", ({ paneId, status }) => {
      // Check if notification needed for blocked/done
      if (status === "blocked") {
        this.pushManager.sendNotification(paneId, {
          title: "Agent Waiting for Input",
          body: `Agent in pane ${paneId} is blocked and requires interaction.`,
        });
      }
    });
  }

  public handleOpen(ws: ServerWebSocket<ClientConnectionData>): void {
    const data = ws.data;
    this.clients.set(ws, data);
    this.emit("client_connected", data.session.deviceId);
  }

  public handleClose(ws: ServerWebSocket<ClientConnectionData>): void {
    const data = ws.data;
    this.clients.delete(ws);
    if (data?.session?.deviceId) {
      this.pushManager.removePresence(data.session.deviceId);
      this.emit("client_disconnected", data.session.deviceId);
    }
  }

  public async handleMessage(ws: ServerWebSocket<ClientConnectionData>, rawData: string | Buffer): Promise<void> {
    const text = typeof rawData === "string" ? rawData : rawData.toString("utf-8");
    let msg: ClientMessage;

    try {
      msg = JSON.parse(text);
    } catch {
      this.sendError(ws, undefined, ProtocolErrors.ERR_INVALID_PAYLOAD, "Malformed JSON payload");
      return;
    }

    const data = ws.data;

    switch (msg.type) {
      case "hello": {
        const paneId =
          msg.payload?.subscribePaneId ||
          this.herdrClient.getFocusedPaneId() ||
          "w1:p1";

        data.subscribedPaneId = paneId;

        const clientCfg = this.configManager.getClientConfig();

        // Reply welcome
        const welcomeMsg: ServerMessage = {
          type: "welcome",
          replyTo: msg.id,
          payload: {
            protocolVersion: "1.0.0",
            serverVersion: "0.1.0",
            deviceId: data.session.deviceId,
            preferences: {
              themeId: clientCfg.themeId,
              mode: clientCfg.themeMode,
              locale: "zh-CN",
              macrosVersion: 1,
            },
            clientConfig: clientCfg,
          },
        };
        ws.send(JSON.stringify(welcomeMsg));

        // Push snapshot
        const snapshot = this.herdrClient.getSnapshot();
        ws.send(
          JSON.stringify({
            type: "snapshot_update",
            payload: snapshot,
          })
        );

        // Push pane state & normalized turns
        this.herdrClient.setMonitoredPaneId(paneId);
        const session = this.herdrClient.getPaneAgentSession(paneId);
        if (session && this.agentAdapters.isSupported(session.agent)) {
          const { turns, stats } = this.agentAdapters.getTurns(session.agent, session.sessionId);
          if (turns && turns.length > 0) {
            ws.send(
              JSON.stringify({
                type: "normalized_turns",
                payload: {
                  paneId,
                  turns,
                  sessionStats: stats,
                },
              })
            );
          }
        }

        await this.herdrClient.readAndClassifyPane(paneId);
        const state = this.herdrClient.getPaneState(paneId);
        ws.send(
          JSON.stringify({
            type: "pane_state",
            payload: state,
          })
        );
        break;
      }

      case "ping": {
        data.lastPingTime = Date.now();
        const pongMsg: ServerMessage = {
          type: "pong",
          timestamp: Date.now(),
        };
        ws.send(JSON.stringify(pongMsg));
        break;
      }

      case "presence_update": {
        this.pushManager.updatePresence(
          data.session.deviceId,
          msg.isVisible,
          msg.viewingPaneId
        );
        break;
      }

      case "subscribe_pane": {
        data.subscribedPaneId = msg.paneId;
        this.herdrClient.setMonitoredPaneId(msg.paneId);

        const subSession = this.herdrClient.getPaneAgentSession(msg.paneId);
        if (subSession && this.agentAdapters.isSupported(subSession.agent)) {
          const { turns, stats } = this.agentAdapters.getTurns(subSession.agent, subSession.sessionId);
          if (turns && turns.length > 0) {
            ws.send(
              JSON.stringify({
                type: "normalized_turns",
                payload: {
                  paneId: msg.paneId,
                  turns,
                  sessionStats: stats,
                },
              })
            );
          }
        }

        await this.herdrClient.readAndClassifyPane(msg.paneId);
        const state = this.herdrClient.getPaneState(msg.paneId);
        ws.send(
          JSON.stringify({
            type: "pane_state",
            payload: state,
          })
        );
        break;
      }

      case "select_view": {
        const paneId = msg.payload?.paneId;
        if (paneId) {
          data.subscribedPaneId = paneId;
          this.herdrClient.setMonitoredPaneId(paneId);

          const selSession = this.herdrClient.getPaneAgentSession(paneId);
          if (selSession && this.agentAdapters.isSupported(selSession.agent)) {
            const { turns, stats } = this.agentAdapters.getTurns(selSession.agent, selSession.sessionId);
            if (turns && turns.length > 0) {
              ws.send(
                JSON.stringify({
                  type: "normalized_turns",
                  payload: {
                    paneId,
                    turns,
                    sessionStats: stats,
                  },
                })
              );
            }
          }

          await this.herdrClient.readAndClassifyPane(paneId);
          const state = this.herdrClient.getPaneState(paneId);
          ws.send(
            JSON.stringify({
              type: "pane_state",
              payload: state,
            })
          );
        }
        this.sendAck(ws, msg.id);
        break;
      }

      case "agent_prompt": {
        const target = msg.payload?.targetPaneId || data.subscribedPaneId;
        const promptText = msg.payload?.text;
        if (!target || !promptText) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, "Missing targetPaneId or text");
          return;
        }

        try {
          if (this.herdrClient.isConnected()) {
            await this.herdrClient.sendAgentPrompt(target, promptText);
          } else {
            await this.herdrClient.sendInput(target, promptText);
          }
          this.sendAck(ws, msg.id);
        } catch (err: any) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_AGENT_NOT_READY, err.message);
        }
        break;
      }

      case "agent_send_keys": {
        const target = msg.payload?.targetPaneId || data.subscribedPaneId;
        const keys = msg.payload?.keys;
        if (!target || !keys || !Array.isArray(keys)) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, "Missing targetPaneId or keys");
          return;
        }

        try {
          await this.herdrClient.sendKeys(target, keys);
          this.sendAck(ws, msg.id);
        } catch (err: any) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INTERNAL, err.message);
        }
        break;
      }

      case "interaction_respond": {
        const target = msg.payload?.targetPaneId || data.subscribedPaneId;
        const interactionId = msg.payload?.interactionId;
        const fingerprint = msg.payload?.fingerprint;
        const optionId = msg.payload?.optionId;

        if (!target || !interactionId) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, "Missing interactionId or target");
          return;
        }

        const state = this.herdrClient.getPaneState(target);
        const pending = state.pendingInteraction;

        // Strict Fingerprint Verification per spec
        if (!pending || pending.interactionId !== interactionId) {
          this.sendError(
            ws,
            msg.id,
            ProtocolErrors.ERR_INTERACTION_STALE,
            "The interaction has expired or was already answered."
          );
          return;
        }

        if (!fingerprint || pending.fingerprint !== fingerprint) {
          this.sendError(
            ws,
            msg.id,
            ProtocolErrors.ERR_INTERACTION_STALE,
            "Screen fingerprint mismatch; interaction prompt changed."
          );
          return;
        }

        // Find shortcut or key for the chosen option
        let shortcut = "";
        let keyToSend = "\n";
        if (optionId) {
          const opt = pending.options?.find((o) => o.id === optionId);
          if (!opt) {
            this.sendError(
              ws,
              msg.id,
              ProtocolErrors.ERR_INVALID_PAYLOAD,
              `Unknown optionId '${optionId}'`
            );
            return;
          }
          shortcut = opt.keyShortcut || "";
          keyToSend = (opt.keyShortcut || opt.label) + "\n";
        }

        try {
          if (shortcut === "enter") {
            await this.herdrClient.sendKeys(target, ["enter"]);
          } else if (shortcut === "ctrl+c") {
            await this.herdrClient.sendKeys(target, ["ctrl+c"]);
          } else {
            await this.herdrClient.sendInput(target, keyToSend);
          }
          state.pendingInteraction = null;
          this.sendAck(ws, msg.id);
        } catch (err: any) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INTERNAL, err.message);
        }
        break;
      }

      case "create_tab_and_agent": {
        const { workspaceId, agentKind, cwd } = msg.payload || {};
        try {
          const res = await this.herdrClient.createTabAndAgent(workspaceId, agentKind, cwd);
          this.sendAck(ws, msg.id, {
            workspaceId,
            tabId: res?.tabId,
            paneId: res?.paneId,
          });
        } catch (err: any) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, err.message);
        }
        break;
      }

      case "preferences_set": {
        this.sendAck(ws, msg.id);
        break;
      }

      case "config_get": {
        const clientCfg = this.configManager.getClientConfig();
        const syncMsg: ServerMessage = {
          type: "config_sync",
          replyTo: msg.id,
          payload: {
            version: 1,
            client: clientCfg,
          },
        };
        ws.send(JSON.stringify(syncMsg));
        break;
      }

      case "config_patch": {
        const clientPatch =
          (msg.payload as any)?.client !== undefined
            ? (msg.payload as any).client
            : (msg.payload || {});
        try {
          const updatedClient = this.configManager.patchClientConfig(clientPatch);
          this.sendAck(ws, msg.id, { client: updatedClient });
          this.broadcastConfigUpdated(updatedClient);
        } catch (err: any) {
          this.sendError(ws, msg.id, ProtocolErrors.ERR_INVALID_PAYLOAD, err.message);
        }
        break;
      }

      default:
        this.sendAck(ws, (msg as any).id || "ack");
        break;
    }
  }

  public broadcastConfigUpdated(client: ClientConfig): void {
    const updateMsg: ServerMessage = {
      type: "config_updated",
      payload: { client },
    };
    const serialized = JSON.stringify(updateMsg);
    for (const clientWs of this.clients.keys()) {
      try {
        clientWs.send(serialized);
      } catch {}
    }
  }

  private sendAck(
    ws: ServerWebSocket<ClientConnectionData>,
    replyTo: string,
    payload?: Record<string, any>
  ): void {
    const ack: ServerMessage = {
      type: "ack",
      replyTo,
      payload: { status: "ok", ...(payload || {}) },
    };
    ws.send(JSON.stringify(ack));
  }

  private sendError(
    ws: ServerWebSocket<ClientConnectionData>,
    replyTo: string | undefined,
    code: string,
    message: string
  ): void {
    const errMsg: ServerMessage = {
      type: "error",
      replyTo,
      error: { code, message },
    };
    ws.send(JSON.stringify(errMsg));
  }

  public broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const ws of this.clients.keys()) {
      ws.send(text);
    }
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }

  public closeDevice(deviceId: string): void {
    for (const [ws, data] of this.clients.entries()) {
      if (data?.session?.deviceId === deviceId) {
        try {
          ws.close(1008, "Device session revoked");
        } catch {}
        this.clients.delete(ws);
      }
    }
  }
}
