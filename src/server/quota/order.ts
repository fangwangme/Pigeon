// quota-and-usage.md §2.1: the order every provider's windows are shown in.
import type { QuotaWindow } from "../../types/protocol";

/**
 * Groups windows by category (`family`), categories in the order the provider first names them; within a
 * category the shorter period comes first (5h before 7d) and windows without a period come last.
 */
export function orderWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const categoryRank = new Map<string, number>();
  for (const w of windows) {
    const key = w.family ?? "";
    if (!categoryRank.has(key)) categoryRank.set(key, categoryRank.size);
  }
  const period = (w: QuotaWindow) => w.periodMs ?? Number.POSITIVE_INFINITY;
  // Array.prototype.sort is stable, so equal windows keep the provider's order.
  return [...windows].sort((a, b) => categoryRank.get(a.family ?? "")! - categoryRank.get(b.family ?? "")! || period(a) - period(b));
}
