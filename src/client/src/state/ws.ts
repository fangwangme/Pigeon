import { state, setState } from "./store";
import type {
  ClientMessage,
  ServerMessage,
  SnapshotPayload,
  PaneStatePayload,
} from "../../types/protocol";

let socket: WebSocket | null = null;
let pingInterval: any = null;
let reconnectTimer: any = null;
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

    // Send Handshake
    sendMessage({
      type: "hello",
      id: nextId(),
      payload: {
        protocolVersion: "1.0.0",
        subscribePaneId: state.activePaneId || undefined,
      },
    });

    // Setup 15s ping keepalive
    clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      sendMessage({ type: "ping", id: nextId(), timestamp: Date.now() });
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

  socket.onclose = () => {
    setState("connected", false);
    clearInterval(pingInterval);
    socket = null;
    clearTimeout(reconnectTimer);
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
      break;

    case "snapshot_update": {
      const snap: SnapshotPayload = msg.payload;
      setState("workspaces", snap.workspaces || []);
      setState("workingAgents", snap.workingAgents || []);

      if (!state.activeWorkspaceId && snap.workspaces?.length > 0) {
        const firstWs = snap.workspaces[0];
        setState("activeWorkspaceId", firstWs.id);
        if (firstWs.tabs?.length > 0) {
          const firstTab = firstWs.tabs[0];
          setState("activeTabId", firstTab.id);
          if (firstTab.panes?.length > 0) {
            setState("activePaneId", firstTab.panes[0].id);
          }
        }
      }
      break;
    }

    case "pane_state": {
      const p: PaneStatePayload = msg.payload;
      if (!state.activePaneId || state.activePaneId === p.paneId) {
        setState({
          activePaneId: p.paneId,
          activeWorkspaceId: p.workspaceId,
          activeTabId: p.tabId,
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

    case "pong":
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
  // Clear locally
  setState("pendingInteraction", null);
}

export function selectPane(paneId: string): void {
  setState("activePaneId", paneId);
  sendMessage({
    type: "select_view",
    id: nextId(),
    payload: { paneId },
  });
  reportPresence();
}

export function createTab(workspaceId: string, agentKind: string): void {
  sendMessage({
    type: "create_tab_and_agent",
    id: nextId(),
    payload: { workspaceId, agentKind },
  });
}

export function reportPresence(): void {
  sendMessage({
    type: "presence_update",
    isVisible: document.visibilityState === "visible",
    viewingPaneId: state.activePaneId,
  });
}

// Presence listener for mobile screen lock / tab switch
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", reportPresence);
}
