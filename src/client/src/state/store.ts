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
  SubagentInfo,
  ThemeMode,
  TodoItem,
  WorkspaceSummary,
} from "../../../types/protocol";
import { applyTheme } from "../themes";
import { resolveLocale, setLocale, LOCALES, type LocalePref } from "../i18n";
import {
  DEFAULT_HOME_PREFS,
  parseAgentsFilter,
  type AgentsFilter,
  type HomePrefs,
} from "./list-prefs";

export type { SkillEntry, AgentRecipeSummary, AgentsFilter, HomePrefs };

export type Route =
  | { name: "home" }
  | { name: "agents" }
  | { name: "session"; from: "home" | "agents" }
  | { name: "new"; workspaceId: string | null; mode: "new" | "resume" }
  | { name: "settings" }
  | { name: "quota"; from?: "home" | "agents" | "settings" }
  | { name: "usage"; from?: "home" | "agents" | "settings"; initialPreset?: "today" | "7d" | "30d" | "year" | "all" | "custom" };

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
  subagents: SubagentInfo[];
  session: SessionInfo | null;
  paneSyncing: boolean;
  paneLoaded: boolean;
  queue: QueuedPrompt[];
  queuePaused: boolean;
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
  agentsFilter: AgentsFilter;
  homePrefs: HomePrefs;
  foldedGroupOpen: boolean;
  collapsed: Record<string, boolean>;
  unread: Record<string, boolean>;
  canInstallPWA: boolean;
  configReady: boolean;
  quotaLoading: boolean;
  quotaEnabled: boolean;
  usageEnabled: boolean;
  quotaDisplay: "remaining" | "used";
  quotaButton: boolean;
  quotaShowAccount: boolean;
  usageScanInterval: "1m" | "2m" | "5m" | "10m" | "15m";
  quotaProviders: QuotaProvidersConfig;
  quotaSnapshots: QuotaProviderState[];
  quotaUpdated: number | null;
  usageScannedAt: number | null;
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
  subagents: [],
  session: null,
  paneSyncing: false,
  paneLoaded: false,
  queue: [],
  queuePaused: false,
  skills: [],
  recipes: {},
  themeMode: (readPref("pigeon_mode") as ThemeMode | null) || "system",
  accent: (readPref("pigeon_accent") as AccentName | null) || "blue",
  reduceTransparency: storedRt === null ? null : storedRt === "1",
  localePref: storedLocale && storedLocale in LOCALES ? (storedLocale as LocalePref) : "system",
  route: storedRoute,
  terminalOpen: false,
  agentsFilter: parseAgentsFilter(readPref("pigeon_filter")),
  homePrefs: readJson<HomePrefs>("pigeon_home_prefs", DEFAULT_HOME_PREFS),
  foldedGroupOpen: readPref("pigeon_folded_group_open") === "1",
  collapsed: readJson<Record<string, boolean>>("pigeon_collapsed", {}),
  unread: readJson<Record<string, boolean>>("pigeon_unread", {}),
  canInstallPWA: false,
  configReady: false,
  quotaLoading: false,
  quotaEnabled: readPref("pigeon_quota_enabled") === "1",
  usageEnabled: readPref("pigeon_usage_enabled") !== "0",
  quotaDisplay: "remaining",
  quotaButton: true,
  quotaShowAccount: false,
  usageScanInterval: "15m",
  quotaProviders: { claude: true, codex: true, antigravity: true },
  quotaSnapshots: [],
  quotaUpdated: null,
  usageScannedAt: null,
});

export { state, setState };

/** Applies the language choice, following the browser's languages for 跟随系统 (§10.1). */
function applyLocale(): void {
  const currentLocale = resolveLocale(state.localePref, globalThis.navigator?.languages ?? []);
  setLocale(currentLocale);
  if (typeof window !== "undefined") {
    if ("caches" in window) {
      caches.open("pigeon-settings").then((cache) => cache.put("/__locale", new Response(currentLocale))).catch(() => {});
    }
    navigator.serviceWorker?.controller?.postMessage({ type: "SET_LOCALE", locale: currentLocale });
  }
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
  if (config.quotaEnabled !== undefined) {
    setState("quotaEnabled", config.quotaEnabled);
    writePref("pigeon_quota_enabled", config.quotaEnabled ? "1" : "0");
  }
  if (config.usageEnabled !== undefined) {
    setState("usageEnabled", config.usageEnabled);
    writePref("pigeon_usage_enabled", config.usageEnabled ? "1" : "0");
  }
  if (config.quotaDisplay !== undefined) setState("quotaDisplay", config.quotaDisplay);
  if (config.quotaButton !== undefined) setState("quotaButton", config.quotaButton);
  if (config.quotaShowAccount !== undefined) setState("quotaShowAccount", config.quotaShowAccount);
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

export function setAgentsFilter(filter: AgentsFilter): void {
  setState("agentsFilter", filter);
  writePref("pigeon_filter", JSON.stringify(filter));
}

export function agentsFilterActive(f: AgentsFilter = state.agentsFilter): boolean {
  return f.statuses.length > 0 || f.agents.length > 0;
}

export function agentsFilterDirty(f: AgentsFilter = state.agentsFilter): boolean {
  return f.statuses.length > 0 || f.agents.length > 0 || f.groupBy !== "status";
}

export function setHomePrefs(prefs: HomePrefs): void {
  setState("homePrefs", prefs);
  writePref("pigeon_home_prefs", JSON.stringify(prefs));
}

export function homePrefsActive(p: HomePrefs = state.homePrefs): boolean {
  return p.order !== "herdr" || p.foldAgentless;
}

export function toggleFoldedGroup(): void {
  const next = !state.foldedGroupOpen;
  setState("foldedGroupOpen", next);
  writePref("pigeon_folded_group_open", next ? "1" : "0");
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
  if (typeof window !== "undefined" && (window.scrollY !== 0 || window.scrollX !== 0)) {
    window.scrollTo(0, 0);
  }
}

export function backRoute(r: Route = state.route): Route | null {
  if (r.name === "home") return null;
  if (r.name === "session") {
    return { name: r.from === "agents" ? "agents" : "home" };
  }
  if (r.name === "quota" || r.name === "usage") {
    return { name: (r as { from?: "home" | "agents" | "settings" }).from || "home" };
  }
  return { name: "home" };
}

export function goBack(): void {
  const next = backRoute();
  if (next) navigate(next);
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

export const quotaFeatureOn = () => state.quotaEnabled;
export const usageFeatureOn = () => state.usageEnabled;
export const quotaButtonShown = () => (quotaFeatureOn() || usageFeatureOn()) && state.quotaButton;
export const quotaUsageTarget = (): "quota" | "usage" => (quotaFeatureOn() ? "quota" : "usage");
