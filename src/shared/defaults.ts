import type { ClientConfig, MacroItem } from "../types/protocol";

// Single source for defaults shared by the daemon and the PWA.

export const DEFAULT_MACROS: MacroItem[] = [
  { id: "m_model", name: "模型", type: "text", payload: "/model" },
  { id: "m_continue", name: "继续", type: "text", payload: "continue" },
  { id: "m_ctrlc", name: "终止", type: "key", payload: "ctrl+c", confirm: true },
  { id: "m_enter", name: "Enter", type: "key", payload: "enter" },
  { id: "m_tab", name: "Tab", type: "key", payload: "tab" },
];

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  themeKey: "gruvbox",
  themeMode: "system",
  themeId: "gruvbox",
  confirmCtrlC: true,
  defaultView: "cards",
  macros: DEFAULT_MACROS,
  displayDensity: "compact",
  showScrollControls: true,
  showMacroDock: true,
};
