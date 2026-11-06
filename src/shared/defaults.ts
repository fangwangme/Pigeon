import type { ClientConfig } from "../types/protocol";

// Single source for defaults shared by the daemon and the PWA.

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  themeMode: "system",
  accent: "blue",
};

export const ACCENT_NAMES = ["blue", "purple", "green", "orange", "pink"] as const;

/** Client keys older builds wrote and this version removes on load (`architecture.md` §4.7). */
export const REMOVED_CLIENT_KEYS = ["themeKey", "themeId", "confirmCtrlC", "defaultView", "macros", "displayDensity", "showScrollControls", "showMacroDock"];
