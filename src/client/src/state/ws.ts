import { state, setState, applySyncedClientConfig, openTerminal, setUnread, showToast } from "./store";
import { load, save, remove, clearAll, sweep, meta, migrateLocalStorageCache } from "./pane-cache";
import type { ClientMessage, ServerMessage, SnapshotPayload, PaneStatePayload, ClientConfig, AgentStatus, HaveInfo } from "../../../types/protocol";
import { hashTurn } from "../../../types/protocol";
import { t } from "../i18n";

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
let freshDataArrivedPaneId: string | null = null;

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
    void clearAll();
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
    let have: HaveInfo | undefined;
    if (state.activePaneId && state.session?.bound && state.session.sessionId && state.normalizedTurns.length > 0) {
      have = {
        sessionId: state.session.sessionId,
        turnCount: state.normalizedTurns.length,
        lastTurnHash: hashTurn(state.normalizedTurns[state.normalizedTurns.length - 1]),
      };
      setState("paneSyncing", true);
    }
    sendMessage({
      type: "hello",
      id: nextId(),
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        subscribePaneId: state.activePaneId || undefined,
        ...(have ? { have } : {}),
      },
    });
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (socket !== ws) return;
      if (Date.now() - lastPongTime > 30000) {
        ws.close(); // half-open connection: force a reconnect
        return;
      }
      sendMessage({ type: "ping", timestamp: Date.now() });
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
    for (const p of pending.values()) p.reject({ code: "ERR_OFFLINE", message: t("error.disconnected") });
    pending.clear();
    if (event.code === 4401 || event.code === 4403) {
      void clearAll();
    }
    if (TERMINAL_CLOSE_CODES.has(event.code)) {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setState("paired", event.code === 4409);
      return;
    }
    // An HTTP 401 on the upgrade surfaces as a plain close; initWebSocket re-checks pairing first.
    scheduleReconnect();
  };
}

function applyPaneState(p: PaneStatePayload): void {
  if (p.paneId !== state.activePaneId) return;
  const last = paneRevisions.get(p.paneId) || 0;
  if (p.revision <= last) return; // out-of-order or replayed update
  paneRevisions.set(p.paneId, p.revision);
  const prevStatus = state.agentStatus;
  setState({
    activeTabId: p.tabId,
    agentStatus: p.agentStatus,
    cards: p.cards,
    pendingInteraction: p.pendingInteraction,
    rawScreen: p.rawScreen,
  });
  if (prevStatus === "working" && p.agentStatus !== "working") {
    if (state.activePaneId && state.session?.bound && state.session.sessionId && state.normalizedTurns.length) {
      void save(state.activePaneId, {
        sessionId: state.session.sessionId,
        turns: state.normalizedTurns,
        sessionStats: state.sessionStats,
        sessionTitle: state.sessionTitle,
        todos: state.todos,
        session: state.session,
      });
    }
  }
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

    case "recipes_sync":
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
      if (msg.payload.herdrConnected) {
        const alive = msg.payload.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => p.id)));
        void sweep(alive);
      }
      return;

    case "pane_state":
      applyPaneState(msg.payload);
      return;

    case "normalized_turns": {
      if (msg.payload.paneId !== state.activePaneId) return;
      freshDataArrivedPaneId = msg.payload.paneId;
      setState({
        normalizedTurns: msg.payload.turns,
        sessionStats: msg.payload.sessionStats || null,
        sessionTitle: msg.payload.sessionTitle || null,
        todos: msg.payload.todos || null,
        session: msg.payload.session,
        paneSyncing: false,
      });
      const metaInfo = meta(msg.payload.paneId);
      if (!msg.payload.session?.bound || (metaInfo && metaInfo.sessionId !== msg.payload.session?.sessionId)) {
        void remove(msg.payload.paneId);
      } else if (msg.payload.session?.sessionId && msg.payload.turns?.length) {
        void save(msg.payload.paneId, {
          sessionId: msg.payload.session.sessionId,
          turns: msg.payload.turns,
          sessionStats: msg.payload.sessionStats || null,
          sessionTitle: msg.payload.sessionTitle || null,
          todos: msg.payload.todos || null,
          session: msg.payload.session,
        });
      }
      return;
    }

    case "turns_delta": {
      if (msg.payload.paneId !== state.activePaneId) return;
      freshDataArrivedPaneId = msg.payload.paneId;
      setState("paneSyncing", false);
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
      return t("error.agentBlocked");
    case "ERR_AGENT_NOT_READY":
      return t("error.agentNotReady");
    case "ERR_TIMEOUT":
      return t("error.timeout");
    case "ERR_NOT_FOUND":
      return t("error.notFound");
    case "ERR_INTERACTION_STALE":
      return t("error.stale");
    default:
      return message;
  }
}

function sendMessage(msg: ClientMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setState("lastError", { code: "ERR_OFFLINE", message: t("error.offlineDraftKept"), at: Date.now() });
    return false;
  }
  socket.send(JSON.stringify(msg));
  return true;
}

type Command = Exclude<ClientMessage, { type: "ping" } | { type: "presence_update" } | { type: "hello" }>;
type WithoutId<T> = T extends any ? Omit<T, "id"> : never;

/** Sends a command and resolves with its ack payload; rejects with the error (or offline). */
/** protocol.md §4.14: the daemon reads every agent's model list again. */
export function refreshModels(): Promise<any> {
  return request({ type: "models_refresh", payload: {} });
}

export function request(msg: WithoutId<Command>): Promise<any> {
  const id = nextId();
  return new Promise((resolve, reject) => {
    if (!sendMessage({ ...msg, id } as ClientMessage)) {
      reject({ code: "ERR_OFFLINE", message: t("common.offline") });
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
export async function selectPane(paneId: string): Promise<void> {
  const previousPaneId = state.activePaneId;
  if (previousPaneId && previousPaneId !== paneId) {
    if (state.session?.bound && state.session.sessionId && state.normalizedTurns.length) {
      await save(previousPaneId, {
        sessionId: state.session.sessionId,
        turns: state.normalizedTurns,
        sessionStats: state.sessionStats,
        sessionTitle: state.sessionTitle,
        todos: state.todos,
        session: state.session,
      });
    }
  }

  freshDataArrivedPaneId = null;
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
    paneSyncing: false,
  });

  for (const w of state.workspaces) {
    const t = w.tabs.find((tab) => tab.panes.some((p) => p.id === paneId));
    if (t) {
      setState("activeTabId", t.id);
      break;
    }
  }
  setUnread(paneId, false);

  const cached = await load(paneId);
  let have: HaveInfo | undefined;
  if (cached && state.activePaneId === paneId && freshDataArrivedPaneId !== paneId) {
    setState({
      normalizedTurns: cached.turns,
      sessionStats: cached.sessionStats || null,
      sessionTitle: cached.sessionTitle || null,
      todos: cached.todos || null,
      session: cached.session || null,
      paneSyncing: true,
    });
    if (cached.sessionId && cached.turns.length > 0) {
      have = {
        sessionId: cached.sessionId,
        turnCount: cached.turns.length,
        lastTurnHash: hashTurn(cached.turns[cached.turns.length - 1]),
      };
    }
  }

  sendMessage({
    type: "select_view",
    id: nextId(),
    payload: {
      paneId,
      ...(have ? { have } : {}),
    },
  });
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
  if (res.status === 413) throw new Error(t("error.fileTooLarge"));
  if (!res.ok) throw new Error(t("error.uploadFailed", { status: res.status }));
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
    () => showToast(t("common.copied")),
    () => showToast(t("common.copyFailed"))
  );
}

// Startup migration and sweep
migrateLocalStorageCache();
void sweep();

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.activePaneId && state.session?.bound && state.session.sessionId && state.normalizedTurns.length) {
      void save(state.activePaneId, {
        sessionId: state.session.sessionId,
        turns: state.normalizedTurns,
        sessionStats: state.sessionStats,
        sessionTitle: state.sessionTitle,
        todos: state.todos,
        session: state.session,
      });
    }
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

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (state.activePaneId && state.session?.bound && state.session.sessionId && state.normalizedTurns.length) {
      void save(state.activePaneId, {
        sessionId: state.session.sessionId,
        turns: state.normalizedTurns,
        sessionStats: state.sessionStats,
        sessionTitle: state.sessionTitle,
        todos: state.todos,
        session: state.session,
      });
    }
  });
}
