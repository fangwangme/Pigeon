import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentAdapterManager } from "../src/server/agent-adapters/index";
import { ConfigManager } from "../src/server/config-manager";
import { HerdrClient } from "../src/server/herdr-client";
import { PairingManager } from "../src/server/pairing";
import { PushManager } from "../src/server/push";
import { SkillScanner } from "../src/server/skill-scanner";
import { UploadStore } from "../src/server/uploads";
import { WsServer } from "../src/server/ws-server";
import { FakeHerdr, fakeWs, tempDir, topologyOf, type FakePane } from "./helpers/fixtures";

// protocol.md §4.2 (queue, attachments), §4.5 (first message, resume), §4.9 (model), §4.11 (rename),
// §4.12 (devices), §4.13 (queue cancel), §5.3 (snapshot fields), §5.8 (prompt_queue).
let dir: string;
let herdr: FakeHerdr;
let client: HerdrClient;
let server: WsServer;
let uploads: UploadStore;
let pairing: PairingManager;

const PANES: FakePane[] = [
  { paneId: "p1", app: "claude-code", state: "working", program: "claude" },
  { paneId: "p2", app: "codex", state: "idle", program: "codex" },
  { paneId: "p3", program: "zsh" },
];

beforeEach(async () => {
  dir = tempDir("cmd");
  herdr = new FakeHerdr(dir);
  herdr.serve(PANES, { folder: dir });
  await herdr.listen();
  herdr.handlers["terminal.read"] = () => ({ result: { text: "$ ls\n", how: "history" } });
  client = new HerdrClient({ appSocketPath: herdr.appSocketPath, coreSocketPath: herdr.coreSocketPath, debounceMs: 5, panePollMs: 60_000 });
  client.applySnapshot(topologyOf(PANES, { folder: dir }));
  uploads = new UploadStore(join(dir, "uploads"));
  pairing = new PairingManager({ devicesFilePath: join(dir, "devices.json"), adminSocketPath: join(dir, "admin.sock"), publicBaseUrl: "https://pigeon.example.ts.net" });
  server = new WsServer({
    buildId: "b",
    herdrClient: client,
    pushManager: new PushManager(join(dir, "vapid.json")),
    configManager: new ConfigManager(join(dir, "config.json"), { HOME: dir }),
    skillScanner: new SkillScanner(dir),
    agentAdapters: new AgentAdapterManager({ home: dir }),
    uploadStore: uploads,
    pairingManager: pairing,
  });
});

afterEach(async () => {
  server.destroy();
  client.disconnect();
  await herdr.close();
});

const send = (ws: any, msg: object) => server.handleMessage(ws, JSON.stringify(msg));
const lastError = (c: ReturnType<typeof fakeWs>) => c.ofType("error").at(-1)?.error.code;
const lastAck = (c: ReturnType<typeof fakeWs>) => c.ofType("ack").at(-1)?.payload;
async function viewer(paneId: string) {
  const c = fakeWs();
  server.handleOpen(c.ws);
  await send(c.ws, { type: "hello", id: "h", payload: { protocolVersion: "1.0.0", subscribePaneId: paneId } });
  return c;
}
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

describe("prompt queue (protocol.md §4.2, §4.13, §5.8)", () => {
  test("a prompt to a working agent is queued, shown to viewers, and sent when the agent goes idle", async () => {
    await client.connect();
    const c = await viewer("p1");
    expect(c.ofType("prompt_queue").at(-1).payload).toEqual({ paneId: "p1", items: [] });
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "also run lint" } });
    expect(lastAck(c)).toMatchObject({ queued: true });
    expect(herdr.callsOf("terminal.send")).toHaveLength(0);
    expect(c.ofType("prompt_queue").at(-1).payload.items.map((i: any) => i.text)).toEqual(["also run lint"]);

    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    expect(herdr.callsOf("terminal.send")[0].params).toEqual({ terminal: "p1", text: "also run lint" });
    await until(() => c.ofType("prompt_queue").at(-1).payload.items.length === 0);
  });

  test("queued prompts go out one per idle, oldest first", async () => {
    await client.connect();
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "one" } });
    await send(c.ws, { type: "agent_prompt", id: "a2", payload: { targetPaneId: "p1", text: "two" } });
    herdr.emitEvent("status", "p1", { status: { state: "done", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    await Bun.sleep(50);
    expect(herdr.callsOf("terminal.send").map((x) => x.params.text)).toEqual(["one"]);
    herdr.emitEvent("status", "p1", { status: { state: "working", app: "claude-code" } });
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 2);
    expect(herdr.callsOf("terminal.send")[1].params.text).toBe("two");
  });

  test("a prompt to an idle agent is sent at once", async () => {
    const c = await viewer("p2");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p2", text: "hi" } });
    expect(lastAck(c)).toMatchObject({ queued: false });
    expect(herdr.callsOf("terminal.send")[0].params).toEqual({ terminal: "p2", text: "hi" });
  });

  test("a queued prompt can be cancelled; cancelling it again is ERR_NOT_FOUND", async () => {
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "later" } });
    const queueId = lastAck(c).queueId;
    await send(c.ws, { type: "queue_cancel", id: "q1", payload: { targetPaneId: "p1", queueId } });
    expect(c.ofType("prompt_queue").at(-1).payload.items).toEqual([]);
    await send(c.ws, { type: "queue_cancel", id: "q2", payload: { targetPaneId: "p1", queueId } });
    expect(lastError(c)).toBe("ERR_NOT_FOUND");
  });
});

describe("attachments (protocol.md §4.2, §7)", () => {
  test("uploaded files are appended as paths with the agent's mention prefix", async () => {
    const shot = uploads.save({ name: "shot.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    const c = await viewer("p2");
    // codex has no mention prefix; claude (queued, p1) would use "@".
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p2", text: "look", attachments: [shot.id] } });
    expect(herdr.callsOf("terminal.send")[0].params.text).toBe(`look\n\n${shot.path}`);

    const c1 = await viewer("p1");
    await send(c1.ws, { type: "agent_prompt", id: "a2", payload: { targetPaneId: "p1", text: "", attachments: [shot.id] } });
    expect(c1.ofType("prompt_queue").at(-1).payload.items[0].text).toBe(`@${shot.path}`);
  });

  test("an unknown upload id is ERR_INVALID_PAYLOAD and nothing is sent", async () => {
    const c = await viewer("p2");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p2", text: "look", attachments: ["up_0000000000000000"] } });
    expect(lastError(c)).toBe("ERR_INVALID_PAYLOAD");
    expect(herdr.callsOf("terminal.send")).toHaveLength(0);
  });
});

describe("creating sessions (protocol.md §4.5, herdr-adapter.md §5)", () => {
  const created = () => herdr.callsOf("tab.new").at(-1)!.params;
  beforeEach(() => {
    herdr.handlers["tab.new"] = () => ({ result: { terminal: "p2" } });
  });

  test("the first message is the tab's task and names it; the folder defaults to the workspace's", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "create_tab_and_agent", id: "n1", payload: { workspaceId: "w1", agentKind: "claude", firstMessage: "Fix the flaky test\nmore detail" } });
    expect(created()).toMatchObject({ space: "w1", name: "Fix the flaky test", folder: dir, task: "Fix the flaky test\nmore detail", argv: ["claude"] });
  });

  test("resuming adds the recipe's resume arguments", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "create_tab_and_agent", id: "n1", payload: { workspaceId: "w1", agentKind: "claude", resumeSessionId: "2c9ad7c8-eac4" } });
    expect(created().argv).toEqual(["claude", "--resume", "2c9ad7c8-eac4"]);
    await send(c.ws, { type: "create_tab_and_agent", id: "n2", payload: { workspaceId: "w1", agentKind: "codex", resumeSessionId: "c1" } });
    expect(created().argv).toEqual(["codex", "--no-daemon", "resume", "c1"]);
  });

  test("a malformed resume id, or an agent that cannot resume, is rejected before anything is created", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "create_tab_and_agent", id: "n1", payload: { workspaceId: "w1", agentKind: "claude", resumeSessionId: "../../etc" } });
    expect(lastError(c)).toBe("ERR_INVALID_PAYLOAD");
    await send(c.ws, { type: "create_tab_and_agent", id: "n2", payload: { workspaceId: "w1", agentKind: "agy", resumeSessionId: "abc" } });
    expect(lastError(c)).toBe("ERR_INVALID_PAYLOAD");
    expect(herdr.callsOf("tab.new")).toHaveLength(0);
  });

  test("a model chosen at launch is reported with source launch (protocol.md §5.6)", async () => {
    const c = fakeWs();
    server.handleOpen(c.ws);
    herdr.handlers["tab.new"] = () => ({ result: { terminal: "p1" } });
    await send(c.ws, { type: "create_tab_and_agent", id: "n1", payload: { workspaceId: "w1", agentKind: "claude", modelId: "opus", thinking: "high" } });
    await send(c.ws, { type: "select_view", id: "s", payload: { paneId: "p1" } });
    expect(c.ofType("normalized_turns").at(-1).payload.session).toMatchObject({ model: { value: "opus", source: "launch" }, thinking: { value: "high", source: "launch" } });
  });
});

describe("session actions", () => {
  test("renaming a tab renames it in Herdr (protocol.md §4.11)", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "tab_rename", id: "r1", payload: { tabId: "tab1", name: "  auth tests " } });
    expect(herdr.callsOf("tab.rename")[0].params).toEqual({ id: "tab1", name: "auth tests" });
    expect(lastAck(c)).toMatchObject({ tabId: "tab1", name: "auth tests" });
    await send(c.ws, { type: "tab_rename", id: "r2", payload: { tabId: "nope", name: "x" } });
    expect(lastError(c)).toBe("ERR_NOT_FOUND");
  });

  test("claude switches model with its own /model command; codex has none (protocol.md §4.9)", async () => {
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_set_model", id: "m1", payload: { targetPaneId: "p1", modelId: "sonnet" } });
    // p1 is working, so the command waits in the queue like any prompt.
    expect(c.ofType("prompt_queue").at(-1).payload.items.map((i: any) => i.text)).toEqual(["/model sonnet"]);
    await send(c.ws, { type: "agent_set_model", id: "m2", payload: { targetPaneId: "p2", modelId: "gpt" } });
    expect(lastError(c)).toBe("ERR_INVALID_PAYLOAD");
    await send(c.ws, { type: "agent_set_model", id: "m3", payload: { targetPaneId: "p1", modelId: "no-such-model" } });
    expect(lastError(c)).toBe("ERR_INVALID_PAYLOAD");
  });

  test("devices can be listed and revoked from the phone (protocol.md §4.12)", async () => {
    const { token } = pairing.createPairingToken();
    const mine = pairing.exchangeToken(token, "Phone A").deviceId!;
    const theirs = pairing.exchangeToken(token, "Phone B").deviceId!;
    const c = fakeWs(mine);
    const o = fakeWs(theirs);
    server.handleOpen(c.ws);
    server.handleOpen(o.ws);
    await send(c.ws, { type: "devices_list", id: "d1" });
    const devices = lastAck(c).devices;
    expect(devices.find((d: any) => d.deviceId === mine).isThisDevice).toBe(true);
    expect(devices.find((d: any) => d.deviceId === theirs).isThisDevice).toBe(false);
    await send(c.ws, { type: "device_revoke", id: "d2", payload: { deviceId: theirs } });
    expect(o.closes[0].code).toBe(4403);
    await send(c.ws, { type: "device_revoke", id: "d3", payload: { deviceId: theirs } });
    expect(lastError(c)).toBe("ERR_NOT_FOUND");
  });

  test("devices are listed newest paired first (protocol.md §4.12)", async () => {
    const { token } = pairing.createPairingToken();
    const ids: string[] = [];
    for (const name of ["Old", "Middle", "New"]) {
      ids.push(pairing.exchangeToken(token, name).deviceId!);
      await Bun.sleep(5);
    }
    const c = fakeWs(ids[0]);
    server.handleOpen(c.ws);
    await send(c.ws, { type: "devices_list", id: "d1" });
    const names = lastAck(c).devices.map((d: any) => d.deviceName);
    expect(names.filter((n: string) => ["Old", "Middle", "New"].includes(n))).toEqual(["New", "Middle", "Old"]);
  });
});

describe("snapshot fields (protocol.md §5.3, herdr-adapter.md §3.1)", () => {
  test("workspace folder and branch, tab branch, pane program", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feat/1-ui\n");
    const snap = client.applySnapshot(topologyOf(PANES.map((p) => ({ ...p, cwd: dir })), { folder: dir }));
    const ws = snap.workspaces[0];
    expect([ws.folder, ws.branch, ws.tabs[0].branch]).toEqual([dir, "feat/1-ui", "feat/1-ui"]);
    expect(ws.tabs[0].panes.map((p) => p.program)).toEqual(["claude", "codex", "zsh"]);
  });

  test("a detached HEAD or no repository gives no branch", () => {
    const snap = client.applySnapshot(topologyOf(PANES, { folder: tempDir("norepo") }));
    expect(snap.workspaces[0].branch).toBeUndefined();
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "3f9a0c21d7e4b5a6c7d8e9f0a1b2c3d4e5f6a7b8\n");
    expect(client.applySnapshot(topologyOf(PANES, { folder: dir })).workspaces[0].branch).toBeUndefined();
  });
});
