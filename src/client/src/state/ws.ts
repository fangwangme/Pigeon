import { state, setState, applySyncedClientConfig } from "./store";
import type {
  ClientMessage,
  ServerMessage,
  SnapshotPayload,
  PaneStatePayload,
  ClientConfig,
} from "../../../types/protocol";

let socket: WebSocket | null = null;
let pingInterval: any = null;
let reconnectTimer: any = null;
let lastPongTime = Date.now();
let msgId = 0;

function nextId(): string {
  return `cli_${++msgId}`;
}

export async function checkPairingFromUrlHash(): Promise<boolean> {
  const hash = window.location.hash;
  let code = "";
  if (hash.startsWith("#code=")) {
    code = hash.replace("#code=", "").trim();
  }

  if (code) {
    try {
      const res = await fetch("/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, deviceName: "Chromium Browser" }),
      });
      const data = await res.json();
      if (data.success) {
        // Clear token from browser URL history per security spec
        window.history.replaceState(null, "", window.location.pathname);
        return true;
      }
    } catch {}
  }
  return false;
}

export async function pairWithCode(host: string, code: string): Promise<boolean> {
  try {
    const targetUrl = host ? `${host.replace(/\/+$/, "")}/api/pair` : "/api/pair";
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, deviceName: "Chromium Browser" }),
    });
    const data = await res.json();
    if (data.success) {
      return true;
    }
  } catch {}
  return false;
}


export function initWebSocket(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const paneParam = state.activePaneId ? `?paneId=${state.activePaneId}` : "";
  const url = `${proto}//${window.location.host}/ws${paneParam}`;

  socket = new WebSocket(url);

  socket.onopen = () => {
    setState("connected", true);
    lastPongTime = Date.now();

    // Send Handshake
    sendMessage({
      type: "hello",
      id: nextId(),
      payload: {
        protocolVersion: "1.0.0",
        subscribePaneId: state.activePaneId || undefined,
      },
    });

    // Setup 15s ping keepalive with 30s half-open auto-healing
    clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (Date.now() - lastPongTime > 30000) {
        // Socket is dead / half-open; force close to trigger auto-reconnect
        socket?.close();
        return;
      }
      sendMessage({ type: "ping", id: nextId(), timestamp: Date.now() });
      reportPresence();
    }, 15000);

    // Report initial visibility presence
    reportPresence();
  };

  socket.onmessage = (event) => {
    try {
      const msg: ServerMessage = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch {}
  };

  socket.onclose = (event) => {
    setState("connected", false);
    clearInterval(pingInterval);
    socket = null;
    clearTimeout(reconnectTimer);
    if (event?.code === 4401 || event?.code === 1008) {
      // Unauthorized or revoked: stop reconnecting and open pairing sheet per spec
      import("./store").then(({ openPairingModal }) => openPairingModal());
      return;
    }
    reconnectTimer = setTimeout(initWebSocket, 3000);
  };

  socket.onerror = () => {
    socket?.close();
  };
}

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "welcome":
      setState("connected", true);
      if (msg.payload?.clientConfig) {
        applySyncedClientConfig(msg.payload.clientConfig);
      }
      if (msg.payload?.skills) {
        setState("skills", msg.payload.skills);
      }
      if (msg.payload?.recipes) {
        setState("recipes", msg.payload.recipes);
      }
      break;

    case "skills_sync": {
      if (msg.payload?.skills) {
        setState("skills", msg.payload.skills);
      }
      if (msg.payload?.recipes) {
        setState("recipes", msg.payload.recipes);
      }
      break;
    }

    case "upstream_status": {
      setState("herdrConnected", msg.payload.herdrConnected);
      setState("lastSyncTimestamp", msg.payload.lastSyncTimestamp);
      break;
    }

    case "config_sync": {
      if (msg.payload?.client) {
        applySyncedClientConfig(msg.payload.client);
      }
      break;
    }

    case "config_updated": {
      if (msg.payload?.client) {
        applySyncedClientConfig(msg.payload.client);
      }
      break;
    }

    case "snapshot_update": {
      const snap: SnapshotPayload = msg.payload;
      setState("workspaces", snap.workspaces || []);
      setState("workingAgents", snap.workingAgents || []);

      if (!state.activeWorkspaceId && snap.workspaces?.length > 0) {
        // Prioritize workspace with blocked agent, working agent, or currently focused workspace
        const targetWs =
          snap.workspaces.find((w) => w.hasWarn) ||
          snap.workspaces.find((w) => w.hasWorking) ||
          snap.workspaces.find((w) => w.isFocused) ||
          snap.workspaces[0];
        setState("activeWorkspaceId", targetWs.id);

        const targetTab =
          targetWs.tabs?.find((t) =>
            t.panes?.some((p) => p.agentStatus === "working" || p.agentStatus === "blocked")
          ) ||
          targetWs.tabs?.find((t) => t.id === targetWs.activeTabId) ||
          targetWs.tabs?.[0];

        if (targetTab) {
          setState("activeTabId", targetTab.id);
          const targetPane =
            targetTab.panes?.find(
              (p) => p.agentStatus === "working" || p.agentStatus === "blocked"
            ) || targetTab.panes?.[0];
          if (targetPane?.id) {
            selectPane(targetPane.id);
          }
        }
      }
      break;
    }

    case "pane_state": {
      const p: PaneStatePayload = msg.payload;
      if (!state.activePaneId || state.activePaneId === p.paneId) {
        let foundWsId: string | null = null;
        let foundTabId: string | null = null;
        for (const w of state.workspaces) {
          for (const t of w.tabs) {
            if (t.panes?.some((pane) => pane.id === p.paneId) || t.id === p.tabId) {
              foundWsId = w.id;
              foundTabId = t.id;
              break;
            }
          }
          if (foundWsId) break;
        }

        setState({
          activePaneId: p.paneId,
          activeWorkspaceId: foundWsId || state.activeWorkspaceId || p.workspaceId,
          activeTabId: foundTabId || state.activeTabId || p.tabId,
          agentStatus: p.agentStatus,
          cards: p.cards || [],
          pendingInteraction: p.pendingInteraction || null,
          activeGhost: p.activeGhost || null,
          rawScreen: p.rawScreen || "",
        });
      }
      break;
    }

    case "cards_upsert": {
      if (msg.payload.paneId === state.activePaneId) {
        setState("cards", msg.payload.cards);
      }
      break;
    }

    case "interaction_required": {
      if (msg.payload.paneId === state.activePaneId) {
        setState("pendingInteraction", msg.payload);
      }
      break;
    }

    case "pane_screen": {
      if (msg.payload.paneId === state.activePaneId) {
        setState("rawScreen", msg.payload.text);
      }
      break;
    }

    case "normalized_turns": {
      if (!state.activePaneId || state.activePaneId === msg.payload.paneId) {
        setState("normalizedTurns", msg.payload.turns || []);
        if (msg.payload.sessionStats) {
          setState("sessionStats", msg.payload.sessionStats);
        }
        if (msg.payload.sessionTitle) {
          setState("sessionTitle", msg.payload.sessionTitle);
        }
      }
      break;
    }

    case "turns_delta": {
      if (!state.activePaneId || state.activePaneId === msg.payload.paneId) {
        const { sinceTurnIndex, appendTurns, patchLastTurn, sessionStats, sessionTitle } = msg.payload;
        let current = [...state.normalizedTurns];
        if (sinceTurnIndex === 0) {
          current = appendTurns || [];
        } else {
          if (patchLastTurn && sinceTurnIndex > 0 && current.length >= sinceTurnIndex) {
            current[sinceTurnIndex - 1] = patchLastTurn;
          }
          if (appendTurns && appendTurns.length > 0) {
            current = [...current.slice(0, sinceTurnIndex), ...appendTurns];
          }
        }
        setState("normalizedTurns", current);
        if (sessionStats) setState("sessionStats", sessionStats);
        if (sessionTitle) setState("sessionTitle", sessionTitle);
      }
      break;
    }

    case "ack": {
      if (msg.payload?.approved !== undefined) {
        setState("pendingInteraction", null);
      }
      if (msg.payload?.workspaceId) {
        setState("activeWorkspaceId", msg.payload.workspaceId);
      }
      if (msg.payload?.tabId) {
        setState("activeTabId", msg.payload.tabId);
      }
      if (msg.payload?.paneId) {
        selectPane(msg.payload.paneId);
      }
      break;
    }

    case "error": {
      console.error("[Pigeon Server Error]", msg.error?.code, msg.error?.message);
      // If error indicates stale interaction or mismatch, re-fetch pane state to synchronize UI
      if (
        msg.error?.code === "ERR_INTERACTION_STALE" ||
        msg.error?.code === "ERR_FINGERPRINT_MISMATCH" ||
        msg.error?.code === "ERR_INVALID_PAYLOAD"
      ) {
        if (state.activePaneId) {
          sendMessage({
            type: "select_view",
            id: nextId(),
            payload: { paneId: state.activePaneId },
          });
        }
      }
      break;
    }

    case "pong":
      lastPongTime = Date.now();
      break;
  }
}

export function sendMessage(msg: ClientMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export function sendPrompt(text: string): void {
  if (!state.activePaneId) return;
  sendMessage({
    type: "agent_prompt",
    id: nextId(),
    payload: {
      targetPaneId: state.activePaneId,
      text,
    },
  });
}

export function sendKeys(keys: string[]): void {
  if (!state.activePaneId) return;
  sendMessage({
    type: "agent_send_keys",
    id: nextId(),
    payload: {
      targetPaneId: state.activePaneId,
      keys,
    },
  });
}

export function respondInteraction(
  interactionId: string,
  optionId?: string,
  fingerprint?: string
): void {
  if (!state.activePaneId) return;
  sendMessage({
    type: "interaction_respond",
    id: nextId(),
    payload: {
      targetPaneId: state.activePaneId,
      interactionId,
      optionId,
      fingerprint,
    },
  });
}

export function selectPane(paneId: string, workspaceId?: string, tabId?: string): void {
  setState("activePaneId", paneId);
  if (workspaceId) {
    setState("activeWorkspaceId", workspaceId);
  }
  if (tabId) {
    setState("activeTabId", tabId);
  } else {
    for (const w of state.workspaces) {
      for (const t of w.tabs) {
        if (t.panes?.some((p) => p.id === paneId)) {
          setState("activeWorkspaceId", w.id);
          setState("activeTabId", t.id);
          break;
        }
      }
    }
  }
  sendMessage({
    type: "select_view",
    id: nextId(),
    payload: { paneId },
  });
  reportPresence();
}

export function createTab(
  workspaceId: string,
  agentKind: string,
  options?: { modelId?: string; thinking?: string; cwd?: string }
): void {
  sendMessage({
    type: "create_tab_and_agent",
    id: nextId(),
    payload: {
      workspaceId,
      agentKind,
      modelId: options?.modelId,
      thinking: options?.thinking,
      cwd: options?.cwd,
    },
  });
}

export function closeTab(tabId: string): void {
  sendMessage({
    type: "close_tab",
    id: nextId(),
    payload: { tabId },
  });
}

export function fetchSkills(): void {
  sendMessage({
    type: "skills_get",
    id: nextId(),
  });
}

export function sendConfigPatch(patch: Partial<ClientConfig>): void {
  sendMessage({
    type: "config_patch",
    id: nextId(),
    payload: { client: patch },
  });
}

export function fetchConfig(): void {
  sendMessage({
    type: "config_get",
    id: nextId(),
  });
}

export function reportPresence(): void {
  sendMessage({
    type: "presence_update",
    isVisible: document.visibilityState === "visible",
    viewingPaneId: state.activePaneId,
  });
}

// Presence and auto-healing listener for mobile screen lock / tab switch
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (!socket || socket.readyState !== WebSocket.OPEN || Date.now() - lastPongTime > 15000) {
        try {
          socket?.close();
        } catch {}
        initWebSocket();
      }
    }
    reportPresence();
  });
}
