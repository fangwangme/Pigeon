import type { PaneSummary, TabSummary, WorkspaceSummary } from "../../../types/protocol";

export type HomeOrder = "herdr" | "activity";

export interface HomePrefs {
  order: HomeOrder;
  foldAgentless: boolean;
}

export const DEFAULT_HOME_PREFS: HomePrefs = {
  order: "herdr",
  foldAgentless: false,
};

export type AgentFilterStatus = "blocked" | "working" | "done" | "idle";

export interface AgentsFilter {
  statuses: AgentFilterStatus[];
  agents: string[];
  groupBy: "status" | "workspace";
}

export const DEFAULT_AGENTS_FILTER: AgentsFilter = {
  statuses: [],
  agents: [],
  groupBy: "status",
};

const VALID_AGENT_STATUSES = new Set<AgentFilterStatus>(["blocked", "working", "done", "idle"]);

export function paneActivity(pane: PaneSummary): number | undefined {
  return typeof pane.lastActivityAt === "number" ? pane.lastActivityAt : undefined;
}

export function tabActivity(tab: TabSummary): number | undefined {
  let latest: number | undefined;
  for (const p of tab.panes) {
    const t = paneActivity(p);
    if (t !== undefined && (latest === undefined || t > latest)) latest = t;
  }
  return latest;
}

export function wsActivity(ws: WorkspaceSummary): number | undefined {
  let latest: number | undefined;
  for (const tab of ws.tabs) {
    const t = tabActivity(tab);
    if (t !== undefined && (latest === undefined || t > latest)) latest = t;
  }
  return latest;
}

function sortByActivity<T>(items: readonly T[], activityOf: (item: T) => number | undefined): T[] {
  return items
    .map((item, idx) => ({ item, idx, act: activityOf(item) }))
    .sort((a, b) => {
      if (a.act !== undefined && b.act !== undefined) return b.act !== a.act ? b.act - a.act : a.idx - b.idx;
      if (a.act !== undefined) return -1;
      if (b.act !== undefined) return 1;
      return a.idx - b.idx;
    })
    .map((entry) => entry.item);
}

/**
 * mobile-ui-and-themes.md §2.1: orders workspaces and their tabs either in Herdr's order or by
 * newest `lastActivityAt` (active items first, newest first; inactive and tied items keep Herdr order).
 */
export function orderWorkspaces(workspaces: WorkspaceSummary[], order: HomeOrder): WorkspaceSummary[] {
  if (order === "herdr") return workspaces;
  return sortByActivity(
    workspaces.map((ws) => ({ ...ws, tabs: sortByActivity(ws.tabs, tabActivity) })),
    wsActivity
  );
}

/**
 * mobile-ui-and-themes.md §2.3.2: parses a stored All Agents filter, dropping obsolete fields
 * (`showTerminals`, `showIdle`) and the `terminal` status from earlier builds.
 */
export function parseAgentsFilter(raw: unknown): AgentsFilter {
  let obj: unknown = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return { ...DEFAULT_AGENTS_FILTER };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ...DEFAULT_AGENTS_FILTER };
  }
  const rec = obj as Record<string, unknown>;
  const statuses = Array.isArray(rec.statuses)
    ? rec.statuses.filter((s): s is AgentFilterStatus => typeof s === "string" && VALID_AGENT_STATUSES.has(s as AgentFilterStatus))
    : [];
  const agents = Array.isArray(rec.agents)
    ? rec.agents.filter((a): a is string => typeof a === "string" && a.length > 0)
    : [];
  const groupBy = rec.groupBy === "workspace" ? "workspace" : "status";
  return { statuses, agents, groupBy };
}
