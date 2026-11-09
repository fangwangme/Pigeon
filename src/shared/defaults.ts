import type { ClientConfig } from "../types/protocol";

// Single source for defaults shared by the daemon and the PWA.

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  themeMode: "system",
  accent: "blue",
  quotaDisplay: "remaining",
  quotaButton: true,
};

export const ACCENT_NAMES = ["blue", "purple", "green", "orange", "pink"] as const;
