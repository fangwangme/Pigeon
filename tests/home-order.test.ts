import { describe, expect, test } from "bun:test";
import { orderWorkspaces, parseAgentsFilter, splitAgentless } from "../src/client/src/state/list-prefs";
import { translate } from "../src/client/src/i18n";
import type { PaneSummary, TabSummary, WorkspaceSummary } from "../src/types/protocol";

// mobile-ui-and-themes.md §2.1 (Home order), §2.3.2 (All agents filter). Issue #27.
const pane = (id: string, lastActivityAt?: number): PaneSummary => ({
  id,
  agent: lastActivityAt === undefined ? null : "claude",
  agentStatus: "idle",
  isPrimary: true,
  ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
});
const tab = (id: string, ...panes: PaneSummary[]): TabSummary => ({ id, label: id, paneCount: panes.length, panes });
const ws = (id: string, ...tabs: TabSummary[]): WorkspaceSummary => ({ id, label: id, folder: `/w/${id}`, tabCount: tabs.length, activeTabId: null, tabs });

const herdrOrder = () => [
  ws("nexus", tab("n1", pane("n1p"))),
  ws("pigeon", tab("g1", pane("g1p")), tab("g2", pane("g2p", 300))),
  ws("lifeos", tab("l1", pane("l1p")), tab("l2", pane("l2p", 100)), tab("l3", pane("l3a", 50), pane("l3b", 200))),
  ws("tokenpulse", tab("t1", pane("t1p"))),
];
const ids = (list: WorkspaceSummary[]) => list.map((w) => `${w.id}:${w.tabs.map((t) => t.id).join(",")}`);

describe("Home order (mobile-ui-and-themes.md §2.1)", () => {
  test("Herdr order keeps workspaces and tabs as given", () => {
    expect(ids(orderWorkspaces(herdrOrder(), "herdr"))).toEqual(ids(herdrOrder()));
  });

  test("activity order puts the newest workspace and tab first, a tab counting its newest pane", () => {
    expect(ids(orderWorkspaces(herdrOrder(), "activity"))).toEqual([
      "pigeon:g2,g1",
      "lifeos:l3,l2,l1",
      "nexus:n1",
      "tokenpulse:t1",
    ]);
  });

  test("workspaces without activity keep Herdr order after the active ones, and equal times keep Herdr order", () => {
    const list = [ws("a", tab("a1", pane("a1p"))), ws("b", tab("b1", pane("b1p", 10))), ws("c", tab("c1", pane("c1p", 10))), ws("d", tab("d1", pane("d1p")))];
    expect(orderWorkspaces(list, "activity").map((w) => w.id)).toEqual(["b", "c", "a", "d"]);
  });
});

describe("folded group of workspaces without agents (mobile-ui-and-themes.md §2.1, §2.3.1)", () => {
  const idleAgent = (id: string): PaneSummary => ({ id, agent: "codex", agentStatus: "idle", isPrimary: true });
  const shell = (id: string): PaneSummary => ({ id, agent: null, agentStatus: "unknown", isPrimary: true });

  test("only workspaces with no agent pane are folded; an idle agent keeps its workspace listed; both keep the given order", () => {
    const list = [
      ws("nexus", tab("n1", shell("n1p"))),
      ws("pigeon", tab("g1", shell("g1p")), tab("g2", idleAgent("g2p"))),
      ws("inkhub", tab("i1", shell("i1p")), tab("i2", shell("i2p"))),
      ws("lifeos", tab("l1", idleAgent("l1p"))),
    ];
    const { listed, folded } = splitAgentless(list);
    expect(listed.map((w) => w.id)).toEqual(["pigeon", "lifeos"]);
    expect(folded.map((w) => w.id)).toEqual(["nexus", "inkhub"]);
  });

  test("the group row and the switch note exist in both languages, with English plural forms", () => {
    expect(translate("en", "home.foldedGroup", { count: 1 })).toBe("1 folded workspace without agents");
    expect(translate("en", "home.foldedGroup", { count: 12 })).toBe("12 folded workspaces without agents");
    expect(translate("zh", "home.foldedGroup", { count: 12 })).toBe("已折叠 12 个没有 Agent 的工作区");
    expect(translate("zh", "filter.foldAgentlessHint")).toBe("只有终端的工作区收进底部一行，点开展开");
    expect(translate("en", "filter.foldAgentlessHint")).toBe("Terminal-only workspaces move into one row at the bottom; tap to expand");
  });
});

describe("All agents filter (mobile-ui-and-themes.md §2.3.2)", () => {
  test("a filter stored by an earlier build loses showTerminals, showIdle and the terminal status", () => {
    const old = { statuses: ["blocked", "terminal", "idle"], agents: ["claude"], showTerminals: false, showIdle: false, groupBy: "workspace" };
    expect(parseAgentsFilter(old)).toEqual({ statuses: ["blocked", "idle"], agents: ["claude"], groupBy: "workspace" });
  });

  test("nothing stored gives the defaults", () => {
    expect(parseAgentsFilter(null)).toEqual({ statuses: [], agents: [], groupBy: "status" });
  });
});
