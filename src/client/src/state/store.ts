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
} from "../../types/protocol";
import type { SessionStats } from "../../../shared/agent-session";
import { THEMES, applyTheme, applyFullTheme, type ThemeTokens } from "../themes";

export type { MacroItem, SkillEntry, AgentRecipeSummary };

export interface AppState {
  connected: boolean;
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
  activeGhost: { suggestion: string; actionText: string } | null;
  drawerOpen: boolean;
  terminalSheetOpen: boolean;
  diffDrawerOpen: boolean;
  appearanceModalOpen: boolean;
  macrosModalOpen: boolean;
  newTabModalOpen: boolean;
  pairingModalOpen: boolean;
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
  showOptionSheet: boolean;
  optionSheetOpen: boolean;
  closeTabConfirmModalOpen: boolean;
  tabToClose: { tabId: string; label: string } | null;
  sessionMenuOpen: boolean;
  macros: MacroItem[];
  skills: SkillEntry[];
  recipes: Record<string, AgentRecipeSummary>;
}

const DEFAULT_MACROS: MacroItem[] = [
  { id: "m_model", name: "模型", type: "key", payload: "model" },
  { id: "m_continue", name: "继续", type: "text", payload: "continue" },
  { id: "m_ctrlc", name: "终止", type: "key", payload: "ctrl+c" },
  { id: "m_enter", name: "Enter", type: "key", payload: "enter" },
  { id: "m_tab", name: "Tab", type: "key", payload: "tab" },
];

const [state, setState] = createStore<AppState>({
  connected: false,
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
  activeGhost: null,
  drawerOpen: false,
  terminalSheetOpen: false,
  diffDrawerOpen: false,
  appearanceModalOpen: false,
  macrosModalOpen: false,
  newTabModalOpen: false,
  pairingModalOpen: false,
  activeAgentsModalOpen: false,
  settingsModalOpen: false,
  settingsTab: "appearance",
  canInstallPWA: false,
  themeId: "gruvbox",
  themeKey: "gruvbox",
  themeMode: "system",
  displayDensity:
    typeof localStorage !== "undefined" && localStorage.getItem("pigeon_density")
      ? (localStorage.getItem("pigeon_density") as any)
      : "compact",
  showScrollControls:
    typeof localStorage !== "undefined"
      ? localStorage.getItem("pigeon_scroll_controls") !== "false"
      : true,
  showMacroDock:
    typeof localStorage !== "undefined"
      ? localStorage.getItem("pigeon_show_macro_dock") !== "false"
      : true,
  showOptionSheet: false,
  optionSheetOpen: false,
  closeTabConfirmModalOpen: false,
  tabToClose: null,
  sessionMenuOpen: false,
  macros: DEFAULT_MACROS,
  skills: [],
  recipes: {},
});

export { state, setState };

export function setTheme(themeId: string) {
  if (THEMES[themeId]) {
    setState("themeId", themeId);
    applyTheme(THEMES[themeId]);
    localStorage.setItem("pigeon_theme", themeId);
  }
}

export function setPaletteTheme(themeKey: string, mode: "system" | "light" | "dark") {
  setState("themeKey", themeKey);
  setState("themeMode", mode);
  applyFullTheme(themeKey, mode);
  localStorage.setItem("pigeon_theme_key", themeKey);
  localStorage.setItem("pigeon_theme_mode", mode);
}

export function applySyncedClientConfig(config: Partial<ClientConfig>): void {
  if (!config) return;
  if (config.themeKey || config.themeMode) {
    const key = config.themeKey || state.themeKey;
    const mode = config.themeMode || state.themeMode;
    setState("themeKey", key);
    setState("themeMode", mode);
    applyFullTheme(key, mode);
    localStorage.setItem("pigeon_theme_key", key);
    localStorage.setItem("pigeon_theme_mode", mode);
  }
  if (config.themeId) {
    setState("themeId", config.themeId);
  }
  if (config.displayDensity) {
    setState("displayDensity", config.displayDensity);
    localStorage.setItem("pigeon_density", config.displayDensity);
  }
  if (config.showScrollControls !== undefined) {
    setState("showScrollControls", config.showScrollControls);
    localStorage.setItem("pigeon_scroll_controls", String(config.showScrollControls));
  }
  if (config.showMacroDock !== undefined) {
    setState("showMacroDock", config.showMacroDock);
    localStorage.setItem("pigeon_show_macro_dock", String(config.showMacroDock));
  }
  if (Array.isArray(config.macros)) {
    setState("macros", config.macros);
  }
}

export function setDisplayDensity(density: "compact" | "aggregated" | "detailed") {
  setState("displayDensity", density);
  localStorage.setItem("pigeon_density", density);
}

export function setShowScrollControls(show: boolean) {
  setState("showScrollControls", show);
  localStorage.setItem("pigeon_scroll_controls", String(show));
}

export function setShowMacroDock(show: boolean) {
  setState("showMacroDock", show);
  localStorage.setItem("pigeon_show_macro_dock", String(show));
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

export function openAppearanceModal() {
  openSettingsModal("appearance");
}

export function closeAppearanceModal() {
  closeSettingsModal();
}

export function openMacrosModal() {
  openSettingsModal("macros");
}

export function closeMacrosModal() {
  closeSettingsModal();
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

export function closePairingModal() {
  closeSettingsModal();
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

export function toggleOptionSheet() {
  setState("optionSheetOpen", (open) => !open);
}

export function closeOptionSheet() {
  setState("optionSheetOpen", false);
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
