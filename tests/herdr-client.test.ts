import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HerdrClient, HerdrError } from "../src/server/herdr-client";
import { FakeHerdr, snapshotOf, tempDir } from "./helpers/fixtures";

// herdr-adapter.md: §3 subscription and lifecycle, §4 agent states, §5 tab creation, §6 prompting.
let herdr: FakeHerdr;
let client: HerdrClient;

beforeEach(async () => {
  herdr = new FakeHerdr(join(tempDir("herdr"), "herdr.sock"));
  await herdr.listen();
  client = new HerdrClient({ socketPath: herdr.socketPath, debounceMs: 5, panePollMs: 60_000 });
});

afterEach(async () => {
  client.disconnect();
  await herdr.close();
});

describe("snapshot (herdr-adapter.md §3)", () => {
  test("panes, agent kinds and project directories come from the snapshot", () => {
    client.applySnapshot(snapshotOf([{ paneId: "p1", agent: "claude", cwd: "/proj" }, { paneId: "p2" }]));
    expect(client.hasPane("p1")).toBe(true);
    expect(client.getPaneAgentKind("p1")).toBe("claude");
    expect(client.getPaneCwd("p1")).toBe("/proj");
    expect(client.getPaneAgentKind("p2")).toBeNull();
    expect(client.getSnapshot().workingAgents.map((a) => a.paneId)).toEqual(["p1"]);
  });

  test("a pane missing from a newer snapshot is forgotten with its screen state", () => {
    client.applySnapshot(snapshotOf([{ paneId: "p1", agent: "claude" }]));
    client.applyScreen("p1", "$ ls\na\n");
    client.applySnapshot(snapshotOf([]));
    expect(client.hasPane("p1")).toBe(false);
    expect(client.getPaneState("p1")).toBeNull();
  });
});

describe("agent states (herdr-adapter.md §4)", () => {
  test("Herdr's status is used as-is when no prompt is on screen", () => {
    client.applySnapshot(snapshotOf([{ paneId: "p1", agent: "claude", status: "working" }]));
    expect(client.applyScreen("p1", "$ bun test\n").agentStatus).toBe("working");
  });

  test("a recognized prompt on screen makes the pane blocked", () => {
    client.applySnapshot(snapshotOf([{ paneId: "p1", agent: "claude", status: "idle" }]));
    const state = client.applyScreen("p1", "Do you want to proceed?\n1. Yes\n2. No\n");
    expect(state.agentStatus).toBe("blocked");
    expect(state.pendingInteraction?.options).toHaveLength(2);
  });

  test("Herdr blocked without a recognized prompt yields a prompt with only the raw key pad", () => {
    client.applySnapshot(snapshotOf([{ paneId: "p1", agent: "claude", status: "blocked" }]));
    const state = client.applyScreen("p1", "some custom TUI question\n");
    expect(state.agentStatus).toBe("blocked");
    expect(state.pendingInteraction?.options).toEqual([]);
  });

  test("an unchanged screen does not bump the revision", () => {
    client.applySnapshot(snapshotOf([{ paneId: "p1", agent: "claude" }]));
    const first = client.applyScreen("p1", "$ ls\n");
    expect(client.applyScreen("p1", "$ ls\n").revision).toBe(first.revision);
    expect(client.applyScreen("p1", "$ ls -a\n").revision).toBe(first.revision + 1);
  });
});

describe("prompting and answering (herdr-adapter.md §6)", () => {
  test("agent panes get agent.prompt; plain panes get the text and Enter", async () => {
    client.applySnapshot(snapshotOf([{ paneId: "p1", agent: "claude" }, { paneId: "p2" }]));
    await client.sendPrompt("p1", "hello");
    await client.sendPrompt("p2", "ls");
    expect(herdr.callsOf("agent.prompt").map((c) => c.params)).toEqual([{ target: "p1", text: "hello" }]);
    expect(herdr.callsOf("pane.send_text").map((c) => c.params)).toEqual([{ pane_id: "p2", text: "ls" }]);
    expect(herdr.callsOf("pane.send_keys").map((c) => c.params)).toEqual([{ pane_id: "p2", keys: ["enter"] }]);
  });

  test("answering sends the keys once and reports whether the prompt went away", async () => {
    client.applySnapshot(snapshotOf([{ paneId: "p1", agent: "claude" }]));
    const pending = client.applyScreen("p1", "Do you want to proceed?\n1. Yes\n2. No\n").pendingInteraction!;
    herdr.handlers["pane.read"] = () => ({ result: { read: { text: "$ next\n" } } });
    expect(await client.answerInteraction("p1", pending.interactionId, ["1"])).toBe(true);
    expect(herdr.callsOf("pane.send_keys").map((c) => c.params.keys)).toEqual([["1"]]);
  });

  test("a prompt still on screen after answering is reported as not approved", async () => {
    client.applySnapshot(snapshotOf([{ paneId: "p1", agent: "claude" }]));
    const screen = "Do you want to proceed?\n1. Yes\n2. No\n";
    const pending = client.applyScreen("p1", screen).pendingInteraction!;
    herdr.handlers["pane.read"] = () => ({ result: { read: { text: screen } } });
    expect(await client.answerInteraction("p1", pending.interactionId, ["1"])).toBe(false);
  });

  test("a failed key send is not retried", async () => {
    client.applySnapshot(snapshotOf([{ paneId: "p1", agent: "claude" }]));
    herdr.handlers["pane.send_keys"] = () => ({ error: { code: "timeout", message: "timed out" } });
    await expect(client.answerInteraction("p1", "int_x", ["1"])).rejects.toBeInstanceOf(HerdrError);
    expect(herdr.callsOf("pane.send_keys")).toHaveLength(1);
  });
});

describe("tab creation (herdr-adapter.md §5)", () => {
  test("the agent starts in the new tab's root pane with the recipe's arguments", async () => {
    herdr.handlers["tab.create"] = () => ({ result: { tab: { tab_id: "t9" }, root_pane: { pane_id: "p9" } } });
    herdr.handlers["session.snapshot"] = () => ({ result: snapshotOf([{ paneId: "p9", agent: "claude" }]) });
    const res = await client.createTabAndAgent("w1", "claude", { modelId: "opus", thinking: "high" });
    expect(res).toEqual({ tabId: "t9", paneId: "p9" });
    const start = herdr.callsOf("agent.start")[0].params;
    expect(start.pane_id).toBe("p9");
    expect(start.kind).toBe("claude");
    expect(start.args).toEqual(["--model", "opus", "--effort", "high"]);
    expect(HerdrClient.validateAgentName(start.name)).toBe(true);
  });

  test("a failed agent start closes the tab it created", async () => {
    herdr.handlers["tab.create"] = () => ({ result: { tab: { tab_id: "t9" }, root_pane: { pane_id: "p9" } } });
    herdr.handlers["agent.start"] = () => ({ error: { code: "agent_not_ready", message: "no" } });
    await expect(client.createTabAndAgent("w1", "claude")).rejects.toBeInstanceOf(HerdrError);
    expect(herdr.callsOf("tab.close").map((c) => c.params)).toEqual([{ tab_id: "t9" }]);
  });
});

describe("connection lifecycle (herdr-adapter.md §3)", () => {
  test("Herdr not running is reported as disconnected, not thrown", async () => {
    const offline = new HerdrClient({ socketPath: join(tempDir("herdr-off"), "none.sock") });
    await offline.connect();
    expect(offline.isConnected()).toBe(false);
    offline.disconnect();
  });

  test("disconnect leaves no reconnect or poll timer running", async () => {
    const offline = new HerdrClient({ socketPath: join(tempDir("herdr-off"), "none.sock") });
    await offline.connect();
    await Bun.sleep(20); // let the subscription socket fail and schedule its retry
    offline.disconnect();
    const internals = offline as any;
    expect([internals.reconnectTimer, internals.snapshotTimer, internals.panePollTimer, internals.snapshotPollTimer]).toEqual([null, null, null, null]);
  });

  test("disconnect settles requests still in flight and emits no late connected", async () => {
    herdr.handlers["pane.read"] = () => "no-reply";
    await client.connect();
    await Bun.sleep(30);
    const events: string[] = [];
    client.on("connected", () => events.push("connected"));
    const pending = client.request("pane.read", { pane_id: "p1" });
    await Bun.sleep(30); // the request has reached the fake Herdr
    client.disconnect();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    await Bun.sleep(30);
    expect(events).toEqual([]);
    expect(client.isConnected()).toBe(false);
  });

  test("subscribes to status changes of every agent pane", async () => {
    herdr.handlers["session.snapshot"] = () => ({ result: snapshotOf([{ paneId: "p1", agent: "claude" }, { paneId: "p2" }]) });
    await client.connect();
    await Bun.sleep(50);
    const subs = herdr.callsOf("events.subscribe").at(-1)!.params.subscriptions;
    expect(subs.filter((s: any) => s.type === "pane.agent_status_changed")).toEqual([{ type: "pane.agent_status_changed", pane_id: "p1" }]);
    expect(client.isConnected()).toBe(true);
  });
});
