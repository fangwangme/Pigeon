import { createStore } from "solid-js/store";
import type {
  AccentName,
  AgentRecipeSummary,
  AgentStatus,
  Card,
  ClientConfig,
  InteractionCardData,
  NormalizedTurn,
  QueuedPrompt,
  SessionInfo,
  SessionStats,
  SkillEntry,
  ThemeMode,
  TodoItem,
  WorkingAgentSummary,
  WorkspaceSummary,
} from "../../../types/protocol";
import { applyTheme } from "../themes";

export type { SkillEntry, AgentRecipeSummary };

export type Route =
  | { name: "home" }
  | { name: "agents" }
  | { name: "session"; from: "home" | "agents" }
  | { name: "new"; workspaceId: string | null; mode: "new" | "resume" }
  | { name: "settings" };

/** mobile-ui-and-themes.md §2.3: stored in this browser only. */
export interface FilterState {
  statuses: Array<"blocked" | "working" | "done" | "idle" | "terminal">;
  agents: string[];
  showTerminals: boolean;
  showIdle: boolean;
}

export const EMPTY_FILTER: FilterState = { statuses: [], agents: [], showTerminals: true, showIdle: true };

export interface AppState {
  connected: boolean;
  /** False once the server says this browser holds no valid pairing. */
  paired: boolean;
  lastError: { code: string; message: string; at: number } | null;
  toast: { message: string; at: number } | null;
  updateAvailable: boolean;
  serverVersion: string | null;
  herdrConnected: boolean;
  lastSyncTimestamp: number;
  workspaces: WorkspaceSummary[];
  workingAgents: WorkingAgentSummary[];
  activeWorkspaceId: string | null;
  activeTabId: string | null;
  activePaneId: string | null;
  agentStatus: AgentStatus;
  cards: Card[];
  pendingInteraction: InteractionCardData | null;
  rawScreen: string;
  normalizedTurns: NormalizedTurn[];
  sessionStats: SessionStats | null;
  sessionTitle: string | null;
  todos: TodoItem[] | null;
  session: SessionInfo | null;
  queue: QueuedPrompt[];
  skills: SkillEntry[];
  recipes: Record<string, AgentRecipeSummary>;
  themeMode: ThemeMode;
  accent: AccentName;
  /** null: follow the system's reduce-transparency setting (§9.2). */
  reduceTransparency: boolean | null;
  route: Route;
  terminalOpen: boolean;
  filter: FilterState;
  collapsed: Record<string, boolean>;
  unread: Record<string, boolean>;
  canInstallPWA: boolean;
}

/** localStorage can throw (private mode, blocked site data); preferences then fall back to defaults. */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // per-browser convenience only
  }
}

function readJson<T>(key: string, fallback: T): T {
  const raw = readPref(key);
  if (!raw) return fallback;
  try {
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

const storedRt = readPref("pigeon_reduce_transparency");

const [state, setState] = createStore<AppState>({
  connected: false,
  paired: true,
  lastError: null,
  toast: null,
  updateAvailable: false,
  serverVersion: null,
  herdrConnected: true,
  lastSyncTimestamp: Date.now(),
  workspaces: [],
  workingAgents: [],
  activeWorkspaceId: null,
  activeTabId: null,
  activePaneId: null,
  agentStatus: "idle",
  cards: [],
  pendingInteraction: null,
  rawScreen: "",
  normalizedTurns: [],
  sessionStats: null,
  sessionTitle: null,
  todos: null,
  session: null,
  queue: [],
  skills: [],
  recipes: {},
  themeMode: (readPref("pigeon_mode") as ThemeMode | null) || "system",
  accent: (readPref("pigeon_accent") as AccentName | null) || "blue",
  reduceTransparency: storedRt === null ? null : storedRt === "1",
  route: { name: "home" },
  terminalOpen: false,
  filter: readJson<FilterState>("pigeon_filter", EMPTY_FILTER),
  collapsed: readJson<Record<string, boolean>>("pigeon_collapsed", {}),
  unread: readJson<Record<string, boolean>>("pigeon_unread", {}),
  canInstallPWA: false,
});

export { state, setState };

/** Applies the appearance shared by all phones (`protocol.md` §6) and mirrors it for first paint. */
export function applySyncedClientConfig(config: Partial<ClientConfig> | undefined): void {
  if (!config) return;
  if (config.themeMode) setState("themeMode", config.themeMode);
  if (config.accent) setState("accent", config.accent);
  writePref("pigeon_mode", state.themeMode);
  writePref("pigeon_accent", state.accent);
  applyTheme(state.themeMode, state.accent);
}

export function setReduceTransparency(value: boolean | null): void {
  setState("reduceTransparency", value);
  writePref("pigeon_reduce_transparency", value === null ? null : value ? "1" : "0");
}

export function systemReducesTransparency(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches;
}

export function setFilter(filter: FilterState): void {
  setState("filter", filter);
  writePref("pigeon_filter", JSON.stringify(filter));
}

export function filterActive(f: FilterState = state.filter): boolean {
  return f.statuses.length > 0 || f.agents.length > 0 || !f.showTerminals || !f.showIdle;
}

export function toggleCollapsed(workspaceId: string): void {
  setState("collapsed", workspaceId, (v) => !v);
  writePref("pigeon_collapsed", JSON.stringify(state.collapsed));
}

export function setUnread(paneId: string, value: boolean): void {
  if (!!state.unread[paneId] === value) return;
  setState("unread", (u) => {
    const next = { ...u };
    if (value) next[paneId] = true;
    else delete next[paneId];
    return next;
  });
  writePref("pigeon_unread", JSON.stringify(state.unread));
}

export function navigate(route: Route): void {
  setState("route", route);
}

export function showToast(message: string): void {
  setState("toast", { message, at: Date.now() });
}

export function openTerminal(): void {
  setState("terminalOpen", true);
}

export function draftKey(paneId: string | null): string {
  return `pigeon_draft_${paneId ?? "new"}`;
}
