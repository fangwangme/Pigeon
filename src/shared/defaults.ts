import type { ClientConfig, UsageScanInterval } from "../types/protocol";

// Single source for defaults shared by the daemon and the PWA.

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  themeMode: "system",
  accent: "blue",
  quotaEnabled: false,
  usageEnabled: true,
  quotaDisplay: "remaining",
  quotaButton: true,
  quotaShowAccount: false,
  usageScanInterval: "15m",
};

const SCAN_INTERVAL_MS: Record<UsageScanInterval, number> = {
  "1m": 60_000,
  "2m": 120_000,
  "5m": 300_000,
  "10m": 600_000,
  "15m": 900_000,
};

/** Converts `usageScanInterval` to milliseconds, defaulting to `"15m"`. */
export function scanIntervalToMs(interval?: UsageScanInterval): number {
  return (interval && SCAN_INTERVAL_MS[interval]) || SCAN_INTERVAL_MS["15m"];
}

export const ACCENT_NAMES = ["blue", "purple", "green", "orange", "pink"] as const;
