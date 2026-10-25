import { createStore } from "solid-js/store";
import type {
  Card,
  InteractionCardData,
  WorkspaceSummary,
  WorkingAgentSummary,
  AgentStatus,
  ClientConfig,
  MacroItem,
  NormalizedTurn,
  FileDiffSummary,
  SkillEntry,
  AgentRecipeSummary,
} from "../../../types/protocol";
import type { SessionStats } from "../../../shared/agent-session";
import { applyFullTheme } from "../themes";
import { DEFAULT_MACROS } from "../../../shared/defaults";

export type { MacroItem, SkillEntry, AgentRecipeSummary };

export interface AppState {
  connected: boolean;
  /** False once the server says this browser holds no valid pairing. */
  paired: boolean;
  lastError: { code: string; message: string; at: number } | null;
  updateAvailable: boolean;
  herdrConnected: boolean;
  lastSyncTimestamp: number;
  serverHost: string;
  workspaces: WorkspaceSummary[];
  workingAgents: WorkingAgentSummary[];
  activeWorkspaceId: string | null;
  activeTabId: string | null;
  activePaneId: string | null;
  agentStatus: AgentStatus;
  cards: Card[];
  normalizedTurns: NormalizedTurn[];
  sessionStats: SessionStats | null;
  sessionTitle: string | null;
  pendingInteraction: InteractionCardData | null;
  rawScreen: string;
  drawerOpen: boolean;
  terminalSheetOpen: boolean;
  diffDrawerOpen: boolean;
  newTabModalOpen: boolean;
  activeAgentsModalOpen: boolean;
  settingsModalOpen: boolean;
  settingsTab: "appearance" | "macros" | "pairing" | "pwa";
  canInstallPWA: boolean;
  themeId: string;
  themeKey: string;
  themeMode: "system" | "light" | "dark";
  displayDensity: "compact" | "aggregated" | "detailed";
  showScrollControls: boolean;
  showMacroDock: boolean;
  confirmCtrlC: boolean;
  closeTabConfirmModalOpen: boolean;
  tabToClose: { tabId: string; label: string } | null;
  sessionMenuOpen: boolean;
  macros: MacroItem[];
  skills: SkillEntry[];
  recipes: Record<string, AgentRecipeSummary>;
}

/** localStorage can throw (private mode, blocked site data); preferences then fall back to defaults. */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-browser convenience only; the server copy in config.json is authoritative
  }
}

const [state, setState] = createStore<AppState>({
  connected: false,
  paired: true,
  lastError: null,
  updateAvailable: false,
  herdrConnected: true,
  lastSyncTimestamp: Date.now(),
  serverHost: typeof window !== "undefined" ? window.location.hostname : "localhost",
  workspaces: [],
  workingAgents: [],
  activeWorkspaceId: null,
  activeTabId: null,
  activePaneId: null,
  agentStatus: "idle",
  cards: [],
  normalizedTurns: [],
  sessionStats: null,
  sessionTitle: null,
  pendingInteraction: null,
  rawScreen: "",
  drawerOpen: false,
  terminalSheetOpen: false,
  diffDrawerOpen: false,
  newTabModalOpen: false,
  activeAgentsModalOpen: false,
  settingsModalOpen: false,
  settingsTab: "appearance",
  canInstallPWA: false,
  themeId: "gruvbox",
  themeKey: "gruvbox",
  themeMode: "system",
  displayDensity: (readPref("pigeon_density") as AppState["displayDensity"] | null) || "compact",
  showScrollControls: readPref("pigeon_scroll_controls") !== "false",
  showMacroDock: readPref("pigeon_show_macro_dock") !== "false",
  confirmCtrlC: true,
  closeTabConfirmModalOpen: false,
  tabToClose: null,
  sessionMenuOpen: false,
  macros: DEFAULT_MACROS,
  skills: [],
  recipes: {},
});

export { state, setState };

export function setPaletteTheme(themeKey: string, mode: "system" | "light" | "dark") {
  setState("themeKey", themeKey);
  setState("themeMode", mode);
  applyFullTheme(themeKey, mode);
  writePref("pigeon_theme_key", themeKey);
  writePref("pigeon_theme_mode", mode);
}

export function applySyncedClientConfig(config: Partial<ClientConfig>): void {
  if (!config) return;
  if (config.themeKey || config.themeMode) {
    const key = config.themeKey || state.themeKey;
    const mode = config.themeMode || state.themeMode;
    setState("themeKey", key);
    setState("themeMode", mode);
    applyFullTheme(key, mode);
    writePref("pigeon_theme_key", key);
    writePref("pigeon_theme_mode", mode);
  }
  if (config.themeId) {
    setState("themeId", config.themeId);
  }
  if (config.displayDensity) {
    setState("displayDensity", config.displayDensity);
    writePref("pigeon_density", config.displayDensity);
  }
  if (config.showScrollControls !== undefined) {
    setState("showScrollControls", config.showScrollControls);
    writePref("pigeon_scroll_controls", String(config.showScrollControls));
  }
  if (config.showMacroDock !== undefined) {
    setState("showMacroDock", config.showMacroDock);
    writePref("pigeon_show_macro_dock", String(config.showMacroDock));
  }
  if (Array.isArray(config.macros)) {
    setState("macros", config.macros);
  }
  if (config.confirmCtrlC !== undefined) {
    setState("confirmCtrlC", config.confirmCtrlC);
  }
}

export function setDisplayDensity(density: "compact" | "aggregated" | "detailed") {
  setState("displayDensity", density);
  writePref("pigeon_density", density);
}

export function setShowScrollControls(show: boolean) {
  setState("showScrollControls", show);
  writePref("pigeon_scroll_controls", String(show));
}

export function setShowMacroDock(show: boolean) {
  setState("showMacroDock", show);
  writePref("pigeon_show_macro_dock", String(show));
}

export function toggleSessionMenu() {
  setState("sessionMenuOpen", (open) => !open);
}

export function closeSessionMenu() {
  setState("sessionMenuOpen", false);
}

export function toggleDrawer() {
  setState("drawerOpen", (open) => !open);
}

export function closeDrawer() {
  setState("drawerOpen", false);
}

export function toggleTerminalSheet() {
  setState("terminalSheetOpen", (open) => !open);
}

export function openDiffDrawer() {
  setState("diffDrawerOpen", true);
}

export function closeDiffDrawer() {
  setState("diffDrawerOpen", false);
}

export function toggleDiffDrawer() {
  setState("diffDrawerOpen", (open) => !open);
}

export function closeTerminalSheet() {
  setState("terminalSheetOpen", false);
}

export function openSettingsModal(tab: "appearance" | "macros" | "pairing" | "pwa" = "appearance") {
  closeDrawer();
  setState("settingsTab", tab);
  setState("settingsModalOpen", true);
}

export function closeSettingsModal() {
  setState("settingsModalOpen", false);
}

export function setSettingsTab(tab: "appearance" | "macros" | "pairing" | "pwa") {
  setState("settingsTab", tab);
}

export function openNewTabModal() {
  setState("newTabModalOpen", true);
}

export function closeNewTabModal() {
  setState("newTabModalOpen", false);
}

export function openPairingModal() {
  openSettingsModal("pairing");
}

export function openActiveAgentsModal() {
  setState("activeAgentsModalOpen", true);
}

export function closeActiveAgentsModal() {
  setState("activeAgentsModalOpen", false);
}

export function toggleActiveAgentsModal() {
  setState("activeAgentsModalOpen", (open) => !open);
}

export function openCloseTabConfirm(tabId: string, label: string) {
  setState("tabToClose", { tabId, label });
  setState("closeTabConfirmModalOpen", true);
}

export function cancelCloseTabConfirm() {
  setState("closeTabConfirmModalOpen", false);
  setState("tabToClose", null);
}

export function getActiveWorkspace(): WorkspaceSummary | undefined {
  return state.workspaces.find((w) => w.id === state.activeWorkspaceId) || state.workspaces[0];
}

export function getActiveTab() {
  const ws = getActiveWorkspace();
  if (!ws) return undefined;
  return ws.tabs.find((t) => t.id === state.activeTabId) || ws.tabs[0];
}

export function getSubPanes() {
  const tab = getActiveTab();
  return tab?.panes || [];
}

export function getBlockedAgentsCount(): number {
  let count = 0;
  for (const ag of state.workingAgents) {
    if (ag.status === "blocked") count++;
  }
  return count;
}
