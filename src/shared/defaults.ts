import type { ClientConfig } from "../types/protocol";

// Single source for defaults shared by the daemon and the PWA.

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  themeMode: "system",
  accent: "blue",
  quotaUsageEnabled: true,
  quotaDisplay: "remaining",
  quotaButton: true,
  quotaShowAccount: true,
  usageScanMode: "scheduled",
  usageScanInterval: "5m",
};

export const ACCENT_NAMES = ["blue", "purple", "green", "orange", "pink"] as const;
