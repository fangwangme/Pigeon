import type { QuotaWindow } from "../../types/protocol";

export function orderWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const categoryRank = new Map<string, number>();
  for (const w of windows) {
    const key = w.family ?? "";
    if (!categoryRank.has(key)) categoryRank.set(key, categoryRank.size);
  }
  const period = (w: QuotaWindow) => w.periodMs ?? Number.POSITIVE_INFINITY;
  return [...windows].sort((a, b) => categoryRank.get(a.family ?? "")! - categoryRank.get(b.family ?? "")! || period(a) - period(b));
}
