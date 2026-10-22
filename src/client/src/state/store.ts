import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import type {
  Card,
  InteractionCardData,
  WorkspaceSummary,
  AgentStatus,
} from "../../types/protocol";
import { THEMES, applyTheme, type ThemeTokens } from "../themes";

export interface AppState {
  connected: boolean;
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  activeTabId: string | null;
  activePaneId: string | null;
  agentStatus: AgentStatus;
  cards: Card[];
  pendingInteraction: InteractionCardData | null;
  rawScreen: string;
  drawerOpen: boolean;
  terminalSheetOpen: boolean;
  themeId: string;
}

const [state, setState] = createStore<AppState>({
  connected: false,
  workspaces: [],
  activeWorkspaceId: null,
  activeTabId: null,
  activePaneId: null,
  agentStatus: "idle",
  cards: [],
  pendingInteraction: null,
  rawScreen: "",
  drawerOpen: false,
  terminalSheetOpen: false,
  themeId: "pigeon-dark",
});

export { state, setState };

export function setTheme(themeId: string) {
  if (THEMES[themeId]) {
    setState("themeId", themeId);
    applyTheme(THEMES[themeId]);
    localStorage.setItem("pigeon_theme", themeId);
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

export function closeTerminalSheet() {
  setState("terminalSheetOpen", false);
}

export function getActiveWorkspace(): WorkspaceSummary | undefined {
  return state.workspaces.find((w) => w.id === state.activeWorkspaceId);
}

export function getActiveTab() {
  const ws = getActiveWorkspace();
  if (!ws) return undefined;
  return ws.tabs.find((t) => t.id === state.activeTabId);
}

export function getSubPanes() {
  const tab = getActiveTab();
  return tab?.panes || [];
}
