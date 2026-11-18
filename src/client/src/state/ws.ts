import { reconcile } from "solid-js/store";
import { state, setState, applySyncedClientConfig, setUnread, showToast, writePref } from "./store";
import { load, save, remove, clearAll, sweep, meta, migrateLocalStorageCache, getMemoryPaneView, applyPaneTail, type PaneCacheEntry } from "./pane-cache";
import type {
  ClientMessage,
  ServerMessage,
  SnapshotPayload,
  PaneStatePayload,
  ClientConfig,
  AgentStatus,
  HaveInfo,
  QuotaProviderState,
  NormalizedTurn,
  SessionStats,
  TodoItem,
  SubagentInfo,
  SessionInfo,
} from "../../../types/protocol";
import { hashTurn } from "../../../types/protocol";
import { t } from "../i18n";
import { markConnSent, recordConn, unsentConn } from "./diag";

const PROTOCOL_VERSION = "1.0.0";
// Close codes after which reconnecting cannot help (protocol.md §2.2).
const TERMINAL_CLOSE_CODES = new Set([4401, 4403, 4409, 1008]);
const RETRY_DELAYS_MS = [0, 500, 1000, 2000, 3000];
const PAIRING_CHECK_TIMEOUT_MS = 5000;
const CONNECTING_TIMEOUT_MS = 10000;
const WAKEUP_PING_TIMEOUT_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 15000;

let socket: WebSocket | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectingTimer: ReturnType<typeof setTimeout> | null = null;
let wakeupProbeTimer: ReturnType<typeof setTimeout> | null = null;
let pairingCheck: Promise<void> | null = null;
let retryIndex = 0;
// protocol.md §2.3: whether this connection's daemon runs in debug mode; never stored.
let connectionDebug = false;
let bootstrapRequestedAt = 0;
let hiddenAt: number | null = null;
let lastPongTime = Date.now();
let msgId = 0;
let configVersion = 0;
// The client bundle this page was loaded with, as named by its first `welcome` (protocol.md §3.2).
let loadedBuildId: string | null = null;
const paneRevisions = new Map<string, number>();
const lastStatus = new Map<string, AgentStatus>();
const pending = new Map<string, { resolve: (p: any) => void; reject: (e: { code: string; message: string }) => void }>();
let freshDataArrivedPaneId: string | null = null;
let lastAlivePanesKey = "";
let pendingSelectViewId: string | null = null;
const paneSeqs = new Map<string, number>();

function toPlain<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  return JSON.parse(JSON.stringify(obj));
}

let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSavePaneId: string | null = null;

function saveActivePaneSnapshot(paneId: string): void {
  if (state.session?.bound && state.session.sessionId && state.normalizedTurns.length) {
    void save(paneId, {
      sessionId: state.session.sessionId,
      turns: toPlain(state.normalizedTurns),
      sessionStats: state.sessionStats ? toPlain(state.sessionStats) : null,
      sessionTitle: state.sessionTitle,
      todos: state.todos ? toPlain(state.todos) : null,
      subagents: toPlain(state.subagents),
      session: state.session ? toPlain(state.session) : null,
      queue: toPlain(state.queue),
    });
  }
}

export function debouncedSaveActivePaneSnapshot(paneId: string, delayMs = 300): void {
  pendingSavePaneId = paneId;
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    const target = pendingSavePaneId;
    pendingSavePaneId = null;
    if (target) saveActivePaneSnapshot(target);
  }, delayMs);
}

export function flushActivePaneSnapshot(): void {
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  const target = pendingSavePaneId || state.activePaneId;
  pendingSavePaneId = null;
  if (target) saveActivePaneSnapshot(target);
}

/** protocol.md §2.3: record a connection event, and send it at once to a daemon in debug mode. */
function conn(ev: string, fields?: Record<string, string | number | boolean>): void {
  recordConn(ev, fields);
  if (connectionDebug) flushConnEvents();
}

/** Only onto a socket known alive: while the wakeup probe waits, events stay unsent until its pong. */
function flushConnEvents(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN || wakeupProbeTimer) return;
  const { events, upTo } = unsentConn();
  if (events.length === 0) return;
  socket.send(JSON.stringify({ type: "client_diag", payload: { events } } satisfies ClientMessage));
  markConnSent(upTo);
}

/** protocol.md §2.2: retries wait 0, 0.5, 1, 2, then 3 s; an opened socket resets the schedule. */
function nextRetryAt(): number {
  const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
  retryIndex++;
  conn("retry_wait", { ms: delay });
  return Date.now() + delay;
}

function retryAt(due: number): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const wait = due - Date.now();
  if (wait <= 0) {
    openSocket();
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void initWebSocket();
  }, wait);
}

function scheduleReconnect(): void {
  retryAt(nextRetryAt());
}

function nextId(): string {
  return `cli_${++msgId}`;
}

export function isInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /MicroMessenger|AlipayClient|Weibo|DingTalk|QQ\//i.test(ua);
}

export async function checkPairingFromUrlHash(): Promise<void> {
  const hash = window.location.hash;
  if (!hash.startsWith("#code=")) return;
  const code = hash.slice("#code=".length).trim();
  // In an in-app browser (e.g. WeChat), do NOT purge hash from URL so that
  // when user taps "Open in browser" (在浏览器中打开), the scanner forwards the code to Chrome.
  if (!isInAppBrowser()) {
    // Purge the token from history in a standard browser (security-and-pairing.md §2).
    window.history.replaceState(null, "", "/");
  }
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
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const fetchPromise = fetch("/api/auth/status", {
      credentials: "same-origin",
      ...(controller ? { signal: controller.signal } : {}),
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error("Pairing check timed out"));
      }, PAIRING_CHECK_TIMEOUT_MS);
    });
    const res = await Promise.race([fetchPromise, timeoutPromise]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return !!data.authenticated;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function teardownSocket(ws: WebSocket | null): void {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = null;
  if (connectingTimer) clearTimeout(connectingTimer);
  connectingTimer = null;
  if (wakeupProbeTimer) clearTimeout(wakeupProbeTimer);
  wakeupProbeTimer = null;
  pendingSelectViewId = null;
  for (const p of pending.values()) {
    p.reject(Object.assign(new Error(t("error.disconnected")), { code: "ERR_OFFLINE" }));
  }
  pending.clear();
  connectionDebug = false;
  setState({ connected: false, configReady: false, paneSyncing: false });
  if (ws && socket === ws) socket = null;
}

/** Connects unless a socket is open or an attempt is in flight (protocol.md §2.2). */
export async function initWebSocket(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (pairingCheck) return pairingCheck;
  openSocket();
}

/**
 * protocol.md §2.2: after a socket that never opened, ask whether this browser is still paired.
 * The retry is due `due` (counted from the failure), and never opens before the check ends.
 */
async function checkPairing(due: number): Promise<void> {
  const startedAt = Date.now();
  conn("auth_check");
  let paired: boolean;
  try {
    paired = await isAuthenticated();
  } catch (err) {
    conn("auth_error", { ms: Date.now() - startedAt, error: String((err as Error)?.message ?? err).slice(0, 120) });
    retryAt(due);
    return;
  }
  conn("auth_result", { ms: Date.now() - startedAt, paired });
  if (!paired) {
    retryIndex = 0;
    setState("paired", false);
    void clearAll();
    return;
  }
  retryAt(due);
}

function openSocket(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
  socket = ws;
  const startedAt = Date.now();
  let opened = false;
  conn("ws_start", { retry: retryIndex });
  if (connectingTimer) clearTimeout(connectingTimer);
  connectingTimer = setTimeout(() => {
    connectingTimer = null;
    if (socket !== ws || ws.readyState !== WebSocket.CONNECTING) return;
    console.warn("[Pigeon] WebSocket connect timed out after 10s");
    conn("ws_timeout", { ms: Date.now() - startedAt });
    ws.close();
  }, CONNECTING_TIMEOUT_MS);

  // Every handler checks it still belongs to the current socket: a replaced socket's late
  // close must not clear the new one or schedule a duplicate reconnect.
  ws.onopen = () => {
    if (socket !== ws) return;
    if (connectingTimer) {
      clearTimeout(connectingTimer);
      connectingTimer = null;
    }
    opened = true;
    retryIndex = 0;
    conn("ws_open", { ms: Date.now() - startedAt });
    setState({ connected: true, paired: true });
    lastPongTime = Date.now();
    let have: HaveInfo | undefined;
    if (state.activePaneId && state.session?.bound && state.session.sessionId && state.normalizedTurns.length > 0) {
      const turnCount = state.normalizedTurns.length;
      have = {
        sessionId: state.session.sessionId,
        turnCount,
        ...(turnCount >= 2
          ? { anchorHash: hashTurn(state.normalizedTurns[turnCount - 2]) }
          : { lastTurnHash: hashTurn(state.normalizedTurns[turnCount - 1]) }),
      };
      setState("paneSyncing", true);
    }
    bootstrapRequestedAt = Date.now();
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
      if (Date.now() - lastPongTime > HEARTBEAT_TIMEOUT_MS) {
        console.warn("[Pigeon] WebSocket heartbeat timed out; reconnecting");
        const sincePong = Date.now() - lastPongTime;
        teardownSocket(ws);
        conn("heartbeat_timeout", { since_pong_ms: sincePong });
        try {
          ws.close(); // half-open connection: force a reconnect
        } catch {}
        scheduleReconnect();
        return;
      }
      sendMessage({ type: "ping", timestamp: Date.now() });
      reportPresence();
    }, HEARTBEAT_INTERVAL_MS);
    reportPresence();
  };

  ws.onmessage = (event) => {
    if (socket !== ws) return;
    handleServerMessage(JSON.parse(event.data) as ServerMessage);
  };

  ws.onclose = (event) => {
    if (socket !== ws) return;
    console.warn(`[Pigeon] WebSocket closed: code=${event.code} reason=${JSON.stringify(event.reason || "")}`);
    teardownSocket(ws);
    conn("ws_close", { code: event.code, ms: Date.now() - startedAt, opened });
    if (event.code === 4401 || event.code === 4403) {
      void clearAll();
    }
    if (TERMINAL_CLOSE_CODES.has(event.code)) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      retryIndex = 0;
      setState("paired", event.code === 4409);
      return;
    }
    if (opened) {
      scheduleReconnect();
      return;
    }
    // A refused upgrade (HTTP 401) surfaces as a plain close before opening.
    pairingCheck = checkPairing(nextRetryAt()).finally(() => {
      pairingCheck = null;
    });
  };
}

/** mobile-ui-and-themes.md §4.4: per pane, the alert closed while it stays pending there. */
const closedAlerts = new Map<string, string>();
export const isAlertClosed = (paneId: string | null, interactionId: string) => !!paneId && closedAlerts.get(paneId) === interactionId;
export const closeAlert = (paneId: string | null, interactionId: string) => paneId && closedAlerts.set(paneId, interactionId);

function applyPaneState(p: PaneStatePayload): void {
  if (p.paneId !== state.activePaneId) return;
  const last = paneRevisions.get(p.paneId) || 0;
  if (p.revision <= last) return; // out-of-order or replayed update
  paneRevisions.set(p.paneId, p.revision);
  if (closedAlerts.get(p.paneId) !== p.pendingInteraction?.interactionId) closedAlerts.delete(p.paneId);
  const prevStatus = state.agentStatus;
  setState({
    activeTabId: p.tabId,
    agentStatus: p.agentStatus,
    cards: p.cards,
    pendingInteraction: p.pendingInteraction,
    rawScreen: p.rawScreen,
  });
  if (prevStatus === "working" && p.agentStatus !== "working") {
    if (state.activePaneId) {
      flushActivePaneSnapshot();
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

/** Apply a full turn payload (`pane_bootstrap.turns` or `normalized_turns`) and update the pane cache. */
function applyFullTurns(
  paneId: string,
  payload: {
    turns: NormalizedTurn[];
    sessionStats?: SessionStats;
    sessionTitle?: string;
    todos?: TodoItem[];
    subagents?: SubagentInfo[];
    session: SessionInfo;
  }
): void {
  setState({
    sessionStats: payload.sessionStats || null,
    sessionTitle: payload.sessionTitle || null,
    todos: payload.todos || null,
    subagents: payload.subagents || [],
    session: payload.session,
    paneSyncing: false,
  });
  setState("normalizedTurns", reconcile(payload.turns));
  const metaInfo = meta(paneId);
  if (!payload.session?.bound || (metaInfo && metaInfo.sessionId !== payload.session?.sessionId)) {
    void remove(paneId);
  } else if (payload.session?.sessionId && payload.turns?.length) {
    saveActivePaneSnapshot(paneId);
  }
}

/** Apply an incremental turn delta payload (`pane_bootstrap.resume` or `turns_delta`) to store state. */
function applyTurnDelta(
  paneId: string,
  delta: {
    sinceTurnIndex: number;
    appendTurns: NormalizedTurn[];
    patchLastTurn?: NormalizedTurn;
    sessionStats?: SessionStats;
    sessionTitle?: string;
    todos?: TodoItem[];
    subagents?: SubagentInfo[];
    session?: SessionInfo;
  }
): void {
  setState("paneSyncing", false);
  const { sinceTurnIndex, appendTurns, patchLastTurn, sessionStats, sessionTitle, todos, subagents, session } = delta;
  let current = [...state.normalizedTurns];
  if (sinceTurnIndex === 0 && !patchLastTurn) {
    current = appendTurns;
  } else {
    if (patchLastTurn) current[Math.max(0, sinceTurnIndex - (appendTurns.length > 0 ? 1 : 0))] = patchLastTurn;
    if (appendTurns.length > 0) current = [...current.slice(0, sinceTurnIndex), ...appendTurns];
  }
  setState("normalizedTurns", reconcile(current));
  if (sessionStats) setState("sessionStats", sessionStats);
  if (sessionTitle) setState("sessionTitle", sessionTitle);
  if (todos) setState("todos", todos);
  if (subagents) setState("subagents", reconcile(subagents));
  if (session) setState("session", session);
  debouncedSaveActivePaneSnapshot(paneId);
}

/** protocol.md §3.2: the build the daemon wrote into this page; absent under the Vite dev server. */
function pageBuildId(): string | null {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return null;
  return document.querySelector('meta[name="pigeon-build"]')?.getAttribute("content") || null;
}

/** Exported for tests; the socket's onmessage is the only production caller. */
export function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "welcome":
      // A rebuilt daemon serves a newer client than this page runs; offer the reload (protocol.md §3.2).
      {
        const own = pageBuildId() ?? (loadedBuildId ??= msg.payload.buildId);
        if (msg.payload.buildId !== own) setState("updateAvailable", true);
      }
      conn("welcome", { debug: !!msg.payload.debug });
      connectionDebug = !!msg.payload.debug;
      if (connectionDebug) flushConnEvents();
      // A new server process (daemon restart) numbers pane revisions and config versions from
      // scratch, so marks from the previous connection must not filter its messages.
      paneRevisions.clear();
      configVersion = 0;
      applySyncedClientConfig(msg.payload.clientConfig);
      setState("configReady", true);
      setState("recipes", msg.payload.recipes);
      setState("serverVersion", msg.payload.serverVersion);
      if (msg.payload.environment) {
        setState("environment", msg.payload.environment);
      }
      if (state.quotaEnabled) {
        void fetchQuota();
      }
      return;

    case "quota_updated":
      if (!state.quotaEnabled) return;
      setState("quotaSnapshots", msg.payload.providers);
      setState("quotaUpdated", msg.payload.fetchedAt && msg.payload.fetchedAt > 0 ? msg.payload.fetchedAt : null);
      return;

    case "usage_updated":
      if (!state.usageEnabled) return;
      setState("usageScannedAt", msg.payload.scannedAt);
      return;

    case "skills_sync":
      if (msg.payload.paneId === state.activePaneId) setState("skills", msg.payload.skills);
      if (msg.payload.recipes) setState("recipes", msg.payload.recipes);
      return;

    case "recipes_sync":
      setState("recipes", msg.payload.recipes);
      return;

    case "upstream_status":
      setState("herdrConnected", msg.payload.herdrConnected);
      return;

    case "config_sync":
    case "config_updated": {
      if (msg.payload.version < configVersion) return; // an older broadcast arriving late
      configVersion = msg.payload.version;
      applyClientConfigWithTransitions(msg.payload.client);
      return;
    }

    case "snapshot_update":
      trackUnread(msg.payload);
      setState("workspaces", reconcile(msg.payload.workspaces));
      if (state.herdrConnected) {
        const alive = msg.payload.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => p.id)));
        const key = alive.slice().sort().join(",");
        if (key !== lastAlivePanesKey) {
          lastAlivePanesKey = key;
          void sweep(alive);
        }
      }
      return;

    case "pane_bootstrap": {
      const substituted = !!msg.payload.requestedPaneId && msg.payload.requestedPaneId === state.activePaneId;
      if (msg.payload.paneId !== state.activePaneId && !substituted) return;
      if (substituted) {
        // The requested pane is gone: drop its view before showing the pane the server chose.
        showPane(msg.payload.paneId, null);
        reportPresence();
      }
      freshDataArrivedPaneId = msg.payload.paneId;
      if (typeof msg.payload.turns?.seq === "number") {
        paneSeqs.set(msg.payload.paneId, msg.payload.turns.seq);
      } else if (typeof msg.payload.resume?.seq === "number") {
        paneSeqs.set(msg.payload.paneId, msg.payload.resume.seq);
      }
      if (msg.payload.state) {
        applyPaneState(msg.payload.state);
        setState("paneLoaded", true);
      }
      if (msg.payload.queue) {
        setState("queue", msg.payload.queue);
        setState("queuePaused", Boolean(msg.payload.queuePaused));
      }
      const wasSyncing = state.paneSyncing;
      if (msg.payload.turns) {
        applyFullTurns(msg.payload.paneId, msg.payload.turns);
      } else if (msg.payload.resume) {
        applyTurnDelta(msg.payload.paneId, msg.payload.resume);
      }
      conn("bootstrap", {
        resume: !!msg.payload.resume,
        server_ms: msg.payload.serverMs,
        since_request_ms: Date.now() - bootstrapRequestedAt,
        syncing: wasSyncing,
      });
      return;
    }

    case "pane_state":
      applyPaneState(msg.payload);
      if (msg.payload.paneId === state.activePaneId) setState("paneLoaded", true);
      return;

    case "normalized_turns": {
      if (msg.payload.paneId !== state.activePaneId) return;
      freshDataArrivedPaneId = msg.payload.paneId;
      if (typeof msg.payload.seq === "number") {
        paneSeqs.set(msg.payload.paneId, msg.payload.seq);
      }
      applyFullTurns(msg.payload.paneId, msg.payload);
      return;
    }

    case "turns_delta": {
      if (msg.payload.paneId !== state.activePaneId) return;
      freshDataArrivedPaneId = msg.payload.paneId;
      if (typeof msg.payload.seq === "number") {
        const lastSeq = paneSeqs.get(msg.payload.paneId);
        if (lastSeq !== undefined && msg.payload.seq !== lastSeq + 1) {
          console.warn(`[Pigeon] seq gap on pane ${msg.payload.paneId}: expected ${lastSeq + 1}, got ${msg.payload.seq}. Resyncing.`);
          void selectPane(msg.payload.paneId);
          return;
        }
        paneSeqs.set(msg.payload.paneId, msg.payload.seq);
      }
      applyTurnDelta(msg.payload.paneId, msg.payload);
      return;
    }

    case "pane_tail": {
      if (msg.payload.paneId !== state.activePaneId) {
        paneSeqs.set(msg.payload.paneId, msg.payload.seq);
        applyPaneTail(msg.payload);
      }
      return;
    }

    case "prompt_queue":
      if (msg.payload.paneId === state.activePaneId) {
        setState("queue", msg.payload.items);
        setState("queuePaused", Boolean(msg.payload.paused));
      }
      return;

    case "ack": {
      const p = msg.payload;
      if (msg.replyTo === pendingSelectViewId) {
        pendingSelectViewId = null;
      }
      const waiter = pending.get(msg.replyTo);
      if (waiter) {
        pending.delete(msg.replyTo);
        waiter.resolve(p);
      }
      if (p.approved === false && p.interactionId === state.pendingInteraction?.interactionId) {
        // mobile-ui-and-themes.md §4.1: the card stays; the user can answer in the composer.
        showToast(t("prompt.stillWaiting"));
      }
      if (typeof p.version === "number") configVersion = Math.max(configVersion, p.version);
      return;
    }

    case "error": {
      const message = errorText(msg.error.code, msg.error.message);
      const waiter = msg.replyTo ? pending.get(msg.replyTo) : undefined;
      if (waiter) {
        pending.delete(msg.replyTo!);
        waiter.reject({ ...msg.error, message });
      }
      if (msg.replyTo && msg.replyTo === pendingSelectViewId) {
        setState("paneSyncing", false);
        pendingSelectViewId = null;
      }
      console.error("[Pigeon] server error", msg.error.code, msg.error.message);
      setState("lastError", { code: msg.error.code, message, at: Date.now() });
      if (msg.error.code === "ERR_INTERACTION_STALE" && state.activePaneId) {
        sendMessage({ type: "select_view", id: nextId(), payload: { paneId: state.activePaneId } });
      }
      return;
    }

    case "pong":
      lastPongTime = Date.now();
      if (wakeupProbeTimer) {
        clearTimeout(wakeupProbeTimer);
        wakeupProbeTimer = null;
        if (connectionDebug) flushConnEvents();
      }
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
/** protocol.md §4.14: the daemon reads an agent's (or every agent's) model list again. */
export function refreshModels(agent?: string): Promise<any> {
  return request({ type: "models_refresh", payload: agent ? { agent } : {} });
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
  return request({ type: "agent_prompt", payload: { targetPaneId: state.activePaneId, text, ...(attachments.length ? { attachments } : {}) } }).then(
    (res) => {
      if (res?.duplicate) showToast(t("composer.duplicateSkipped"));
      return res;
    },
  );
}

export function sendKeys(keys: string[]): void {
  if (!state.activePaneId) return;
  sendMessage({ type: "agent_send_keys", id: nextId(), payload: { targetPaneId: state.activePaneId, keys } });
}

export function setScreenWatch(paneId: string, on: boolean): void {
  if (!paneId) return;
  sendMessage({ type: "screen_watch", id: nextId(), payload: { paneId, on } });
}

export function getDetail(payload: {
  paneId: string;
  kind: "tool" | "reasoning" | "file" | "subagent";
  turnId?: string;
  callId?: string;
  filePath?: string;
  subagentId?: string;
}): Promise<any> {
  return request({ type: "detail_get", payload });
}

export function requestSkills(): void {
  sendMessage({ type: "skills_get", id: nextId() });
}

/** protocol.md §4.1: several picks at once (a transcript interaction, or a multi-select question menu). */
export function respondOptionIds(interactionId: string, optionIds: string[], fingerprint: string, otherTexts?: Record<string, string>): Promise<any> {
  if (!state.activePaneId) return Promise.reject({ code: "ERR_NOT_FOUND", message: "no pane" });
  return request({ type: "interaction_respond", payload: { targetPaneId: state.activePaneId, interactionId, optionIds, fingerprint, ...(otherTexts ? { otherTexts } : {}) } });
}

export function respondInteraction(interactionId: string, optionId: string, fingerprint: string, otherTexts?: Record<string, string>): Promise<any> {
  if (!state.activePaneId) return Promise.reject({ code: "ERR_NOT_FOUND", message: "no pane" });
  return request({ type: "interaction_respond", payload: { targetPaneId: state.activePaneId, interactionId, optionId, fingerprint, ...(otherTexts ? { otherTexts } : {}) } });
}

/** protocol.md §4.24: clears the active interaction card and downgrades reported status to idle. */
export function dismissInteraction(interactionId: string): Promise<any> {
  if (!state.activePaneId) return Promise.reject({ code: "ERR_NOT_FOUND", message: "no pane" });
  return request({ type: "interaction_dismiss", payload: { targetPaneId: state.activePaneId, interactionId } });
}

/** The one navigation entry point into a pane: workspace and tab follow from it. */
/** Makes `paneId` the viewed pane, showing `memoryView` (or an empty view) until its data arrives. */
function showPane(paneId: string, memoryView: PaneCacheEntry | null | undefined): void {
  writePref("pigeon_active_pane", paneId);
  paneRevisions.delete(paneId);
  setState({
    activePaneId: paneId,
    cards: [],
    normalizedTurns: memoryView ? memoryView.turns : [],
    sessionStats: memoryView?.sessionStats || null,
    sessionTitle: memoryView?.sessionTitle || null,
    todos: memoryView?.todos || null,
    subagents: memoryView?.subagents || [],
    session: memoryView?.session || null,
    queue: memoryView?.queue || [],
    queuePaused: false,
    pendingInteraction: null,
    rawScreen: "",
    skills: [],
    terminalOpen: false,
    paneSyncing: !!memoryView,
    paneLoaded: !!memoryView,
  });

  for (const w of state.workspaces) {
    const t = w.tabs.find((tab) => tab.panes.some((p) => p.id === paneId));
    if (t) {
      setState("activeTabId", t.id);
      break;
    }
  }
  setUnread(paneId, false);
}

export async function selectPane(paneId: string): Promise<void> {
  const previousPaneId = state.activePaneId;
  if (previousPaneId && previousPaneId !== paneId) {
    flushActivePaneSnapshot();
  }

  freshDataArrivedPaneId = null;
  const memoryView = getMemoryPaneView(paneId);
  showPane(paneId, memoryView);

  let cached: PaneCacheEntry | null = memoryView || null;
  if (!cached) {
    try {
      cached = await load(paneId);
    } catch (err) {
      console.error("[Pigeon] Failed to load pane cache, continuing with network view:", err);
    }
  }
  if (state.activePaneId !== paneId) return;

  let have: HaveInfo | undefined;
  if (cached && freshDataArrivedPaneId !== paneId) {
    setState({
      normalizedTurns: cached.turns,
      sessionStats: cached.sessionStats || null,
      sessionTitle: cached.sessionTitle || null,
      todos: cached.todos || null,
      subagents: cached.subagents || [],
      session: cached.session || null,
      queue: cached.queue || [],
      paneSyncing: true,
    });
    if (cached.sessionId && cached.turns.length > 0) {
      const turnCount = cached.turns.length;
      have = {
        sessionId: cached.sessionId,
        turnCount,
        ...(turnCount >= 2
          ? { anchorHash: hashTurn(cached.turns[turnCount - 2]) }
          : { lastTurnHash: hashTurn(cached.turns[turnCount - 1]) }),
      };
    }
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    const selectViewId = nextId();
    pendingSelectViewId = selectViewId;
    bootstrapRequestedAt = Date.now();
    sendMessage({
      type: "select_view",
      id: selectViewId,
      payload: {
        paneId,
        ...(have ? { have } : {}),
      },
    });
  }
  reportPresence();
}

function clearDisabledFeatureState(prevQuotaEnabled: boolean, prevUsageEnabled: boolean): void {
  if (prevQuotaEnabled && !state.quotaEnabled) {
    setState("quotaSnapshots", []);
    setState("quotaUpdated", null);
  }
  if (prevUsageEnabled && !state.usageEnabled) {
    setState("usageScannedAt", null);
  }
}

/** Applies client config and triggers feature transitions when switches change (quota-and-usage.md §1.1). */
export function applyClientConfigWithTransitions(patch: Partial<ClientConfig> | undefined): void {
  if (!patch) return;
  const prevQuotaEnabled = state.quotaEnabled;
  const prevUsageEnabled = state.usageEnabled;
  applySyncedClientConfig(patch);
  clearDisabledFeatureState(prevQuotaEnabled, prevUsageEnabled);
  if (!prevQuotaEnabled && state.quotaEnabled) {
    void fetchQuota();
  }
}

export async function sendConfigPatch(patch: Partial<ClientConfig>): Promise<void> {
  const prevQuotaEnabled = state.quotaEnabled;
  const prevUsageEnabled = state.usageEnabled;
  applySyncedClientConfig(patch);
  clearDisabledFeatureState(prevQuotaEnabled, prevUsageEnabled);
  try {
    const res = await request({ type: "config_patch", payload: { client: patch } });
    if (res && typeof res.version === "number") {
      configVersion = Math.max(configVersion, res.version);
    }
    if (!prevQuotaEnabled && state.quotaEnabled) {
      void fetchQuota();
    }
  } catch (err) {
    console.error("[Pigeon] sendConfigPatch error", err);
  }
}

/** protocol.md §4.16: reads the daemon's cache by default, or refreshes quota when `refresh` is true. */
export async function fetchQuota(refresh = false): Promise<QuotaProviderState[]> {
  if (!state.quotaEnabled) {
    return [];
  }
  setState("quotaLoading", true);
  try {
    const res = await request({ type: "quota_get", payload: refresh ? { refresh: true } : {} });
    if (res?.providers) {
      setState("quotaSnapshots", res.providers);
      const serverFetchedAt =
        res.fetchedAt ||
        Math.max(0, ...res.providers.map((p: any) => p.snapshot?.fetchedAt ?? p.error?.at ?? 0));
      setState("quotaUpdated", serverFetchedAt > 0 ? serverFetchedAt : null);
      return res.providers;
    }
  } catch (err) {
    console.error("[Pigeon] fetchQuota error", err);
  } finally {
    setState("quotaLoading", false);
  }
  return state.quotaSnapshots;
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
      isVisible: typeof document === "undefined" || document.visibilityState === "visible",
      viewingPaneId: state.route.name === "session" ? state.activePaneId : null,
    } satisfies ClientMessage)
  );
}

/** Copies with the Clipboard API, else a selected textarea; always says whether it worked. */
export function copyText(text: string): void {
  const viaSelection = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    showToast(t(ok ? "common.copied" : "common.copyFailed"));
  };
  if (!navigator.clipboard?.writeText) return viaSelection();
  navigator.clipboard.writeText(text).then(() => showToast(t("common.copied")), viaSelection);
}

// Startup migration and sweep
migrateLocalStorageCache();
void sweep();

export function handleVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    conn("hidden");
    if (state.activePaneId) flushActivePaneSnapshot();
  }
  if (document.visibilityState === "visible") {
    const hiddenFor: Record<string, number> = hiddenAt === null ? {} : { hidden_ms: Date.now() - hiddenAt };
    hiddenAt = null;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      conn("visible", hiddenFor);
      if (!pairingCheck && (!socket || socket.readyState !== WebSocket.CONNECTING)) {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (socket) teardownSocket(socket);
        void initWebSocket();
      }
    } else {
      sendMessage({ type: "ping", timestamp: Date.now() });
      if (wakeupProbeTimer) clearTimeout(wakeupProbeTimer);
      const probedWs = socket;
      wakeupProbeTimer = setTimeout(() => {
        wakeupProbeTimer = null;
        if (socket !== probedWs || probedWs.readyState !== WebSocket.OPEN) return;
        console.warn("[Pigeon] wakeup ping timed out after 3s; reconnecting");
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        teardownSocket(probedWs);
        conn("wakeup_timeout");
        try {
          probedWs.close();
        } catch {}
        void initWebSocket();
      }, WAKEUP_PING_TIMEOUT_MS);
      // Recorded once the probe is armed, so it is not flushed onto a socket that may have died asleep.
      conn("visible", hiddenFor);
    }
  }
  reportPresence();
}

/** protocol.md §2.2: the network came back while a retry waits; try at once. */
export function handleOnline(): void {
  conn("online");
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  void initWebSocket();
}

/** protocol.md §2.3: how long the page took to arrive (a cached shell arrives in a few ms). */
function recordPageStart(): void {
  const nav = typeof performance !== "undefined" ? (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined) : undefined;
  if (!nav) return;
  conn("page_start", {
    nav: nav.type,
    first_byte_ms: Math.round(nav.responseStart),
    html_ms: Math.round(nav.responseEnd),
    transfer: nav.transferSize,
    sw: typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller,
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (state.activePaneId) {
      flushActivePaneSnapshot();
    }
  });
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", () => conn("offline"));
  recordPageStart();
}
