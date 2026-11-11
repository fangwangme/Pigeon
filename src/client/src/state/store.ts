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
  QuotaProvidersConfig,
  QuotaProviderState,
  SessionInfo,
  SessionStats,
  SkillEntry,
  ThemeMode,
  TodoItem,
  WorkspaceSummary,
} from "../../../types/protocol";
import { applyTheme } from "../themes";
import { resolveLocale, setLocale, LOCALES, type LocalePref } from "../i18n";

export type { SkillEntry, AgentRecipeSummary };

export type Route =
  | { name: "home" }
  | { name: "agents" }
  | { name: "session"; from: "home" | "agents" }
  | { name: "new"; workspaceId: string | null; mode: "new" | "resume" }
  | { name: "settings" }
  | { name: "quota"; from?: "home" | "agents" | "settings" }
  | { name: "usage"; from?: "home" | "agents" | "settings"; initialPreset?: "today" | "7d" | "30d" | "year" | "all" | "custom" };

/** mobile-ui-and-themes.md §2.3: stored in this browser only. */
export interface FilterState {
  statuses: Array<"blocked" | "working" | "done" | "idle" | "terminal">;
  agents: string[];
  showTerminals: boolean;
  showIdle: boolean;
  groupBy?: "status" | "workspace";
}

export const EMPTY_FILTER: FilterState = { statuses: [], agents: [], showTerminals: true, showIdle: true, groupBy: "status" };

export interface AppState {
  connected: boolean;
  /** False once the server says this browser holds no valid pairing. */
  paired: boolean;
  lastError: { code: string; message: string; at: number } | null;
  toast: { message: string; at: number } | null;
  updateAvailable: boolean;
  serverVersion: string | null;
  environment?: { kind: "production" | "dev" | "test"; port: number } | null;
  herdrConnected: boolean;
  workspaces: WorkspaceSummary[];
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
  paneSyncing: boolean;
  paneLoaded: boolean;
  queue: QueuedPrompt[];
  skills: SkillEntry[];
  recipes: Record<string, AgentRecipeSummary>;
  themeMode: ThemeMode;
  accent: AccentName;
  /** null: follow the system's reduce-transparency setting (§9.2). */
  reduceTransparency: boolean | null;
  /** mobile-ui-and-themes.md §10.1: kept in this browser only. */
  localePref: LocalePref;
  route: Route;
  terminalOpen: boolean;
  filter: FilterState;
  collapsed: Record<string, boolean>;
  unread: Record<string, boolean>;
  canInstallPWA: boolean;
  configReady: boolean;
  quotaLoading: boolean;
  quotaUsageEnabled: boolean;
  quotaDisplay: "remaining" | "used";
  quotaButton: boolean;
  quotaShowAccount: boolean;
  usageScanMode: "realtime" | "scheduled";
  usageScanInterval: "1m" | "2m" | "5m" | "10m" | "15m";
  quotaProviders: QuotaProvidersConfig;
  quotaSnapshots: QuotaProviderState[];
  quotaUpdated: number | null;
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
const storedLocale = readPref("pigeon_locale");
const storedActivePane = readPref("pigeon_active_pane");
const storedRoute = readJson<Route>("pigeon_route", { name: "home" });

const [state, setState] = createStore<AppState>({
  connected: false,
  paired: true,
  lastError: null,
  toast: null,
  updateAvailable: false,
  serverVersion: null,
  environment: null,
  herdrConnected: true,
  workspaces: [],
  activeTabId: null,
  activePaneId: storedRoute.name === "session" ? storedActivePane : null,
  agentStatus: "idle",
  cards: [],
  pendingInteraction: null,
  rawScreen: "",
  normalizedTurns: [],
  sessionStats: null,
  sessionTitle: null,
  todos: null,
  session: null,
  paneSyncing: false,
  paneLoaded: false,
  queue: [],
  skills: [],
  recipes: {},
  themeMode: (readPref("pigeon_mode") as ThemeMode | null) || "system",
  accent: (readPref("pigeon_accent") as AccentName | null) || "blue",
  reduceTransparency: storedRt === null ? null : storedRt === "1",
  localePref: storedLocale && storedLocale in LOCALES ? (storedLocale as LocalePref) : "system",
  route: storedRoute,
  terminalOpen: false,
  filter: readJson<FilterState>("pigeon_filter", EMPTY_FILTER),
  collapsed: readJson<Record<string, boolean>>("pigeon_collapsed", {}),
  unread: readJson<Record<string, boolean>>("pigeon_unread", {}),
  canInstallPWA: false,
  configReady: false,
  quotaLoading: false,
  quotaUsageEnabled: readPref("pigeon_quota_usage_enabled") !== "0",
  quotaDisplay: "remaining",
  quotaButton: true,
  quotaShowAccount: true,
  usageScanMode: "scheduled",
  usageScanInterval: "5m",
  quotaProviders: { claude: true, codex: true, antigravity: true },
  quotaSnapshots: [],
  quotaUpdated: null,
});

export { state, setState };

/** Applies the language choice, following the browser's languages for 跟随系统 (§10.1). */
function applyLocale(): void {
  setLocale(resolveLocale(state.localePref, globalThis.navigator?.languages ?? []));
}

export function setLocalePref(pref: LocalePref): void {
  setState("localePref", pref);
  writePref("pigeon_locale", pref === "system" ? null : pref);
  applyLocale();
}

applyLocale();
if (typeof window !== "undefined") window.addEventListener("languagechange", applyLocale);

/** Applies the appearance shared by all phones (`protocol.md` §6) and mirrors it for first paint. */
export function applySyncedClientConfig(config: Partial<ClientConfig> | undefined): void {
  if (!config) return;
  if (config.themeMode) setState("themeMode", config.themeMode);
  if (config.accent) setState("accent", config.accent);
  if (config.quotaUsageEnabled !== undefined) {
    setState("quotaUsageEnabled", config.quotaUsageEnabled);
    writePref("pigeon_quota_usage_enabled", config.quotaUsageEnabled ? "1" : "0");
  }
  if (config.quotaDisplay !== undefined) setState("quotaDisplay", config.quotaDisplay);
  if (config.quotaButton !== undefined) setState("quotaButton", config.quotaButton);
  if (config.quotaShowAccount !== undefined) setState("quotaShowAccount", config.quotaShowAccount);
  if (config.usageScanMode !== undefined) setState("usageScanMode", config.usageScanMode);
  if (config.usageScanInterval !== undefined) setState("usageScanInterval", config.usageScanInterval);
  if (config.quotaProviders !== undefined) setState("quotaProviders", config.quotaProviders);
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
  return f.statuses.length > 0 || f.agents.length > 0 || !f.showTerminals || !f.showIdle || (Boolean(f.groupBy) && f.groupBy !== "status");
}

export function toggleCollapsed(workspaceId: string): void {
  setState("collapsed", workspaceId, (v) => !v);
  writePref("pigeon_collapsed", JSON.stringify(state.collapsed));
}

export function setUnread(paneId: string, value: boolean): void {
  if (!!state.unread[paneId] === value) return;
  // A store merges objects, so a key is removed by setting it to undefined.
  setState("unread", paneId, value ? true : undefined!);
  writePref("pigeon_unread", JSON.stringify(state.unread));
}

export function navigate(route: Route): void {
  setState("route", route);
  writePref("pigeon_route", JSON.stringify(route));
  if (route.name === "home") {
    writePref("pigeon_active_pane", null);
  }
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

export const quotaFeatureOn = () => state.quotaUsageEnabled !== false;
export const quotaButtonShown = () => quotaFeatureOn() && state.quotaButton;
