import { state, setState, applySyncedClientConfig, openTerminal, setUnread, showToast } from "./store";
import type { ClientMessage, ServerMessage, SnapshotPayload, PaneStatePayload, ClientConfig, AgentStatus } from "../../../types/protocol";

const PROTOCOL_VERSION = "1.0.0";
// Close codes after which reconnecting cannot help (protocol.md §2.2).
const TERMINAL_CLOSE_CODES = new Set([4401, 4403, 4409, 1008]);
const RECONNECT_MS = 3000;

let socket: WebSocket | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastPongTime = Date.now();
let msgId = 0;
let configVersion = 0;
// The client bundle this page was loaded with, as named by its first `welcome` (protocol.md §3.2).
let loadedBuildId: string | null = null;
const paneRevisions = new Map<string, number>();
const lastStatus = new Map<string, AgentStatus>();
const pending = new Map<string, { resolve: (p: any) => void; reject: (e: { code: string; message: string }) => void }>();

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void initWebSocket(), RECONNECT_MS);
}

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
  if (!ok) setState("paired", false);
}

async function pairWithCode(code: string): Promise<boolean> {
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceName: navigator.userAgent.includes("Android") ? "Android" : "Phone" }),
  });
  const data = await res.json();
  return !!data.success;
}

async function isAuthenticated(): Promise<boolean> {
  const res = await fetch("/api/auth/status", { credentials: "same-origin" });
  const data = await res.json();
  return !!data.authenticated;
}

/** Connects unless already paired-and-connected; shows pairing guidance when not paired. */
export async function initWebSocket(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  let paired: boolean;
  try {
    paired = await isAuthenticated();
  } catch {
    // protocol.md §2.2: the daemon is restarting or the network is down; try again shortly.
    scheduleReconnect();
    return;
  }
  if (!paired) {
    setState("paired", false);
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
    for (const p of pending.values()) p.reject({ code: "ERR_OFFLINE", message: "连接已断开" });
    pending.clear();
    if (TERMINAL_CLOSE_CODES.has(event.code)) {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setState("paired", event.code === 4409);
      return;
    }
    // An HTTP 401 on the upgrade surfaces as a plain close; initWebSocket re-checks pairing first.
    scheduleReconnect();
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
    todos: null,
    session: null,
    queue: [],
    pendingInteraction: null,
    rawScreen: "",
    skills: [],
    terminalOpen: false,
  });
}

function applyPaneState(p: PaneStatePayload): void {
  if (p.paneId !== state.activePaneId) return;
  const last = paneRevisions.get(p.paneId) || 0;
  if (p.revision <= last) return; // out-of-order or replayed update
  paneRevisions.set(p.paneId, p.revision);
  setState({
    activeTabId: p.tabId,
    agentStatus: p.agentStatus,
    cards: p.cards,
    pendingInteraction: p.pendingInteraction,
    rawScreen: p.rawScreen,
  });
}

/** mobile-ui-and-themes.md §2.1: a pane that finished while this phone was not looking is unread. */
function trackUnread(snap: SnapshotPayload): void {
  const viewing = typeof document === "undefined" || document.visibilityState === "visible" ? state.activePaneId : null;
  for (const w of snap.workspaces) {
    for (const t of w.tabs) {
      for (const p of t.panes) {
        const prev = lastStatus.get(p.id);
        lastStatus.set(p.id, p.agentStatus);
        if (p.agentStatus === "done" && prev && prev !== "done" && p.id !== viewing) setUnread(p.id, true);
      }
    }
  }
  const alive = new Set(snap.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => p.id))));
  for (const id of Object.keys(state.unread)) if (!alive.has(id)) setUnread(id, false);
}

/** Exported for tests; the socket's onmessage is the only production caller. */
export function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "welcome":
      // A rebuilt daemon serves a newer client than this page runs; offer the reload (protocol.md §3.2).
      if (loadedBuildId === null) loadedBuildId = msg.payload.buildId;
      else if (msg.payload.buildId !== loadedBuildId) setState("updateAvailable", true);
      // A new server process (daemon restart) numbers pane revisions and config versions from
      // scratch, so marks from the previous connection must not filter its messages.
      paneRevisions.clear();
      configVersion = 0;
      applySyncedClientConfig(msg.payload.clientConfig);
      setState("recipes", msg.payload.recipes);
      setState("serverVersion", msg.payload.serverVersion);
      return;

    case "skills_sync":
      if (msg.payload.paneId === state.activePaneId) setState("skills", msg.payload.skills);
      setState("recipes", msg.payload.recipes);
      return;

    case "upstream_status":
      setState("herdrConnected", msg.payload.herdrConnected);
      return;

    case "config_sync":
    case "config_updated":
      if (msg.payload.version < configVersion) return; // an older broadcast arriving late
      configVersion = msg.payload.version;
      applySyncedClientConfig(msg.payload.client);
      return;

    case "snapshot_update":
      trackUnread(msg.payload);
      setState("workspaces", msg.payload.workspaces);
      return;

    case "pane_state":
      applyPaneState(msg.payload);
      return;

    case "normalized_turns":
      if (msg.payload.paneId !== state.activePaneId) return;
      setState({
        normalizedTurns: msg.payload.turns,
        sessionStats: msg.payload.sessionStats || null,
        sessionTitle: msg.payload.sessionTitle || null,
        todos: msg.payload.todos || null,
        session: msg.payload.session,
      });
      return;

    case "turns_delta": {
      if (msg.payload.paneId !== state.activePaneId) return;
      const { sinceTurnIndex, appendTurns, patchLastTurn, sessionStats, sessionTitle, todos, session } = msg.payload;
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
      if (todos) setState("todos", todos);
      if (session) setState("session", session);
      return;
    }

    case "prompt_queue":
      if (msg.payload.paneId === state.activePaneId) setState("queue", msg.payload.items);
      return;

    case "ack": {
      const p = msg.payload;
      const waiter = pending.get(msg.replyTo);
      if (waiter) {
        pending.delete(msg.replyTo);
        waiter.resolve(p);
      }
      if (p.approved === false && p.interactionId === state.pendingInteraction?.interactionId) {
        // The prompt is still on screen after the key was sent: hand over to the terminal view.
        openTerminal();
      }
      if (typeof p.version === "number") configVersion = Math.max(configVersion, p.version);
      return;
    }

    case "error": {
      const waiter = msg.replyTo ? pending.get(msg.replyTo) : undefined;
      if (waiter) {
        pending.delete(msg.replyTo!);
        waiter.reject(msg.error);
      }
      console.error("[Pigeon] server error", msg.error.code, msg.error.message);
      setState("lastError", { code: msg.error.code, message: errorText(msg.error.code, msg.error.message), at: Date.now() });
      if (msg.error.code === "ERR_INTERACTION_STALE" && state.activePaneId) {
        sendMessage({ type: "select_view", id: nextId(), payload: { paneId: state.activePaneId } });
      }
      return;
    }

    case "pong":
      lastPongTime = Date.now();
      return;
  }
}

/** The user-facing text for an error code (protocol.md §8). */
function errorText(code: string, message: string): string {
  switch (code) {
    case "ERR_AGENT_BLOCKED":
      return "Agent 正在等你回答，先处理它的问题";
    case "ERR_AGENT_NOT_READY":
      return "Agent 还没准备好，稍后再试";
    case "ERR_TIMEOUT":
      return "Herdr 没有及时响应，先看看会话再重试";
    case "ERR_NOT_FOUND":
      return "找不到它了，可能已经关闭";
    case "ERR_INTERACTION_STALE":
      return "这个问题已经变了，已刷新";
    default:
      return message;
  }
}

function sendMessage(msg: ClientMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setState("lastError", { code: "ERR_OFFLINE", message: "离线，消息没有发出，草稿已保留", at: Date.now() });
    return false;
  }
  socket.send(JSON.stringify(msg));
  return true;
}

type Command = Exclude<ClientMessage, { type: "ping" } | { type: "presence_update" } | { type: "hello" }>;
type WithoutId<T> = T extends any ? Omit<T, "id"> : never;

/** Sends a command and resolves with its ack payload; rejects with the error (or offline). */
export function request(msg: WithoutId<Command>): Promise<any> {
  const id = nextId();
  return new Promise((resolve, reject) => {
    if (!sendMessage({ ...msg, id } as ClientMessage)) {
      reject({ code: "ERR_OFFLINE", message: "离线" });
      return;
    }
    pending.set(id, { resolve, reject });
  });
}

export function sendPrompt(text: string, attachments: string[] = []): Promise<any> {
  if (!state.activePaneId) return Promise.reject({ code: "ERR_NOT_FOUND", message: "no pane" });
  return request({ type: "agent_prompt", payload: { targetPaneId: state.activePaneId, text, ...(attachments.length ? { attachments } : {}) } });
}

export function sendKeys(keys: string[]): void {
  if (!state.activePaneId) return;
  sendMessage({ type: "agent_send_keys", id: nextId(), payload: { targetPaneId: state.activePaneId, keys } });
}

export function respondInteraction(interactionId: string, optionId: string, fingerprint: string): Promise<any> {
  if (!state.activePaneId) return Promise.reject({ code: "ERR_NOT_FOUND", message: "no pane" });
  return request({ type: "interaction_respond", payload: { targetPaneId: state.activePaneId, interactionId, optionId, fingerprint } });
}

/** The one navigation entry point into a pane: workspace and tab follow from it. */
export function selectPane(paneId: string): void {
  if (paneId !== state.activePaneId) resetPaneView(paneId);
  for (const w of state.workspaces) {
    const t = w.tabs.find((tab) => tab.panes.some((p) => p.id === paneId));
    if (t) {
      setState("activeTabId", t.id);
      break;
    }
  }
  setUnread(paneId, false);
  sendMessage({ type: "select_view", id: nextId(), payload: { paneId } });
  reportPresence();
}

export function sendConfigPatch(patch: Partial<ClientConfig>): void {
  applySyncedClientConfig(patch);
  sendMessage({ type: "config_patch", id: nextId(), payload: { client: patch } });
}

/** protocol.md §7: uploads go over HTTP before the prompt names them. */
export async function uploadFile(file: File): Promise<{ id: string; name: string; size: number; mime: string }> {
  const res = await fetch("/api/uploads", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": file.type || "application/octet-stream", "X-Pigeon-Filename": encodeURIComponent(file.name || "photo.jpg") },
    body: file,
  });
  if (res.status === 413) throw new Error("文件超过 20 MB");
  if (!res.ok) throw new Error(`上传失败（${res.status}）`);
  return res.json();
}

export function reportPresence(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      type: "presence_update",
      isVisible: document.visibilityState === "visible",
      viewingPaneId: state.route.name === "session" ? state.activePaneId : null,
    } satisfies ClientMessage)
  );
}

export function copyText(text: string): void {
  navigator.clipboard?.writeText(text).then(
    () => showToast("已复制"),
    () => showToast("复制失败")
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
