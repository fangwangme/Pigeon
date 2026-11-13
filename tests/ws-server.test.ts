import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigManager } from "../src/server/config-manager";
import { HerdrClient } from "../src/server/herdr-client";
import { ModelCatalog } from "../src/server/model-catalog";
import { PushManager } from "../src/server/push";
import { SkillScanner } from "../src/server/skill-scanner";
import { WsServer } from "../src/server/ws-server";
import { ProtocolErrors, hashTurn, fnv1a32, type NormalizedTurn, toLightTurn } from "../src/types/protocol";
import { FakeHerdr, fakeWs, tempDir, topologyOf } from "./helpers/fixtures";

// protocol.md: §3 handshake, §4 client commands, §6 configuration sync, §7 error codes.
const PROMPT = "Do you want to proceed?\n1. Yes\n2. No\n";
let herdr: FakeHerdr;
let client: HerdrClient;
let config: ConfigManager;
let server: WsServer;

beforeEach(async () => {
  const dir = tempDir("ws");
  herdr = new FakeHerdr(dir);
  await herdr.listen();
  herdr.handlers["terminal.read"] = () => ({ result: { text: "$ ls\n", complete: true, how: "history" } });
  client = new HerdrClient({ appSocketPath: herdr.appSocketPath, coreSocketPath: herdr.coreSocketPath, debounceMs: 5, panePollMs: 60_000 });
  client.applySnapshot(topologyOf([{ paneId: "p1", app: "claude-code", cwd: dir }, { paneId: "p2", app: "codex", cwd: dir }]));
  config = new ConfigManager(join(dir, "config.json"), { HOME: dir });
  server = new WsServer({
    buildId: "build_test",
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
  test("hello is answered with welcome, health, topology, then the pane's bootstrap", async () => {
    const c = fakeWs();
    server.handleOpen(c.ws);
    await send(c.ws, { type: "hello", id: "h1", payload: { protocolVersion: "1.0.0", subscribePaneId: "p1" } });
    const types = c.sent.map((m) => m.type);
    expect(types.slice(0, 3)).toEqual(["welcome", "upstream_status", "snapshot_update"]);
    expect(c.ofType("welcome")[0].payload.buildId).toBe("build_test");
    // Health may be re-broadcast once the pane read reaches Herdr; pane_bootstrap comes exactly once.
    expect(types.slice(3).filter((t) => t !== "upstream_status")).toEqual(["pane_bootstrap", "pane_state"]);
    const boot = c.ofType("pane_bootstrap")[0].payload;
    expect(boot.paneId).toBe("p1");
    expect(boot.turns).toMatchObject({ paneId: "p1", turns: [] });
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
    expect(herdr.callsOf("terminal.keys")).toHaveLength(0);
  });

  test("commands for an unknown pane get ERR_NOT_FOUND", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "nope", text: "hi" } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_NOT_FOUND);
  });

  test("Herdr Core's blocked becomes ERR_AGENT_BLOCKED", async () => {
    herdr.handlers["terminal.send"] = () => ({ error: "blocked" });
    const c = fakeWs();
    await send(c.ws, { type: "agent_prompt", id: "a1", payload: { targetPaneId: "p1", text: "hi" } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_AGENT_BLOCKED);
  });

  test("a model the recipe does not offer is rejected before anything is created", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "create_tab_and_agent", id: "c1", payload: { workspaceId: "w1", agentKind: "claude", modelId: "gpt-x" } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
    expect(herdr.callsOf("tab.new")).toHaveLength(0);
  });

  test("an agent that takes no model at launch says so, and a listed model for it is refused before anything is created (§4.5, §5.7)", async () => {
    const bin = tempDir("bin");
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\n[ \"$1\" = models ] && echo anthropic/claude-x\n");
    chmodSync(join(bin, "opencode"), 0o755);
    const catalog = new ModelCatalog({ home: tempDir("home"), env: { PATH: `${bin}:/usr/bin:/bin` } });
    await catalog.refresh();
    const own = new WsServer({ buildId: "b", herdrClient: client, pushManager: new PushManager(join(tempDir("push"), "vapid.json")), configManager: config, skillScanner: new SkillScanner(tempDir("skills")), modelCatalog: catalog });
    try {
      const c = fakeWs();
      own.handleOpen(c.ws);
      await own.handleMessage(c.ws, JSON.stringify({ type: "hello", id: "h", payload: { protocolVersion: "1.0.0" } }));
      const opencode = c.sent.find((m) => m.type === "welcome").payload.recipes.opencode;
      expect([opencode.models.map((m: any) => m.id), opencode.launchModel]).toEqual([["anthropic/claude-x"], false]);
      await own.handleMessage(c.ws, JSON.stringify({ type: "create_tab_and_agent", id: "c1", payload: { workspaceId: "w1", agentKind: "opencode", modelId: "anthropic/claude-x" } }));
      expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
      expect(herdr.callsOf("tab.new")).toHaveLength(0);
    } finally {
      own.destroy();
    }
  });
});

describe("answering prompts (protocol.md §4.1)", () => {
  const pendingOf = () => client.applyScreen("p1", PROMPT).pendingInteraction!;

  test("a chosen option sends only its digit and acks approval once the prompt is gone", async () => {
    const pending = pendingOf();
    const c = fakeWs();
    await send(c.ws, { type: "interaction_respond", id: "r1", payload: { targetPaneId: "p1", interactionId: pending.interactionId, fingerprint: pending.fingerprint, optionId: "opt_2" } });
    expect(herdr.callsOf("terminal.keys").map((x) => x.params.keys)).toEqual([["2"]]);
    expect(c.ofType("ack")[0].payload).toMatchObject({ approved: true, interactionId: pending.interactionId });
  });

  test("a multi-select question menu sends each pick's digit, then right (herdr-adapter.md §8.2)", async () => {
    const menu = "Pick toppings\n❯ 1. [ ] Cheese\n     Cheese topping\n  2. [ ] Ham\n  3. [ ] Olives\n  4. [ ] Type something\n     Submit\n  5. Chat about this\nEnter to select · ↑/↓ to navigate · Esc to cancel";
    const pending = client.applyScreen("p1", menu).pendingInteraction!;
    const c = fakeWs();
    await send(c.ws, { type: "interaction_respond", id: "r1", payload: { targetPaneId: "p1", interactionId: pending.interactionId, fingerprint: pending.fingerprint, optionIds: ["opt_1", "opt_3"] } });
    expect(herdr.callsOf("terminal.keys").map((x) => x.params.keys)).toEqual([["1", "3", "right"]]);
  });

  test("a question menu's own text goes in as a paste (herdr-adapter.md §8.2)", async () => {
    const menu = "Pick a size\n❯ 1. Small\n  2. Large\n  3. Type something.\nEnter to select · ↑/↓ to navigate · Esc to cancel";
    const pending = client.applyScreen("p1", menu).pendingInteraction!;
    expect(pending.allowsOther).toBe(true);
    const c = fakeWs();
    await send(c.ws, { type: "interaction_respond", id: "r1", payload: { targetPaneId: "p1", interactionId: pending.interactionId, fingerprint: pending.fingerprint, optionId: "opt_other", otherTexts: { "1": "Medium" } } });
    expect(herdr.callsOf("terminal.send").map((x) => x.params)).toEqual([{ terminal: "p1", text: "Medium", force: true }]);
    expect(herdr.callsOf("terminal.keys")).toHaveLength(0);
  });

  test("a prompt still on screen afterwards is acked as not approved", async () => {
    const pending = pendingOf();
    herdr.handlers["terminal.read"] = () => ({ result: { text: PROMPT, complete: true, how: "history" } });
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
    expect(herdr.callsOf("terminal.keys")).toHaveLength(0);
  });

  test("a second answer while the first is still being sent (double tap) is stale and sends no key", async () => {
    const pending = pendingOf();
    const c = fakeWs();
    const payload = { targetPaneId: "p1", interactionId: pending.interactionId, fingerprint: pending.fingerprint, optionId: "opt_1" };
    await Promise.all([
      send(c.ws, { type: "interaction_respond", id: "r1", payload }),
      send(c.ws, { type: "interaction_respond", id: "r2", payload }),
    ]);
    expect(herdr.callsOf("terminal.keys").map((x) => x.params.keys)).toEqual([["1"]]);
    expect(c.ofType("error")).toMatchObject([{ replyTo: "r2", error: { code: ProtocolErrors.ERR_INTERACTION_STALE } }]);
    expect(c.ofType("ack")[0].replyTo).toBe("r1");
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
    await send(a.ws, { type: "config_patch", id: "p1", payload: { client: { accent: "green" } } });
    const ack = a.ofType("ack")[0];
    expect(ack.payload.client.accent).toBe("green");
    expect(a.ofType("config_updated")).toHaveLength(0);
    expect(b.ofType("config_updated")[0].payload).toMatchObject({ version: ack.payload.version, client: { accent: "green" } });
    expect(config.getClientConfig().accent).toBe("green");
  });

  test("a patch with an unknown key is rejected and nothing is saved", async () => {
    const before = JSON.stringify(config.getClientConfig());
    const c = fakeWs();
    await send(c.ws, { type: "config_patch", id: "p1", payload: { client: { evil: true } } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
    expect(JSON.stringify(config.getClientConfig())).toBe(before);
  });

  test("a removed key or an unknown accent is rejected", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "config_patch", id: "p1", payload: { client: { themeKey: "gruvbox" } } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
    await send(c.ws, { type: "config_patch", id: "p2", payload: { client: { accent: "chartreuse" } } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
  });
});

describe("device revocation (security-and-pairing.md §5)", () => {
  test("revoking a device closes its connections with 4403", () => {
    const c = fakeWs("dev_gone");
    server.handleOpen(c.ws);
    server.closeDevice("dev_gone");
    expect(c.closes[0].code).toBe(4403);
  });
});

describe("incremental resume with have (protocol.md §3.1, §3.3, §4.4)", () => {
  const turn1: NormalizedTurn = { turnId: "t1", turnNumber: 1, timestamp: 1000, userPrompt: { text: "hello" } };
  const turn2: NormalizedTurn = { turnId: "t2", turnNumber: 2, timestamp: 2000, userPrompt: { text: "step 2" } };
  const turn3: NormalizedTurn = { turnId: "t3", turnNumber: 3, timestamp: 3000, userPrompt: { text: "step 3" } };

  beforeEach(() => {
    (server.paneStore as any).paneStates.set("p1", {
      paneId: "p1",
      agent: "claude",
      sessionId: "ses_1",
      turns: [turn1, turn2, turn3],
      seqWatermark: 3,
      sessionTitle: "My Session",
    });
  });

  test("hash helper gives deterministic 8-char lowercase hex", () => {
    const h1 = hashTurn(turn1);
    const h2 = hashTurn(turn1);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a32("test")).toBe("afd071e5");
  });

  test("a matching have gets a turns_delta from turnCount (protocol.md §3.3)", async () => {
    const c = fakeWs();
    server.handleOpen(c.ws);
    await send(c.ws, {
      type: "select_view",
      id: "s1",
      payload: {
        paneId: "p1",
        have: {
          sessionId: "ses_1",
          turnCount: 2,
          lastTurnHash: hashTurn(turn2),
        },
      },
    });
    const boot = c.ofType("pane_bootstrap");
    expect(boot.length).toBe(1);
    expect(boot[0].payload.resume).toMatchObject({
      paneId: "p1",
      sinceTurnIndex: 2,
      appendTurns: [toLightTurn(turn3)],
      sessionTitle: "My Session",
    });
  });

  test("a mismatched hash gets a full bootstrap", async () => {
    const c = fakeWs();
    server.handleOpen(c.ws);
    await send(c.ws, {
      type: "select_view",
      id: "s2",
      payload: {
        paneId: "p1",
        have: {
          sessionId: "ses_1",
          turnCount: 2,
          lastTurnHash: "00000000",
        },
      },
    });
    const boot = c.ofType("pane_bootstrap");
    expect(boot.length).toBe(1);
    expect(boot[0].payload.resume).toBeNull();
    expect(boot[0].payload.turns.turns).toHaveLength(3);
  });

  test("a mismatched sessionId gets a full bootstrap", async () => {
    const c = fakeWs();
    server.handleOpen(c.ws);
    await send(c.ws, {
      type: "select_view",
      id: "s3",
      payload: {
        paneId: "p1",
        have: {
          sessionId: "other_session",
          turnCount: 2,
          lastTurnHash: hashTurn(turn2),
        },
      },
    });
    const boot = c.ofType("pane_bootstrap");
    expect(boot.length).toBe(1);
    expect(boot[0].payload.resume).toBeNull();
    expect(boot[0].payload.turns.turns).toHaveLength(3);
  });

  test("an unbound pane gets bootstrap with bound: false", async () => {
    const c = fakeWs();
    server.handleOpen(c.ws);
    await send(c.ws, {
      type: "select_view",
      id: "s4",
      payload: {
        paneId: "p2",
        have: {
          sessionId: "ses_unbound",
          turnCount: 1,
          lastTurnHash: hashTurn(turn1),
        },
      },
    });
    const boot = c.ofType("pane_bootstrap");
    expect(boot.length).toBe(1);
    expect(boot[0].payload.resume).toBeNull();
    expect(boot[0].payload.turns.session.bound).toBe(false);
  });

  test("a malformed have gets a full bootstrap", async () => {
    const c = fakeWs();
    server.handleOpen(c.ws);
    await send(c.ws, {
      type: "select_view",
      id: "s5",
      payload: {
        paneId: "p1",
        have: {
          sessionId: 123,
          turnCount: -1,
          lastTurnHash: "bad",
        } as any,
      },
    });
    const boot = c.ofType("pane_bootstrap");
    expect(boot.length).toBe(1);
    expect(boot[0].payload.resume).toBeNull();
    expect(boot[0].payload.turns.turns).toHaveLength(3);
  });
});

// Issue #19 acceptance: protocol.md §3.3 (resume anchor), §4.20 and §5.6 (light turns, details),
// §4.2 and §8 (ERR_UPSTREAM_OFFLINE), §4.5 (recipe lookup); herdr-adapter.md §3.2 (event shapes).
describe("pane data, Herdr faults and recipe lookup (issue #19)", () => {
  const plain = (n: number, text: string): NormalizedTurn => ({ turnId: `t${n}`, turnNumber: n, timestamp: n * 1000, userPrompt: { text } });
  const until = async (cond: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await Bun.sleep(10);
    }
  };

  test("resume anchors on the second-to-last turn (P1)", async () => {
    const third: NormalizedTurn = { ...plain(3, "step 3"), assistantResponse: { markdown: "still writing, now done" } };
    (server.paneStore as any).paneStates.set("p1", { paneId: "p1", agent: "claude", sessionId: "ses_1", turns: [plain(1, "a"), plain(2, "b"), third], seqWatermark: 3 });
    const c = fakeWs();
    server.handleOpen(c.ws);
    // The phone holds three turns; its third is stale because the agent kept writing it.
    await send(c.ws, { type: "select_view", id: "s1", payload: { paneId: "p1", have: { sessionId: "ses_1", turnCount: 3, anchorHash: hashTurn(plain(2, "b")) } } });
    const boot = c.ofType("pane_bootstrap").at(-1)?.payload;
    expect(boot?.turns).toBeNull();
    expect(boot?.resume).toMatchObject({ paneId: "p1", sinceTurnIndex: 2, appendTurns: [third] });
  });

  test("turns travel light and detail_get returns the full tool call (§5.6, §4.20)", async () => {
    const run = { id: "c1", name: "Bash", verb: "run", target: "bun test", input: { command: "bun test" }, output: "x".repeat(5000), status: "completed" };
    const diff = { filePath: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b\n" };
    const edit = { id: "c2", name: "Edit", verb: "edit", target: "src/a.ts", input: { file_path: "src/a.ts" }, status: "completed", diff };
    const turn = { ...plain(1, "go"), items: [{ kind: "tool", call: run }, { kind: "tool", call: edit }], toolCalls: [run, edit] };
    const stats = { filesModified: 1, additions: 1, deletions: 1, diffs: [diff] };
    (server.paneStore as any).paneStates.set("p1", { paneId: "p1", agent: "claude", sessionId: "ses_1", turns: [turn], seqWatermark: 1, stats });
    const c = fakeWs();
    server.handleOpen(c.ws);
    await send(c.ws, { type: "select_view", id: "s1", payload: { paneId: "p1" } });
    const sent = c.ofType("pane_bootstrap").at(-1)?.payload.turns;
    const light = sent?.turns[0];
    expect(light?.toolCalls).toBeUndefined();
    expect(light?.items[0].call).toMatchObject({ id: "c1", verb: "run", target: "bun test", status: "completed" });
    expect(light?.items[0].call.input).toBeUndefined();
    expect(light?.items[0].call.output).toBeUndefined();
    expect(light?.items[1].call.diff).toMatchObject({ filePath: "src/a.ts", additions: 1, deletions: 1 });
    expect(light?.items[1].call.diff.patch).toBeUndefined();
    expect(sent?.sessionStats).toMatchObject({ filesModified: 1, files: [{ filePath: "src/a.ts", additions: 1, deletions: 1 }] });
    expect(sent?.sessionStats.diffs).toBeUndefined();

    await send(c.ws, { type: "detail_get", id: "d1", payload: { paneId: "p1", kind: "tool", turnId: "t1", callId: "c1" } });
    expect(c.ofType("ack").at(-1)?.payload.call?.output).toBe("x".repeat(5000));
  });

  test("a write command while Herdr is offline is ERR_UPSTREAM_OFFLINE (D13)", async () => {
    await herdr.close();
    const c = fakeWs();
    await send(c.ws, { type: "agent_prompt", id: "o1", payload: { targetPaneId: "p1", text: "hi" } });
    expect(lastError(c.sent)).toBe("ERR_UPSTREAM_OFFLINE");
  });

  test("a status event of unknown shape is logged and reconciled by a snapshot (B17)", async () => {
    herdr.serve([{ paneId: "p1", app: "claude-code" }, { paneId: "p2", app: "codex" }]);
    await client.connect();
    await until(() => herdr.callsOf("ls").length > 0);
    await Bun.sleep(100); // let the snapshots of the connect settle
    const snapshotsBefore = herdr.callsOf("ls").length;
    herdr.emitEvent("status", "p1", undefined as any); // no `data` at all
    await until(() => herdr.callsOf("ls").length > snapshotsBefore);
    // The daemon is still processing events.
    herdr.serve([{ paneId: "p1", app: "claude-code", state: "working" }, { paneId: "p2", app: "codex" }]);
    herdr.emitEvent("status", "p1", { status: { state: "working", app: "claude-code" } });
    await until(() => client.getPaneHerdrStatus("p1") === "working");
  });

  test("an inherited object key is not a recipe (B16)", async () => {
    const c = fakeWs();
    await send(c.ws, { type: "create_tab_and_agent", id: "k1", payload: { workspaceId: "w1", agentKind: "constructor" } });
    expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
    expect(herdr.callsOf("tab.new")).toHaveLength(0);
  });
});
