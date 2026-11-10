import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { sendAdminCommand } from "../src/cli/index";
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
// §4.12 (devices), §4.13 (queue cancel), §4.14 (queue update), §5.3 (snapshot fields), §5.8 (prompt_queue).
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
  // The App reports the folder a space was started in; the panes have moved into the project (herdr-adapter.md §3.1).
  herdr.serve(PANES.map((p) => ({ ...p, cwd: dir })), { folder: "/start" });
  await herdr.listen();
  herdr.handlers["terminal.read"] = () => ({ result: { text: "$ ls\n", how: "history" } });
  client = new HerdrClient({ appSocketPath: herdr.appSocketPath, coreSocketPath: herdr.coreSocketPath, debounceMs: 5, panePollMs: 60_000 });
  client.applySnapshot(topologyOf(PANES.map((p) => ({ ...p, cwd: dir })), { folder: "/start" }));
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
    queueFilePath: join(dir, "queue.json"),
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

    server.paneStore.registerPaneSession("p1", "claude", "ses_test");
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    expect(herdr.callsOf("terminal.send")[0].params).toEqual({ terminal: "p1", text: "also run lint" });
    expect(c.ofType("prompt_queue").at(-1).payload.items[0]).toMatchObject({ text: "also run lint", sending: true });

    server.paneStore.emit("turns_delta", {
      paneId: "p1",
      seqWatermark: 1,
      sinceTurnIndex: 1,
      appendTurns: [{ turnId: "t1", turnNumber: 1, timestamp: Date.now(), userPrompt: { text: "also run lint" } }],
    });
    await until(() => c.ofType("prompt_queue").at(-1).payload.items.length === 0);
  });

  test("an unbound pane clears sending prompt immediately after send without waiting for transcript", async () => {
    await client.connect();
    // p1 has no session registered in paneStore (unbound)
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "unbound prompt" } });
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    expect(herdr.callsOf("terminal.send")[0].params).toEqual({ terminal: "p1", text: "unbound prompt" });
    // Immediately cleared because pane is unbound
    await until(() => c.ofType("prompt_queue").at(-1).payload.items.length === 0);
  });

  test("a sending prompt on a bound pane is cleared when turns_delta has userPrompt, and next prompt flushes", async () => {
    await client.connect();
    server.paneStore.registerPaneSession("p1", "claude", "ses_main");
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "first prompt" } });
    await send(c.ws, { type: "agent_prompt", id: "a2", payload: { targetPaneId: "p1", text: "second prompt" } });

    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    expect(herdr.callsOf("terminal.send")[0].params.text).toBe("first prompt");
    expect(c.ofType("prompt_queue").at(-1).payload.items[0]).toMatchObject({ text: "first prompt", sending: true });

    // Emit turns_delta with a new user turn
    server.paneStore.emit("turns_delta", {
      paneId: "p1",
      seqWatermark: 1,
      sinceTurnIndex: 1,
      appendTurns: [{ turnId: "t1", turnNumber: 1, timestamp: Date.now(), userPrompt: { text: "first prompt" } }],
    });

    // First prompt is gone, second prompt is still waiting
    await until(() => c.ofType("prompt_queue").at(-1).payload.items.length === 1);
    expect(c.ofType("prompt_queue").at(-1).payload.items[0]).toMatchObject({ text: "second prompt" });
    expect(c.ofType("prompt_queue").at(-1).payload.items[0].sending).toBeFalsy();

    // Agent finishes and becomes idle; second prompt becomes sending
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 2);
    expect(herdr.callsOf("terminal.send")[1].params.text).toBe("second prompt");
    expect(c.ofType("prompt_queue").at(-1).payload.items[0]).toMatchObject({ text: "second prompt", sending: true });
  });

  test("the first prompt of a fresh session (turnIndex 0) clears sending state on turns_delta", async () => {
    await client.connect();
    server.paneStore.registerPaneSession("p1", "claude", "ses_fresh_0");
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "fresh turn 0" } });
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    expect(c.ofType("prompt_queue").at(-1).payload.items[0]).toMatchObject({ text: "fresh turn 0", sending: true });

    // When the first turn arrives, sinceTurnIndex is 0
    server.paneStore.emit("turns_delta", {
      paneId: "p1",
      seqWatermark: 1,
      sinceTurnIndex: 0,
      appendTurns: [{ turnId: "t0", turnNumber: 0, timestamp: Date.now(), userPrompt: { text: "fresh turn 0" } }],
    });

    // The sending prompt should be cleared
    await until(() => c.ofType("prompt_queue").at(-1).payload.items.length === 0);
  });

  test("queued prompts go out one per idle, oldest first", async () => {
    await client.connect();
    server.paneStore.registerPaneSession("p1", "claude", "ses_order");
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "one" } });
    await send(c.ws, { type: "agent_prompt", id: "a2", payload: { targetPaneId: "p1", text: "two" } });
    herdr.emitEvent("status", "p1", { status: { state: "done", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    await Bun.sleep(50);
    expect(herdr.callsOf("terminal.send").map((x) => x.params.text)).toEqual(["one"]);

    server.paneStore.emit("turns_delta", {
      paneId: "p1",
      seqWatermark: 1,
      sinceTurnIndex: 1,
      appendTurns: [{ turnId: "t1", turnNumber: 1, timestamp: Date.now(), userPrompt: { text: "one" } }],
    });
    await until(() => c.ofType("prompt_queue").at(-1).payload.items.length === 1);
    expect(herdr.callsOf("terminal.send").length).toBe(1);
    expect(c.ofType("prompt_queue").at(-1).payload.items[0]).toMatchObject({ text: "two" });
    expect(c.ofType("prompt_queue").at(-1).payload.items[0].sending).toBeFalsy();

    herdr.emitEvent("status", "p1", { status: { state: "working", app: "claude-code" } });
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 2);
    expect(herdr.callsOf("terminal.send")[1].params.text).toBe("two");
  });

  test("queued prompts on unbound pane wait for next idle after working", async () => {
    await client.connect();
    // Do NOT register session -> unbound pane
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "u1", payload: { targetPaneId: "p1", text: "first unbound" } });
    await send(c.ws, { type: "agent_prompt", id: "u2", payload: { targetPaneId: "p1", text: "second unbound" } });
    herdr.emitEvent("status", "p1", { status: { state: "idle" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    await Bun.sleep(50);
    expect(herdr.callsOf("terminal.send").map((x) => x.params.text)).toEqual(["first unbound"]);

    // For unbound pane, prompt 1 cleared immediately after send, but prompt 2 waits for next idle
    await until(() => c.ofType("prompt_queue").at(-1).payload.items.length === 1);
    expect(herdr.callsOf("terminal.send").length).toBe(1);
    expect(c.ofType("prompt_queue").at(-1).payload.items[0]).toMatchObject({ text: "second unbound" });
    expect(c.ofType("prompt_queue").at(-1).payload.items[0].sending).toBeFalsy();

    herdr.emitEvent("status", "p1", { status: { state: "working" } });
    herdr.emitEvent("status", "p1", { status: { state: "idle" } });
    await until(() => herdr.callsOf("terminal.send").length === 2);
    expect(herdr.callsOf("terminal.send")[1].params.text).toBe("second unbound");
  });

  test("subsequent snapshot_updated events do not dispatch next queued prompt before working state (review B1)", async () => {
    await client.connect();
    server.paneStore.registerPaneSession("p1", "claude", "ses_multi");
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "first prompt" } });
    await send(c.ws, { type: "agent_prompt", id: "a2", payload: { targetPaneId: "p1", text: "second prompt" } });

    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    expect(herdr.callsOf("terminal.send")[0].params.text).toBe("first prompt");

    client.applySnapshot(topologyOf(PANES.map((p) => ({ ...p, cwd: dir, ...(p.paneId === "p1" ? { state: "idle" } : {}) })), { folder: "/start" }));
    client.applySnapshot(topologyOf(PANES.map((p) => ({ ...p, cwd: dir, ...(p.paneId === "p1" ? { state: "idle" } : {}) })), { folder: "/start" }));
    await Bun.sleep(50);

    expect(herdr.callsOf("terminal.send").length).toBe(1);
    expect(c.ofType("prompt_queue").at(-1).payload.items).toHaveLength(2);
  });

  test("the agent finished during sending, then clearSendingPrompt flushes the next prompt", async () => {
    await client.connect();
    server.paneStore.registerPaneSession("p1", "claude", "ses_fast");
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "f1", payload: { targetPaneId: "p1", text: "fast one" } });
    await send(c.ws, { type: "agent_prompt", id: "f2", payload: { targetPaneId: "p1", text: "fast two" } });
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    expect(herdr.callsOf("terminal.send")[0].params.text).toBe("fast one");

    // Agent quickly starts and finishes while entry is still marked sending
    herdr.emitEvent("status", "p1", { status: { state: "working", app: "claude-code" } });
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });

    // Turns delta arrives after the agent already became idle; clearSendingPrompt should flush next prompt
    server.paneStore.emit("turns_delta", {
      paneId: "p1",
      seqWatermark: 1,
      sinceTurnIndex: 1,
      appendTurns: [{ turnId: "t1", turnNumber: 1, timestamp: Date.now(), userPrompt: { text: "fast one" } }],
    });

    await until(() => herdr.callsOf("terminal.send").length === 2);
    expect(herdr.callsOf("terminal.send")[1].params.text).toBe("fast two");
  });

  test("a prompt in sending state returns ERR_NOT_FOUND on queue_cancel and queue_update", async () => {
    await client.connect();
    server.paneStore.registerPaneSession("p1", "claude", "ses_guard");
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "cannot cancel" } });
    const queueId = lastAck(c).queueId;

    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    expect(c.ofType("prompt_queue").at(-1).payload.items[0]).toMatchObject({ queueId, sending: true });

    // Cancel on sending item responds with ERR_NOT_FOUND
    await send(c.ws, { type: "queue_cancel", id: "qc1", payload: { targetPaneId: "p1", queueId } });
    expect(lastError(c)).toBe("ERR_NOT_FOUND");

    // Update on sending item responds with ERR_NOT_FOUND
    await send(c.ws, { type: "queue_update", id: "qu1", payload: { targetPaneId: "p1", queueId, text: "edited" } });
    expect(lastError(c)).toBe("ERR_NOT_FOUND");
  });

  test("a sending prompt is removed after timeout when no user turn appears", async () => {
    await client.connect();
    server.paneStore.registerPaneSession("p1", "claude", "ses_timeout");
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "times out" } });
    const queueId = lastAck(c).queueId;

    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    expect(c.ofType("prompt_queue").at(-1).payload.items[0]).toMatchObject({ queueId, sending: true });

    // Trigger clearSendingPrompt directly as simulation of timeout
    (server as any).clearSendingPrompt("p1", queueId);
    await until(() => c.ofType("prompt_queue").at(-1).payload.items.length === 0);
  });

  test("a prompt to an idle agent is sent at once", async () => {
    const c = await viewer("p2");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p2", text: "hi" } });
    expect(lastAck(c)).toMatchObject({ queued: false });
    expect(herdr.callsOf("terminal.send")[0].params).toEqual({ terminal: "p2", text: "hi" });
  });

  test("a prompt sent while a queued one is still going out joins the queue", async () => {
    await client.connect();
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "one" } });
    herdr.handlers["terminal.send"] = () => "no-reply"; // the paste is still in progress
    herdr.serve(PANES.map((p) => ({ ...p, cwd: dir, ...(p.paneId === "p1" ? { state: "idle" } : {}) })), { folder: "/start" });
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    await until(() => client.getPaneHerdrStatus("p1") === "idle");
    await send(c.ws, { type: "agent_prompt", id: "a2", payload: { targetPaneId: "p1", text: "two" } });
    expect(lastAck(c)).toMatchObject({ queued: true });
    expect(herdr.callsOf("terminal.send").map((x) => x.params.text)).toEqual(["one"]);
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

  test("a queued prompt can be updated in-place, preserving queue order and index", async () => {
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "one" } });
    const q1 = lastAck(c).queueId;
    await send(c.ws, { type: "agent_prompt", id: "a2", payload: { targetPaneId: "p1", text: "two" } });
    const q2 = lastAck(c).queueId;
    await send(c.ws, { type: "agent_prompt", id: "a3", payload: { targetPaneId: "p1", text: "three" } });
    const q3 = lastAck(c).queueId;

    expect(c.ofType("prompt_queue").at(-1).payload.items.map((i: any) => i.text)).toEqual(["one", "two", "three"]);

    // Update the middle prompt #2
    await send(c.ws, { type: "queue_update", id: "u1", payload: { targetPaneId: "p1", queueId: q2, text: "two edited" } });
    expect(lastAck(c)).toMatchObject({ status: "ok", updated: true });
    expect(c.ofType("prompt_queue").at(-1).payload.items.map((i: any) => i.text)).toEqual(["one", "two edited", "three"]);
    expect(c.ofType("prompt_queue").at(-1).payload.items[1].queueId).toBe(q2);

    // Updating a nonexistent queueId is ERR_NOT_FOUND
    await send(c.ws, { type: "queue_update", id: "u2", payload: { targetPaneId: "p1", queueId: "no-such-id", text: "x" } });
    expect(lastError(c)).toBe("ERR_NOT_FOUND");
  });

  test("queued prompts are persisted to disk and reloaded on server restart", async () => {
    const queueFile = join(dir, "queue.json");
    const c1 = await viewer("p1");
    await send(c1.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "persistent prompt" } });
    expect(lastAck(c1)).toMatchObject({ queued: true });
    expect(existsSync(queueFile)).toBe(true);

    const newServer = new WsServer({
      buildId: "b",
      herdrClient: client,
      pushManager: new PushManager(join(dir, "vapid.json")),
      configManager: new ConfigManager(join(dir, "config.json"), { HOME: dir }),
      skillScanner: new SkillScanner(dir),
      uploadStore: uploads,
      pairingManager: pairing,
      queueFilePath: queueFile,
    });
    const clientQueue = (newServer as any).queues.get("p1");
    expect(clientQueue).toHaveLength(1);
    expect(clientQueue[0].item.text).toBe("persistent prompt");
    newServer.destroy();
  });

  test("a prompt in sending state is not restored on daemon restart and never sent twice", async () => {
    await client.connect();
    server.paneStore.registerPaneSession("p1", "claude", "ses_b1");
    const c1 = await viewer("p1");
    await send(c1.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "dispatched" } });
    await send(c1.ws, { type: "agent_prompt", id: "a2", payload: { targetPaneId: "p1", text: "waiting" } });

    // Send first prompt, enters sending state
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    expect(c1.ofType("prompt_queue").at(-1).payload.items[0]).toMatchObject({ text: "dispatched", sending: true });

    // Restart server using the saved queue file
    const newServer = new WsServer({
      buildId: "b",
      herdrClient: client,
      pushManager: new PushManager(join(dir, "vapid2.json")),
      configManager: new ConfigManager(join(dir, "config2.json"), { HOME: dir }),
      skillScanner: new SkillScanner(dir),
      uploadStore: uploads,
      pairingManager: pairing,
      queueFilePath: (server as any).queueFilePath,
    });
    const restoredQueue = (newServer as any).queues.get("p1");
    // "dispatched" (sending: true) is NOT restored; only "waiting" remains
    expect(restoredQueue).toHaveLength(1);
    expect(restoredQueue[0].item.text).toBe("waiting");
    newServer.destroy();
  });
});

describe("attachments (protocol.md §4.2, §7)", () => {
  test("uploaded files are appended as paths with the agent's mention prefix", async () => {
    const shot = uploads.save({ name: "shot.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    const c = await viewer("p2");
    // codex has no mention prefix; claude (queued, p1) would use "@".
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p2", text: "look", attachments: [shot.id] } });
    expect(herdr.callsOf("terminal.send")[0].params.text).toBe(`look\n\n${shot.path}`);

    // A queued prompt shows what the phone sent (protocol.md §5.8) and sends the composed text.
    await client.connect();
    const c1 = await viewer("p1");
    await send(c1.ws, { type: "agent_prompt", id: "a2", payload: { targetPaneId: "p1", text: "", attachments: [shot.id] } });
    expect(c1.ofType("prompt_queue").at(-1).payload.items[0]).toMatchObject({ text: "", attachments: [shot.id] });
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 2);
    expect(herdr.callsOf("terminal.send")[1].params.text).toBe(`@${shot.path}`);
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

  test("the first message is the tab's task; the tab is created without a name (protocol.md §4, herdr-adapter.md §5)", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "create_tab_and_agent", id: "n1", payload: { workspaceId: "w1", agentKind: "claude", firstMessage: "Fix the flaky test\nmore detail" } });
    expect(created()).toMatchObject({ space: "w1", folder: dir, task: "Fix the flaky test\nmore detail", argv: ["claude"] });
    expect(created().name).toBeUndefined();
  });

  test("AGY and OpenCode pass the first message with their own prompt flags in argv instead of Herdr's positional task", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "create_tab_and_agent", id: "n1", payload: { workspaceId: "w1", agentKind: "agy", firstMessage: "Review PR #4" } });
    expect(created()).toEqual({ space: "w1", folder: dir, argv: ["agy", "-i", "Review PR #4"] });
    await send(c.ws, { type: "create_tab_and_agent", id: "n2", payload: { workspaceId: "w1", agentKind: "opencode", firstMessage: "Fix the bug" } });
    expect(created()).toEqual({ space: "w1", folder: dir, argv: ["opencode", "--prompt", "Fix the bug"] });
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

  test("closing an unknown tab is ERR_NOT_FOUND and nothing is sent to Herdr (protocol.md §8)", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "close_tab", id: "c1", payload: { tabId: "nope" } });
    expect(lastError(c)).toBe("ERR_NOT_FOUND");
    expect(herdr.callsOf("tab.close")).toHaveLength(0);
  });

  test("claude switches model with its own /model command; a model the agent does not list is refused (protocol.md §4.9)", async () => {
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

  test("revoking this device acks first, then closes this connection (protocol.md §4.12)", async () => {
    const { token } = pairing.createPairingToken();
    const mine = pairing.exchangeToken(token, "Phone").deviceId!;
    const c = fakeWs(mine);
    const order: string[] = [];
    const { send: rawSend, close: rawClose } = c.ws;
    c.ws.send = (text: string) => (order.push(JSON.parse(text).type), rawSend(text));
    c.ws.close = (code?: number, reason?: string) => (order.push(`close ${code}`), rawClose(code, reason));
    server.handleOpen(c.ws);
    await send(c.ws, { type: "device_revoke", id: "d1", payload: { deviceId: mine } });
    expect(order).toEqual(["ack", "close 4403"]);
  });

  test("a device revoked on the computer (pigeon devices revoke) is cut off at once (security-and-pairing.md §5)", () => {
    const { token } = pairing.createPairingToken();
    const id = pairing.exchangeToken(token, "Phone").deviceId!;
    const c = fakeWs(id);
    server.handleOpen(c.ws);
    pairing.revokeDevice(id);
    expect(c.closes.map((x) => x.code)).toEqual([4403]);
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
    const snap = client.applySnapshot(topologyOf(PANES.map((p) => ({ ...p, cwd: dir })), { folder: "/start" }));
    const ws = snap.workspaces[0];
    expect([ws.folder, ws.branch, ws.tabs[0].branch]).toEqual([dir, "feat/1-ui", "feat/1-ui"]);
    expect(ws.tabs[0].panes.map((p) => p.program)).toEqual(["claude", "codex", "zsh"]);
  });

  test("a detached HEAD or no repository gives no branch", () => {
    const snap = client.applySnapshot(topologyOf(PANES.map((p) => ({ ...p, cwd: tempDir("norepo") }))));
    expect(snap.workspaces[0].branch).toBeUndefined();
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "3f9a0c21d7e4b5a6c7d8e9f0a1b2c3d4e5f6a7b8\n");
    expect(client.applySnapshot(topologyOf(PANES.map((p) => ({ ...p, cwd: dir })))).workspaces[0].branch).toBeUndefined();
  });

  test("a space without a live terminal falls back to the App's folder", () => {
    const snap = client.applySnapshot(topologyOf([], { folder: "/start" }));
    expect(snap.workspaces[0].folder).toBe("/start");
  });
});

describe("seen panes (herdr-adapter.md §4, protocol.md §5.3, issue #3)", () => {
  const statusOf = (c: ReturnType<typeof fakeWs>, paneId: string) =>
    c.ofType("snapshot_update").at(-1)?.payload.workspaces.flatMap((w: any) => w.tabs.flatMap((t: any) => t.panes)).find((p: any) => p.id === paneId)?.agentStatus;
  /** The Core reports the new state both in its terminal list and as a status event. */
  const setStatus = (paneId: string, state: string, app = "codex") => {
    herdr.serve(PANES.map((p) => ({ ...p, cwd: dir, ...(p.paneId === paneId ? { state } : {}) })), { folder: "/start" });
    herdr.emitEvent("status", paneId, { status: { state, app } });
  };

  test("a done pane viewed by a visible client is idle for every client until its status changes", async () => {
    await client.connect();
    const connect = async (deviceId: string, paneId: string) => {
      const c = fakeWs(deviceId);
      server.handleOpen(c.ws);
      await send(c.ws, { type: "hello", id: "h", payload: { protocolVersion: "1.0.0", subscribePaneId: paneId } });
      return c;
    };
    const looker = await connect("dev_looker", "p2");
    const other = await connect("dev_other", "p1");
    setStatus("p2", "done");
    await until(() => statusOf(other, "p2") === "done");

    await send(looker.ws, { type: "presence_update", isVisible: true, viewingPaneId: "p2" });
    await until(() => statusOf(other, "p2") === "idle");
    expect(statusOf(looker, "p2")).toBe("idle");

    await send(looker.ws, { type: "presence_update", isVisible: false, viewingPaneId: "p2" });
    setStatus("p2", "working");
    await until(() => statusOf(other, "p2") === "working");
    setStatus("p2", "done");
    await until(() => statusOf(other, "p2") === "done");
  });

  test("sendAdminCommand respects timeoutMs parameter and times out if daemon takes longer", async () => {
    const sockPath = join(dir, "admin-timeout-test.sock");
    let replyTimer: any;
    const srv = createServer((sock) => {
      sock.on("error", () => {});
      // Intentionally delay replying beyond timeoutMs
      replyTimer = setTimeout(() => {
        try {
          sock.write(JSON.stringify({ result: { ok: true } }) + "\n");
        } catch {}
      }, 80);
    });
    await new Promise<void>((r) => srv.listen(sockPath, r));
    try {
      await expect(sendAdminCommand(sockPath, "usage.rebuild", {}, 20)).rejects.toThrow("within 0.02s");
    } finally {
      clearTimeout(replyTimer);
      srv.close();
    }
  });

  test("sendAdminCommand succeeds when extended timeoutMs is provided (architecture.md §4.6)", async () => {
    const sockPath = join(dir, "admin-extended-timeout.sock");
    let replyTimer: any;
    const srv = createServer((sock) => {
      sock.on("error", () => {});
      // Takes 30ms to reply
      replyTimer = setTimeout(() => {
        try {
          sock.write(JSON.stringify({ result: { scannedFiles: 12, recordsAdded: 34 } }) + "\n");
        } catch {}
      }, 30);
    });
    await new Promise<void>((r) => srv.listen(sockPath, r));
    try {
      const res = await sendAdminCommand(sockPath, "usage.rebuild", {}, 500);
      expect(res).toEqual({ scannedFiles: 12, recordsAdded: 34 });
    } finally {
      clearTimeout(replyTimer);
      srv.close();
    }
  });
});

// Issue #19 acceptance: protocol.md §4.2 (queue state machine, restore), §4.14 (queue_update validation).
describe("queue state machine (protocol.md §4.2, §4.14)", () => {
  const T0 = Date.parse("2026-11-11T08:00:00Z");
  const serverWith = (extra: Partial<ConstructorParameters<typeof WsServer>[0]>) =>
    new WsServer({
      buildId: "b",
      herdrClient: client,
      pushManager: new PushManager(join(dir, "vapid.json")),
      configManager: new ConfigManager(join(dir, "config.json"), { HOME: dir }),
      skillScanner: new SkillScanner(dir),
      agentAdapters: new AgentAdapterManager({ home: dir }),
      uploadStore: uploads,
      pairingManager: pairing,
      queueFilePath: join(dir, "queue.json"),
      ...extra,
    });
  const p1At = (createdMs: number, state: string) =>
    topologyOf(PANES.map((p) => ({ ...p, cwd: dir, ...(p.paneId === "p1" ? { state, createdMs } : {}) })), { folder: "/start" });

  test("a head prompt that never starts work settles at the timeout and the next one goes out (B1)", async () => {
    server.destroy();
    server = serverWith({ queueSendTimeoutMs: 100 });
    await client.connect();
    server.paneStore.registerPaneSession("p1", "claude", "ses_stall");
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "/model sonnet" } });
    await send(c.ws, { type: "agent_prompt", id: "a2", payload: { targetPaneId: "p1", text: "next prompt" } });
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" } });
    await until(() => herdr.callsOf("terminal.send").length === 1);
    // The slash command neither makes the pane work nor adds a user turn; the pane stays idle.
    await until(() => herdr.callsOf("terminal.send").length === 2);
    expect(herdr.callsOf("terminal.send").map((x) => x.params.text)).toEqual(["/model sonnet", "next prompt"]);
  });

  test("an idle seen only through a snapshot sends the queued prompt (B2)", async () => {
    await client.connect();
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "s1", payload: { targetPaneId: "p1", text: "after reconnect" } });
    expect(lastAck(c)).toMatchObject({ queued: true });
    // No status event: the subscription missed it, and only the reconciliation snapshot shows idle.
    client.applySnapshot(p1At(T0, "idle"));
    await until(() => herdr.callsOf("terminal.send").length === 1);
    expect(herdr.callsOf("terminal.send")[0].params.text).toBe("after reconnect");
  });

  test("a restored prompt goes out only to the same terminal (B3)", async () => {
    client.applySnapshot(p1At(T0, "working"));
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "r1", payload: { targetPaneId: "p1", text: "restore me" } });
    expect(lastAck(c)).toMatchObject({ queued: true });
    const saved = readFileSync(join(dir, "queue.json"), "utf8");
    // A daemon restart: a new Herdr client and a new server reading the saved queue.
    const restart = () => {
      server.destroy();
      client.disconnect();
      client = new HerdrClient({ appSocketPath: herdr.appSocketPath, coreSocketPath: herdr.coreSocketPath, debounceMs: 5, panePollMs: 60_000 });
      server = serverWith({});
    };
    const sends = () => herdr.callsOf("terminal.send").filter((x) => x.params.text === "restore me").length;

    // The same terminal: the prompt goes out once the pane is idle.
    restart();
    client.applySnapshot(p1At(T0, "idle"));
    await until(() => sends() === 1);

    // Herdr reused the address for a new terminal: the prompt is dropped, not sent.
    writeFileSync(join(dir, "queue.json"), saved);
    restart();
    client.applySnapshot(p1At(T0 + 60_000, "idle"));
    await Bun.sleep(150);
    expect(sends()).toBe(1);
  });

  test("queue_update is validated like agent_prompt (B16)", async () => {
    await client.connect();
    const c = await viewer("p1");
    await send(c.ws, { type: "agent_prompt", id: "v1", payload: { targetPaneId: "p1", text: "queued" } });
    const queueId = lastAck(c).queueId;
    const eleven = Array.from({ length: 11 }, (_, i) => `up_${i.toString(16).padStart(16, "0")}`);
    await send(c.ws, { type: "queue_update", id: "v2", payload: { targetPaneId: "p1", queueId, text: "x", attachments: eleven } });
    await send(c.ws, { type: "queue_update", id: "v3", payload: { targetPaneId: "p1", queueId, text: "", attachments: [] } });
    expect(c.ofType("error").map((m: any) => m.error.code)).toEqual(["ERR_INVALID_PAYLOAD", "ERR_INVALID_PAYLOAD"]);
    expect(c.ofType("prompt_queue").at(-1).payload.items[0].text).toBe("queued");
  });
});
