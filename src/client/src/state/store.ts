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
} from "../../types/protocol";
import type { SessionStats } from "../../../shared/agent-session";
import { THEMES, applyTheme, applyFullTheme, type ThemeTokens } from "../themes";

export type { MacroItem };

export interface AppState {
  connected: boolean;
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
  settingsTab: "appearance" | "macros" | "pairing";
  themeId: string;
  themeKey: string;
  themeMode: "system" | "light" | "dark";
  macros: MacroItem[];
}

const DEFAULT_MACROS: MacroItem[] = [
  { id: "m_model", name: "模型", type: "key", payload: "model" },
  { id: "m_tab", name: "Tab", type: "key", payload: "tab" },
  { id: "m_continue", name: "Continue", type: "text", payload: "continue" },
  { id: "m_approve", name: "Approve", type: "key", payload: "enter" },
  { id: "m_enter", name: "Enter", type: "key", payload: "enter" },
  { id: "m_ctrlc", name: "Ctrl+C", type: "key", payload: "ctrl+c" },
];

const [state, setState] = createStore<AppState>({
  connected: false,
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
  themeId: "tokyo-night",
  themeKey: "tokyo-night",
  themeMode: "dark",
  macros: DEFAULT_MACROS,
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
  if (Array.isArray(config.macros)) {
    setState("macros", config.macros);
  }
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

export function openSettingsModal(tab: "appearance" | "macros" | "pairing" = "appearance") {
  closeDrawer();
  setState("settingsTab", tab);
  setState("settingsModalOpen", true);
}

export function closeSettingsModal() {
  setState("settingsModalOpen", false);
}

export function setSettingsTab(tab: "appearance" | "macros" | "pairing") {
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
