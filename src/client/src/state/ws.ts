import { state, setState, applySyncedClientConfig, openPairingModal, toggleTerminalSheet } from "./store";
import type { ClientMessage, ServerMessage, SnapshotPayload, PaneStatePayload, ClientConfig } from "../../../types/protocol";

const PROTOCOL_VERSION = "1.0.0";
// Close codes after which reconnecting cannot help (protocol.md §2.2).
const TERMINAL_CLOSE_CODES = new Set([4401, 4403, 4409, 1008]);

let socket: WebSocket | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastPongTime = Date.now();
let msgId = 0;
let configVersion = 0;
const paneRevisions = new Map<string, number>();

function nextId(): string {
  return `cli_${++msgId}`;
}

export async function checkPairingFromUrlHash(): Promise<void> {
  const hash = window.location.hash;
  if (!hash.startsWith("#code=")) return;
  const code = hash.slice("#code=".length).trim();
  // Purge the token from history before anything else (security-and-pairing.md §2).
  window.history.replaceState(null, "", "/");
  const ok = await pairWithCode(code);
  if (!ok) openPairingModal();
}

export async function pairWithCode(code: string): Promise<boolean> {
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceName: navigator.userAgent.includes("Android") ? "Android" : "Mobile Chrome" }),
  });
  const data = await res.json();
  return !!data.success;
}

export async function isAuthenticated(): Promise<boolean> {
  const res = await fetch("/api/auth/status", { credentials: "same-origin" });
  const data = await res.json();
  return !!data.authenticated;
}

/** Connects unless already paired-and-connected; shows pairing guidance when not paired. */
export async function initWebSocket(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (!(await isAuthenticated())) {
    setState("paired", false);
    openPairingModal();
    return;
  }
  setState("paired", true);

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
  socket = ws;

  // Every handler checks it still belongs to the current socket: a replaced socket's late
  // close must not clear the new one or schedule a duplicate reconnect.
  ws.onopen = () => {
    if (socket !== ws) return;
    setState("connected", true);
    lastPongTime = Date.now();
    sendMessage({
      type: "hello",
      id: nextId(),
      payload: { protocolVersion: PROTOCOL_VERSION, subscribePaneId: state.activePaneId || undefined },
    });
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (socket !== ws) return;
      if (Date.now() - lastPongTime > 30000) {
        ws.close(); // half-open connection: force a reconnect
        return;
      }
      sendMessage({ type: "ping", id: nextId(), timestamp: Date.now() });
      reportPresence();
    }, 15000);
    reportPresence();
  };

  ws.onmessage = (event) => {
    if (socket !== ws) return;
    handleServerMessage(JSON.parse(event.data) as ServerMessage);
  };

  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    setState("connected", false);
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (TERMINAL_CLOSE_CODES.has(event.code)) {
      setState("paired", event.code !== 4401 && event.code !== 4403 && event.code !== 1008);
      if (event.code !== 4409) openPairingModal();
      return;
    }
    // An HTTP 401 on the upgrade surfaces as a plain close; initWebSocket re-checks pairing first.
    reconnectTimer = setTimeout(() => void initWebSocket(), 3000);
  };
}

/** Clears everything that belongs to the pane being left, so nothing from it is shown under the next one. */
function resetPaneView(paneId: string): void {
  // The server re-sends the pane's cached state with its current revision (protocol.md §3.3);
  // a high-water mark kept from an earlier visit would drop it.
  paneRevisions.delete(paneId);
  setState({
    activePaneId: paneId,
    cards: [],
    normalizedTurns: [],
    sessionStats: null,
    sessionTitle: null,
    pendingInteraction: null,
    rawScreen: "",
    skills: [],
  });
}

function applyPaneState(p: PaneStatePayload): void {
  if (p.paneId !== state.activePaneId) return;
  const last = paneRevisions.get(p.paneId) || 0;
  if (p.revision <= last) return; // out-of-order or replayed update
  paneRevisions.set(p.paneId, p.revision);
  setState({
    activeWorkspaceId: p.workspaceId,
    activeTabId: p.tabId,
    agentStatus: p.agentStatus,
    cards: p.cards,
    pendingInteraction: p.pendingInteraction,
    rawScreen: p.rawScreen,
  });
}

/** Exported for tests; the socket's onmessage is the only production caller. */
export function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "welcome":
      // A new server process (daemon restart) numbers pane revisions and config versions from
      // scratch, so marks from the previous connection must not filter its messages.
      paneRevisions.clear();
      configVersion = 0;
      applySyncedClientConfig(msg.payload.clientConfig);
      setState("recipes", msg.payload.recipes);
      return;

    case "skills_sync":
      if (msg.payload.paneId === state.activePaneId) setState("skills", msg.payload.skills);
      setState("recipes", msg.payload.recipes);
      return;

    case "upstream_status":
      setState("herdrConnected", msg.payload.herdrConnected);
      setState("lastSyncTimestamp", msg.payload.lastSyncTimestamp);
      return;

    case "config_sync":
    case "config_updated":
      if (msg.payload.version < configVersion) return; // an older broadcast arriving late
      configVersion = msg.payload.version;
      applySyncedClientConfig(msg.payload.client);
      return;

    case "snapshot_update": {
      const snap: SnapshotPayload = msg.payload;
      setState("workspaces", snap.workspaces);
      setState("workingAgents", snap.workingAgents);
      const activeStillExists = snap.workspaces.some((w) => w.tabs.some((t) => t.panes.some((p) => p.id === state.activePaneId)));
      if (state.activePaneId && activeStillExists) return;

      // First snapshot (or the active pane closed): prefer a pane that needs attention.
      const ws =
        snap.workspaces.find((w) => w.hasWarn) ||
        snap.workspaces.find((w) => w.hasWorking) ||
        snap.workspaces.find((w) => w.isFocused) ||
        snap.workspaces[0];
      if (!ws) return;
      const tab =
        ws.tabs.find((t) => t.panes.some((p) => p.agentStatus === "working" || p.agentStatus === "blocked")) ||
        ws.tabs.find((t) => t.id === ws.activeTabId) ||
        ws.tabs[0];
      const pane = tab?.panes.find((p) => p.agentStatus === "working" || p.agentStatus === "blocked") || tab?.panes[0];
      if (pane) selectPane(pane.id);
      return;
    }

    case "pane_state":
      applyPaneState(msg.payload);
      return;

    case "normalized_turns":
      if (msg.payload.paneId !== state.activePaneId) return;
      setState("normalizedTurns", msg.payload.turns);
      setState("sessionStats", msg.payload.sessionStats || null);
      setState("sessionTitle", msg.payload.sessionTitle || null);
      return;

    case "turns_delta": {
      if (msg.payload.paneId !== state.activePaneId) return;
      const { sinceTurnIndex, appendTurns, patchLastTurn, sessionStats, sessionTitle } = msg.payload;
      let current = [...state.normalizedTurns];
      if (sinceTurnIndex === 0 && !patchLastTurn) {
        current = appendTurns;
      } else {
        if (patchLastTurn) current[Math.max(0, sinceTurnIndex - (appendTurns.length > 0 ? 1 : 0))] = patchLastTurn;
        if (appendTurns.length > 0) current = [...current.slice(0, sinceTurnIndex), ...appendTurns];
      }
      setState("normalizedTurns", current);
      if (sessionStats) setState("sessionStats", sessionStats);
      if (sessionTitle) setState("sessionTitle", sessionTitle);
      return;
    }

    case "ack": {
      const p = msg.payload;
      if (p.approved === false && p.interactionId === state.pendingInteraction?.interactionId) {
        // The prompt is still on screen after the key was sent: hand over to the raw terminal.
        if (!state.terminalSheetOpen) toggleTerminalSheet();
      }
      if (typeof p.version === "number") configVersion = Math.max(configVersion, p.version);
      if (p.paneId && p.tabId) selectPane(p.paneId); // a tab we just created
      return;
    }

    case "error":
      console.error("[Pigeon] server error", msg.error.code, msg.error.message);
      setState("lastError", { code: msg.error.code, message: msg.error.message, at: Date.now() });
      if (msg.error.code === "ERR_INTERACTION_STALE" && state.activePaneId) {
        sendMessage({ type: "select_view", id: nextId(), payload: { paneId: state.activePaneId } });
      }
      return;

    case "pong":
      lastPongTime = Date.now();
      return;
  }
}

export function sendMessage(msg: ClientMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setState("lastError", { code: "ERR_OFFLINE", message: "未连接到电脑，消息没有发出", at: Date.now() });
    return false;
  }
  socket.send(JSON.stringify(msg));
  return true;
}

export function sendPrompt(text: string): boolean {
  if (!state.activePaneId) return false;
  return sendMessage({ type: "agent_prompt", id: nextId(), payload: { targetPaneId: state.activePaneId, text } });
}

export function sendKeys(keys: string[]): void {
  if (!state.activePaneId) return;
  sendMessage({ type: "agent_send_keys", id: nextId(), payload: { targetPaneId: state.activePaneId, keys } });
}

export function respondInteraction(interactionId: string, optionId: string, fingerprint: string): void {
  if (!state.activePaneId) return;
  sendMessage({
    type: "interaction_respond",
    id: nextId(),
    payload: { targetPaneId: state.activePaneId, interactionId, optionId, fingerprint },
  });
}

/** The one navigation entry point: workspace and tab follow from the pane. */
export function selectPane(paneId: string): void {
  if (paneId !== state.activePaneId) resetPaneView(paneId);
  for (const w of state.workspaces) {
    const t = w.tabs.find((tab) => tab.panes.some((p) => p.id === paneId));
    if (t) {
      setState({ activeWorkspaceId: w.id, activeTabId: t.id });
      break;
    }
  }
  sendMessage({ type: "select_view", id: nextId(), payload: { paneId } });
  reportPresence();
}

export function createTab(workspaceId: string, agentKind: string, options?: { modelId?: string; thinking?: string; cwd?: string }): void {
  sendMessage({
    type: "create_tab_and_agent",
    id: nextId(),
    payload: { workspaceId, agentKind, modelId: options?.modelId, thinking: options?.thinking, cwd: options?.cwd },
  });
}

export function closeTab(tabId: string): void {
  sendMessage({ type: "close_tab", id: nextId(), payload: { tabId } });
}

export function fetchSkills(): void {
  sendMessage({ type: "skills_get", id: nextId() });
}

export function sendConfigPatch(patch: Partial<ClientConfig>): void {
  sendMessage({ type: "config_patch", id: nextId(), payload: { client: patch } });
}

export function fetchConfig(): void {
  sendMessage({ type: "config_get", id: nextId() });
}

export function reportPresence(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      type: "presence_update",
      isVisible: document.visibilityState === "visible",
      viewingPaneId: state.activePaneId,
    } satisfies ClientMessage)
  );
}

// Single lifecycle listener: phone unlock / tab switch back reconnects a dead socket.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      const stale = Date.now() - lastPongTime > 30000;
      if (!socket || socket.readyState !== WebSocket.OPEN || stale) {
        const old = socket;
        socket = null; // detach first so the old socket's close cannot touch the new one
        old?.close();
        void initWebSocket();
      }
    }
    reportPresence();
  });
}
