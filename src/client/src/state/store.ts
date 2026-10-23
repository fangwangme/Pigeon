import { createStore } from "solid-js/store";
import type {
  Card,
  InteractionCardData,
  WorkspaceSummary,
  WorkingAgentSummary,
  AgentStatus,
} from "../../types/protocol";
import { THEMES, applyTheme, applyFullTheme, type ThemeTokens } from "../themes";

export interface MacroItem {
  id: string;
  name: string;
  type: "text" | "key";
  payload: string;
}

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
  pendingInteraction: InteractionCardData | null;
  rawScreen: string;
  activeGhost: { suggestion: string; actionText: string } | null;
  drawerOpen: boolean;
  terminalSheetOpen: boolean;
  appearanceModalOpen: boolean;
  macrosModalOpen: boolean;
  newTabModalOpen: boolean;
  pairingModalOpen: boolean;
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
  pendingInteraction: null,
  rawScreen: "",
  activeGhost: null,
  drawerOpen: false,
  terminalSheetOpen: false,
  appearanceModalOpen: false,
  macrosModalOpen: false,
  newTabModalOpen: false,
  pairingModalOpen: false,
  themeId: "pigeon-dark",
  themeKey: "pigeon",
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

export function toggleDrawer() {
  setState("drawerOpen", (open) => !open);
}

export function closeDrawer() {
  setState("drawerOpen", false);
}

export function toggleTerminalSheet() {
  setState("terminalSheetOpen", (open) => !open);
}

export function closeTerminalSheet() {
  setState("terminalSheetOpen", false);
}

export function openAppearanceModal() {
  closeDrawer();
  setState("appearanceModalOpen", true);
}

export function closeAppearanceModal() {
  setState("appearanceModalOpen", false);
}

export function openMacrosModal() {
  closeDrawer();
  setState("macrosModalOpen", true);
}

export function closeMacrosModal() {
  setState("macrosModalOpen", false);
}

export function openNewTabModal() {
  setState("newTabModalOpen", true);
}

export function closeNewTabModal() {
  setState("newTabModalOpen", false);
}

export function openPairingModal() {
  closeDrawer();
  setState("pairingModalOpen", true);
}

export function closePairingModal() {
  setState("pairingModalOpen", false);
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
