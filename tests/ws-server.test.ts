import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigManager } from "../src/server/config-manager";
import { HerdrClient } from "../src/server/herdr-client";
import { PushManager } from "../src/server/push";
import { SkillScanner } from "../src/server/skill-scanner";
import { WsServer } from "../src/server/ws-server";
import { ProtocolErrors } from "../src/types/protocol";
import { FakeHerdr, fakeWs, snapshotOf, tempDir } from "./helpers/fixtures";

// protocol.md: §3 handshake, §4 client commands, §6 configuration sync, §7 error codes.
const PROMPT = "Do you want to proceed?\n1. Yes\n2. No\n";
let herdr: FakeHerdr;
let client: HerdrClient;
let config: ConfigManager;
let server: WsServer;

beforeEach(async () => {
  const dir = tempDir("ws");
  herdr = new FakeHerdr(join(dir, "herdr.sock"));
  await herdr.listen();
  herdr.handlers["pane.read"] = () => ({ result: { read: { text: "$ ls\n" } } });
  client = new HerdrClient({ socketPath: herdr.socketPath, debounceMs: 5, panePollMs: 60_000 });
  client.applySnapshot(snapshotOf([{ paneId: "p1", agent: "claude", cwd: dir }, { paneId: "p2", agent: "codex", cwd: dir }]));
  config = new ConfigManager(join(dir, "config.json"), { HOME: dir });
  server = new WsServer({
    herdrClient: client,
    pushManager: new PushManager(join(dir, "vapid.json")),
    configManager: config,
    skillScanner: new SkillScanner(dir),
  });
});

afterEach(async () => {
  server.destroy();
  client.disconnect();
  await herdr.close();
});

const send = (ws: any, msg: object) => server.handleMessage(ws, JSON.stringify(msg));
const lastError = (sent: any[]) => sent.filter((m) => m.type === "error").at(-1)?.error.code;

describe("handshake (protocol.md §3)", () => {
  test("hello is answered with welcome, health, topology, then the pane's turns, skills and state", async () => {
    const c = fakeWs();
    server.handleOpen(c.ws);
    await send(c.ws, { type: "hello", id: "h1", payload: { protocolVersion: "1.0.0", subscribePaneId: "p1" } });
    const types = c.sent.map((m) => m.type);
    expect(types.slice(0, 3)).toEqual(["welcome", "upstream_status", "snapshot_update"]);
    // Health may be re-broadcast once the pane read reaches Herdr; the pane data comes exactly once each.
    expect(types.slice(3).filter((t) => t !== "upstream_status")).toEqual(["normalized_turns", "skills_sync", "pane_state"]);
    expect(c.ofType("normalized_turns")[0].payload).toMatchObject({ paneId: "p1", turns: [] });
    expect(c.ofType("pane_state")[0].payload.paneId).toBe("p1");
  });

  test("a different protocol major version is refused and the socket closed with 4409", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "hello", id: "h1", payload: { protocolVersion: "2.0.0" } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INCOMPATIBLE_PROTOCOL);
    expect(c.closes[0].code).toBe(4409);
  });

  test("the union of every client's pane is monitored", async () => {
    const a = fakeWs("d1");
    const b = fakeWs("d2");
    server.handleOpen(a.ws);
    server.handleOpen(b.ws);
    await send(a.ws, { type: "select_view", id: "s1", payload: { paneId: "p1" } });
    await send(b.ws, { type: "select_view", id: "s2", payload: { paneId: "p2" } });
    expect(client.getMonitoredPaneIds().sort()).toEqual(["p1", "p2"]);
    server.handleClose(a.ws);
    expect(client.getMonitoredPaneIds()).toEqual(["p2"]);
  });
});

describe("input validation (protocol.md §7, architecture.md §5)", () => {
  test("unknown message types are rejected with ERR_INVALID_PAYLOAD", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "nope", id: "x1" });
    expect(c.sent[0]).toMatchObject({ type: "error", replyTo: "x1", error: { code: ProtocolErrors.ERR_INVALID_PAYLOAD } });
  });

  test("key names outside the allowed pattern are rejected", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "agent_send_keys", id: "k1", payload: { targetPaneId: "p1", keys: ["\u001b[A"] } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
    expect(herdr.callsOf("pane.send_keys")).toHaveLength(0);
  });

  test("commands for an unknown pane get ERR_NOT_FOUND", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "nope", text: "hi" } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_NOT_FOUND);
  });

  test("Herdr's agent_blocked becomes ERR_AGENT_BLOCKED", async () => {
    herdr.handlers["agent.prompt"] = () => ({ error: { code: "agent_blocked", message: "blocked" } });
    const c = fakeWs();
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "hi" } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_AGENT_BLOCKED);
  });

  test("a model the recipe does not offer is rejected before anything is created", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "create_tab_and_agent", id: "c1", payload: { workspaceId: "w1", agentKind: "claude", modelId: "gpt-x" } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
    expect(herdr.callsOf("tab.create")).toHaveLength(0);
  });
});

describe("answering prompts (protocol.md §4.1)", () => {
  const pendingOf = () => client.applyScreen("p1", PROMPT).pendingInteraction!;

  test("a chosen option sends only its digit and acks approval once the prompt is gone", async () => {
    const pending = pendingOf();
    const c = fakeWs();
    await send(c.ws, { type: "interaction_respond", id: "r1", payload: { targetPaneId: "p1", interactionId: pending.interactionId, fingerprint: pending.fingerprint, optionId: "opt_2" } });
    expect(herdr.callsOf("pane.send_keys").map((x) => x.params.keys)).toEqual([["2"]]);
    expect(c.ofType("ack")[0].payload).toMatchObject({ approved: true, interactionId: pending.interactionId });
  });

  test("a prompt still on screen afterwards is acked as not approved", async () => {
    const pending = pendingOf();
    herdr.handlers["pane.read"] = () => ({ result: { read: { text: PROMPT } } });
    const c = fakeWs();
    await send(c.ws, { type: "interaction_respond", id: "r1", payload: { targetPaneId: "p1", interactionId: pending.interactionId, fingerprint: pending.fingerprint, optionId: "opt_1" } });
    expect(c.ofType("ack")[0].payload.approved).toBe(false);
  });

  test("selecting a pane that was already read sends its state once", async () => {
    client.applyScreen("p1", "$ ls\n"); // same screen the fake Herdr returns
    const c = fakeWs();
    server.handleOpen(c.ws);
    await send(c.ws, { type: "select_view", id: "s1", payload: { paneId: "p1" } });
    expect(c.ofType("pane_state")).toHaveLength(1);
  });

  test("a stale fingerprint is rejected with ERR_INTERACTION_STALE and no key is sent", async () => {
    const pending = pendingOf();
    const c = fakeWs();
    await send(c.ws, { type: "interaction_respond", id: "r1", payload: { targetPaneId: "p1", interactionId: pending.interactionId, fingerprint: "fp_old", optionId: "opt_1" } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INTERACTION_STALE);
    expect(herdr.callsOf("pane.send_keys")).toHaveLength(0);
  });

  test("an unknown option is rejected with ERR_INVALID_PAYLOAD", async () => {
    const pending = pendingOf();
    const c = fakeWs();
    await send(c.ws, { type: "interaction_respond", id: "r1", payload: { targetPaneId: "p1", interactionId: pending.interactionId, fingerprint: pending.fingerprint, optionId: "opt_9" } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
  });
});

describe("configuration sync (protocol.md §6)", () => {
  test("a patch is saved, acked with a new version and broadcast to the other clients only", async () => {
    const a = fakeWs("d1");
    const b = fakeWs("d2");
    server.handleOpen(a.ws);
    server.handleOpen(b.ws);
    await send(a.ws, { type: "config_patch", id: "p1", payload: { client: { themeKey: "nord" } } });
    const ack = a.ofType("ack")[0];
    expect(ack.payload.client.themeKey).toBe("nord");
    expect(a.ofType("config_updated")).toHaveLength(0);
    expect(b.ofType("config_updated")[0].payload).toMatchObject({ version: ack.payload.version, client: { themeKey: "nord" } });
    expect(config.getClientConfig().themeKey).toBe("nord");
  });

  test("a patch with an unknown key is rejected and nothing is saved", async () => {
    const before = JSON.stringify(config.getClientConfig());
    const c = fakeWs();
    await send(c.ws, { type: "config_patch", id: "p1", payload: { client: { evil: true } } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
    expect(JSON.stringify(config.getClientConfig())).toBe(before);
  });

  test("a key macro with an invalid key name is rejected", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "config_patch", id: "p1", payload: { client: { macros: [{ id: "m", name: "x", type: "key", payload: "rm -rf" }] } } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
  });
});

describe("device revocation (security-and-pairing.md §5)", () => {
  test("revoking a device closes its connections with 4403", () => {
    const c = fakeWs("dev_gone");
    server.handleOpen(c.ws);
    server.closeDevice("dev_gone");
    expect(c.closes[0].code).toBe(4403);
    expect(server.getConnectedClientsCount()).toBe(0);
  });
});
