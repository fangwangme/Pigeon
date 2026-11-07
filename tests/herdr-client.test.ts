import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HerdrClient, HerdrError } from "../src/server/herdr-client";
import type { PaneStatePayload } from "../src/types/protocol";
import { FakeHerdr, tempDir, topologyOf } from "./helpers/fixtures";

// herdr-adapter.md: §3 topology, events and reads, §4 agent identity and states, §5 tabs, §6 prompting.
let herdr: FakeHerdr;
let client: HerdrClient;

beforeEach(async () => {
  herdr = new FakeHerdr(tempDir("herdr"));
  await herdr.listen();
  client = new HerdrClient({ appSocketPath: herdr.appSocketPath, coreSocketPath: herdr.coreSocketPath, debounceMs: 5, panePollMs: 60_000 });
});

afterEach(async () => {
  client.disconnect();
  await herdr.close();
});

const offlineClient = () => {
  const dir = tempDir("herdr-off");
  return new HerdrClient({ appSocketPath: join(dir, "app.sock"), coreSocketPath: join(dir, "core.sock") });
};

describe("snapshot (herdr-adapter.md §3.1)", () => {
  test("App spaces and tabs are joined with Core terminals by address", async () => {
    herdr.serve([{ paneId: "t1", app: "claude-code", state: "working", cwd: "/proj" }, { paneId: "t2" }]);
    const snap = await client.refreshSnapshot();
    expect(snap.workspaces).toMatchObject([
      { id: "w1", label: "proj", isFocused: true, activeTabId: "tab1", tabs: [{ id: "tab1", panes: [{ id: "t1", agent: "claude", agentStatus: "working" }, { id: "t2", agent: null, agentStatus: "unknown" }] }] },
    ]);
    expect(client.getPaneCwd("t1")).toBe("/proj");
    expect(client.getFocusedPaneId()).toBe("t1");
    expect(snap.workingAgents.map((a) => a.paneId)).toEqual(["t1"]);
  });

  test("a tab named only by its number is labelled after its first pane's agent recipe", () => {
    const snap = client.applySnapshot(topologyOf([{ paneId: "t1", app: "codex" }]));
    expect(snap.workspaces[0].tabs[0].label).toBe("Codex");
  });

  test("a tab with a bound session title uses that title over the recipe label or tab index", () => {
    client.setSessionTitleSource((paneId) => (paneId === "t1" ? "AI Renamed Feature Task" : undefined));
    const snap = client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code" }]));
    expect(snap.workspaces[0].tabs[0].label).toBe("AI Renamed Feature Task");
  });

  test("a user-named tab keeps its name even when a session title exists (protocol.md §5.3)", () => {
    client.setSessionTitleSource((paneId) => (paneId === "t1" ? "AI Renamed Feature Task" : undefined));
    const topo = topologyOf([{ paneId: "t1", app: "claude-code" }]);
    topo.ls.spaces[0].tabs[0].name = "My Custom Work";
    const snap = client.applySnapshot(topo);
    expect(snap.workspaces[0].tabs[0].label).toBe("My Custom Work");
  });

  test("a numeric tab with a session title shows the session title (protocol.md §5.3)", () => {
    client.setSessionTitleSource((paneId) => (paneId === "t1" ? "AI Session Title" : undefined));
    const topo = topologyOf([{ paneId: "t1", app: "claude-code" }]);
    topo.ls.spaces[0].tabs[0].name = "42";
    const snap = client.applySnapshot(topo);
    expect(snap.workspaces[0].tabs[0].label).toBe("AI Session Title");
  });

  test("a numeric tab without a session title shows the recipe label (protocol.md §5.3)", () => {
    client.setSessionTitleSource(() => undefined);
    const topo = topologyOf([{ paneId: "t1", app: "claude-code" }]);
    topo.ls.spaces[0].tabs[0].name = "42";
    const snap = client.applySnapshot(topo);
    expect(snap.workspaces[0].tabs[0].label).toBe("Claude Code");
  });

  test("a terminal the App shows but the Core does not list has no agent and status unknown", () => {
    const topology = topologyOf([{ paneId: "t1", app: "claude-code" }]);
    topology.terminals = [];
    client.applySnapshot(topology);
    expect(client.hasPane("t1")).toBe(true);
    expect(client.getPaneAgentKind("t1")).toBeNull();
    expect(client.getSnapshot().workspaces[0].tabs[0].panes[0].agentStatus).toBe("unknown");
  });

  test("a pane missing from a newer snapshot is forgotten with its screen state", () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code" }]));
    client.applyScreen("t1", "$ ls\na\n");
    client.applySnapshot(topologyOf([]));
    expect(client.hasPane("t1")).toBe(false);
    expect(client.getPaneState("t1")).toBeNull();
  });
});

describe("agent identity and states (herdr-adapter.md §4)", () => {
  test("the status record's app names the agent kind", () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code" }, { paneId: "t2", app: "antigravity" }, { paneId: "t3", app: "opencode" }, { paneId: "t4" }]));
    expect(["t1", "t2", "t3", "t4"].map((id) => client.getPaneAgentKind(id))).toEqual(["claude", "agy", "opencode", null]);
  });

  test("the Core's status is used as-is when no prompt is on screen", () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code", state: "working" }]));
    expect(client.applyScreen("t1", "$ bun test\n").agentStatus).toBe("working");
  });

  test("the Core's error status is shown as blocked", () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "pi", state: "error" }]));
    expect(client.applyScreen("t1", "something failed\n").agentStatus).toBe("blocked");
  });

  test("a recognized prompt on screen makes the pane blocked", () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code", state: "idle" }]));
    const state = client.applyScreen("t1", "Do you want to proceed?\n1. Yes\n2. No\n");
    expect(state.agentStatus).toBe("blocked");
    expect(state.pendingInteraction?.options).toHaveLength(2);
  });

  test("blocked without a recognized prompt yields a prompt with only the raw key pad", () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code", state: "blocked" }]));
    const state = client.applyScreen("t1", "some custom TUI question\n");
    expect(state.agentStatus).toBe("blocked");
    expect(state.pendingInteraction?.options).toEqual([]);
  });

  test("a prompt without a title or question line carries no daemon-written text (protocol.md §5.4)", () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code", state: "blocked" }]));
    const blank = client.applyScreen("t1", "").pendingInteraction!;
    expect([blank.title, blank.question]).toEqual(["", ""]);
    expect(client.applyScreen("t1", "some custom TUI question\n").pendingInteraction!.title).toBe("");
  });

  test("a running command and thinking are summarized as data, not text (protocol.md §5.3)", () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code", state: "working" }]));
    client.applyScreen("t1", "$ bun test\n");
    const pane = client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code", state: "working" }])).workspaces[0].tabs[0].panes[0];
    expect([pane.summary, pane.summaryKind]).toEqual(["bun test", "run"]);
  });

  test("an unchanged screen does not bump the revision", () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code" }]));
    const first = client.applyScreen("t1", "$ ls\n");
    expect(client.applyScreen("t1", "$ ls\n").revision).toBe(first.revision);
    expect(client.applyScreen("t1", "$ ls -a\n").revision).toBe(first.revision + 1);
  });
});

describe("screen reads (herdr-adapter.md §3.3)", () => {
  test("history is read until the Core reports a full-screen program, then only the screen", async () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "opencode" }]));
    herdr.handlers["terminal.read"] = () => ({ result: { text: "screen\n", complete: true, how: "stitched" } });
    await client.readAndClassifyPane("t1");
    await client.readAndClassifyPane("t1");
    expect(herdr.callsOf("terminal.read").map((c) => c.params)).toEqual([
      { terminal: "t1", lines: 200 },
      { terminal: "t1", lines: 0 },
    ]);
  });

  test("a history read that times out falls back to the screen at once and reads only the screen from then on", async () => {
    const fast = new HerdrClient({ appSocketPath: herdr.appSocketPath, coreSocketPath: herdr.coreSocketPath, requestTimeoutMs: 30, panePollMs: 60_000 });
    try {
      fast.applySnapshot(topologyOf([{ paneId: "t1" }]));
      herdr.handlers["terminal.read"] = (params: any) =>
        params.lines > 0 ? "no-reply" : { result: { text: "$ visible\n", complete: true, how: "screen" } };
      const first = await fast.readAndClassifyPane("t1");
      expect(first.rawScreen).toBe("$ visible\n");
      await fast.readAndClassifyPane("t1");
      expect(herdr.callsOf("terminal.read").map((c) => c.params)).toEqual([
        { terminal: "t1", lines: 200 },
        { terminal: "t1", lines: 0 },
        { terminal: "t1", lines: 0 },
      ]);
    } finally {
      fast.disconnect();
    }
  });
});

describe("prompting and answering (herdr-adapter.md §6)", () => {
  test("prompts go through terminal.send for agents and plain terminals alike", async () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code" }, { paneId: "t2" }]));
    await client.sendPrompt("t1", "hello");
    await client.sendPrompt("t2", "ls");
    expect(herdr.callsOf("terminal.send").map((c) => c.params)).toEqual([
      { terminal: "t1", text: "hello" },
      { terminal: "t2", text: "ls" },
    ]);
  });

  test("answering sends the keys once and reports whether the prompt went away", async () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code" }]));
    const pending = client.applyScreen("t1", "Do you want to proceed?\n1. Yes\n2. No\n").pendingInteraction!;
    herdr.handlers["terminal.read"] = () => ({ result: { text: "$ next\n", complete: true, how: "history" } });
    expect(await client.answerInteraction("t1", pending.interactionId, ["1"])).toBe(true);
    expect(herdr.callsOf("terminal.keys").map((c) => c.params)).toEqual([{ terminal: "t1", keys: ["1"] }]);
  });

  test("a prompt still on screen after answering is reported as not approved", async () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code" }]));
    const screen = "Do you want to proceed?\n1. Yes\n2. No\n";
    const pending = client.applyScreen("t1", screen).pendingInteraction!;
    herdr.handlers["terminal.read"] = () => ({ result: { text: screen, complete: true, how: "history" } });
    expect(await client.answerInteraction("t1", pending.interactionId, ["1"])).toBe(false);
  });

  test("a failed key send is not retried and carries the Core's error kind", async () => {
    client.applySnapshot(topologyOf([{ paneId: "t1", app: "claude-code" }]));
    herdr.handlers["terminal.keys"] = () => ({ error: "unavailable" });
    await expect(client.answerInteraction("t1", "int_x", ["1"])).rejects.toMatchObject({ code: "unavailable" });
    expect(herdr.callsOf("terminal.keys")).toHaveLength(1);
  });
});

describe("tab creation and closing (herdr-adapter.md §5)", () => {
  test("the App starts the recipe's command with its arguments in a new tab of the space", async () => {
    herdr.handlers["tab.new"] = () => {
      herdr.serve([{ paneId: "t9", app: "claude-code" }]);
      return { result: { pane: "pane-t9", terminal: "t9" } };
    };
    const res = await client.createTabAndAgent("w1", "claude", { modelId: "opus", thinking: "high", cwd: "/proj" });
    expect(res).toEqual({ tabId: "tab1", paneId: "t9" });
    expect(herdr.callsOf("tab.new")[0].params).toEqual({
      space: "w1",
      folder: "/proj",
      argv: ["claude", "--model", "opus", "--effort", "high"],
    });
  });

  test("Codex always starts with --no-daemon", async () => {
    herdr.handlers["tab.new"] = () => {
      herdr.serve([{ paneId: "t9" }]);
      return { result: { terminal: "t9" } };
    };
    await client.createTabAndAgent("w1", "codex");
    expect(herdr.callsOf("tab.new")[0].params.argv).toEqual(["codex", "--no-daemon"]);
  });

  test("the terminal recipe starts the shell: no argv", async () => {
    herdr.handlers["tab.new"] = () => {
      herdr.serve([{ paneId: "t9" }]);
      return { result: { terminal: "t9" } };
    };
    await client.createTabAndAgent("w1", "terminal");
    expect(herdr.callsOf("tab.new")[0].params).toEqual({ space: "w1" });
  });

  test("an App error is a HerdrError carrying the App's text", async () => {
    herdr.handlers["tab.new"] = () => ({ error: "no such space" });
    await expect(client.createTabAndAgent("w1", "claude")).rejects.toMatchObject({ code: "app_error", message: expect.stringContaining("no such space") });
  });

  test("a reply that names no terminal is invalid_response", async () => {
    herdr.handlers["tab.new"] = () => ({ result: {} });
    const err = await client.createTabAndAgent("w1", "claude").catch((e) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe("invalid_response");
  });

  test("closing a tab passes the phone's confirmation to the App", async () => {
    await client.closeTab("tab1");
    expect(herdr.callsOf("tab.close").map((c) => c.params)).toEqual([{ id: "tab1", confirmed: true }]);
  });

  test("launching with a firstMessage sends tab.new with no name (herdr-adapter.md §5, protocol.md §4.5)", async () => {
    herdr.handlers["tab.new"] = () => {
      herdr.serve([{ paneId: "t9", app: "claude-code" }]);
      return { result: { pane: "pane-t9", terminal: "t9" } };
    };
    await client.createTabAndAgent("w1", "claude", { firstMessage: "Fix the flaky test" });
    const calls = herdr.callsOf("tab.new");
    expect(calls[0].params.name).toBeUndefined();
  });
});

describe("connection lifecycle (herdr-adapter.md §3.2, §3.4)", () => {
  test("Herdr not running is reported as disconnected, not thrown", async () => {
    const offline = offlineClient();
    await offline.connect();
    expect(offline.isConnected()).toBe(false);
    offline.disconnect();
  });

  test("a closed Herdr window means disconnected even while the Core answers", async () => {
    const appless = new HerdrClient({ appSocketPath: join(tempDir("no-app"), "app.sock"), coreSocketPath: herdr.coreSocketPath, debounceMs: 5 });
    await appless.connect();
    await Bun.sleep(50);
    expect(appless.isConnected()).toBe(false);
    appless.disconnect();
  });

  test("connected once both the App and the Core answer", async () => {
    await client.connect();
    await Bun.sleep(50);
    expect(client.isConnected()).toBe(true);
    expect(herdr.callsOf("events.subscribe")).toHaveLength(1);
  });

  test("disconnect settles requests still in flight and emits no late connected", async () => {
    herdr.handlers["terminal.read"] = () => "no-reply";
    await client.connect();
    await Bun.sleep(30);
    const events: string[] = [];
    client.on("connected", () => events.push("connected"));
    const pending = client.coreRequest("terminal.read", { terminal: "t1" });
    await Bun.sleep(30); // the request has reached the fake Herdr
    client.disconnect();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    await Bun.sleep(30);
    expect(events).toEqual([]);
    expect(client.isConnected()).toBe(false);
  });

  test("a terminal event schedules a new snapshot", async () => {
    await client.connect();
    await Bun.sleep(50);
    const before = herdr.callsOf("ls").length;
    herdr.emitEvent("created", "t5", {});
    await Bun.sleep(50);
    expect(herdr.callsOf("ls").length).toBeGreaterThan(before);
  });

  // §3.2 + §3.3: a status event alone must reach viewers, even when the screen did not change.
  async function viewPaneThenChangeStatus(screen: string, from: string, to: string): Promise<PaneStatePayload[]> {
    herdr.serve([{ paneId: "t1", app: "claude-code", state: from }]);
    herdr.handlers["terminal.read"] = () => ({ result: { text: screen, complete: true, how: "history" } });
    await client.connect();
    await Bun.sleep(50);
    await client.readAndClassifyPane("t1");
    const updates: PaneStatePayload[] = [];
    client.on("cards_updated", (s: PaneStatePayload) => updates.push(s));
    herdr.serve([{ paneId: "t1", app: "claude-code", state: to }]);
    herdr.emitEvent("status", "t1", { status: { state: to, app: "claude-code" }, records: {}, reported: true });
    await Bun.sleep(50);
    return updates;
  }

  test("a status that arrives before the next snapshot survives a relabel, so a seen done pane stays idle (§4)", async () => {
    herdr.serve([{ paneId: "t1", app: "codex", state: "working" }]);
    await client.connect();
    await Bun.sleep(50);
    client.once("pane_status_changed", () => {
      client.markSeen("t1");
      client.relabelTabs(); // a session title changed before the event's snapshot arrived
    });
    herdr.serve([{ paneId: "t1", app: "codex", state: "done" }]);
    herdr.emitEvent("status", "t1", { status: { state: "done", app: "codex" }, records: {}, reported: true });
    await Bun.sleep(50);
    expect(client.getSnapshot().workspaces[0].tabs[0].panes[0].agentStatus).toBe("idle");
  });

  test("a status change on an unchanged screen still sends the new status", async () => {
    const updates = await viewPaneThenChangeStatus("$ bun test\n", "working", "idle");
    expect(updates.at(-1)?.agentStatus).toBe("idle");
  });

  test("turning blocked on an unchanged screen still yields the raw key pad", async () => {
    const updates = await viewPaneThenChangeStatus("some custom TUI question\n", "working", "blocked");
    expect(updates.at(-1)?.agentStatus).toBe("blocked");
    expect(updates.at(-1)?.pendingInteraction?.options).toEqual([]);
  });
});
