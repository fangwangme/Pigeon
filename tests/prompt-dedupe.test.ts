import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentAdapterManager } from "../src/server/agent-adapters/index";
import { ConfigManager } from "../src/server/config-manager";
import { HerdrClient, HerdrError } from "../src/server/herdr-client";
import { ModelCatalog } from "../src/server/model-catalog";
import { PairingManager } from "../src/server/pairing";
import { PushManager } from "../src/server/push";
import { SkillScanner } from "../src/server/skill-scanner";
import { UploadStore } from "../src/server/uploads";
import { WsServer } from "../src/server/ws-server";
import { ProtocolErrors } from "../src/types/protocol";
import { FakeHerdr, fakeWs, tempDir, topologyOf, type FakePane } from "./helpers/fixtures";

const PANES: FakePane[] = [{ paneId: "p2", app: "codex", state: "idle", program: "codex" }];

describe("in-flight prompt duplicate guard (protocol.md §4.2)", () => {
  let dir: string;
  let herdr: FakeHerdr;
  let client: HerdrClient;
  let server: WsServer;

  beforeEach(async () => {
    dir = tempDir("prompt-dedupe");
    herdr = new FakeHerdr(dir);
    herdr.serve(PANES.map((p) => ({ ...p, cwd: dir })), { folder: "/start" });
    await herdr.listen();
    herdr.handlers["terminal.read"] = () => ({ result: { text: "$ \n", how: "history" } });
    client = new HerdrClient({ appSocketPath: herdr.appSocketPath, coreSocketPath: herdr.coreSocketPath, debounceMs: 5, panePollMs: 60_000 });
    client.applySnapshot(topologyOf(PANES.map((p) => ({ ...p, cwd: dir })), { folder: "/start" }));
    writeFileSync(join(dir, "models.json"), JSON.stringify({ codex: { models: [], fetchedAt: Date.now() } }));
    server = new WsServer({
      buildId: "b",
      herdrClient: client,
      pushManager: new PushManager(join(dir, "vapid.json")),
      configManager: new ConfigManager(join(dir, "config.json"), { HOME: dir }),
      skillScanner: new SkillScanner(dir),
      agentAdapters: new AgentAdapterManager({ home: dir }),
      uploadStore: new UploadStore(join(dir, "uploads")),
      pairingManager: new PairingManager({ devicesFilePath: join(dir, "devices.json"), adminSocketPath: join(dir, "admin.sock"), publicBaseUrl: "https://pigeon.example.ts.net" }),
      queueFilePath: join(dir, "queue.json"),
      modelCatalog: new ModelCatalog({ home: dir, env: { PATH: "" }, keychain: false, cachePath: join(dir, "models.json") }),
    });
  });

  afterEach(async () => {
    server?.destroy();
    client?.disconnect();
    await herdr?.close();
  });

  const ackOf = (c: ReturnType<typeof fakeWs>, id: string) => c.ofType("ack").find((a) => a.replyTo === id)?.payload;

  test("a resend while the first immediate send is still pending is acked as duplicate; after send failure it goes out", async () => {
    const c = fakeWs();
    server.handleOpen(c.ws);
    await server.handleMessage(c.ws, JSON.stringify({ type: "hello", id: "h", payload: { protocolVersion: "1.0.0", subscribePaneId: "p2" } }));

    let resolveSend!: () => void;
    let rejectSend!: (err: unknown) => void;
    const sendSpy = spyOn(client, "sendPrompt");

    // 1. First immediate send stays in flight; a resend during the wait is flagged as duplicate.
    sendSpy.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    const firstSend = server.handleMessage(c.ws, JSON.stringify({ type: "agent_prompt", id: "m1", payload: { targetPaneId: "p2", text: "run tests" } }));
    expect(sendSpy).toHaveBeenCalledTimes(1);

    await server.handleMessage(c.ws, JSON.stringify({ type: "agent_prompt", id: "m2", payload: { targetPaneId: "p2", text: "run tests" } }));
    expect(ackOf(c, "m2")).toEqual({ duplicate: true });
    expect(sendSpy).toHaveBeenCalledTimes(1);

    resolveSend();
    await firstSend;
    expect(ackOf(c, "m1")).toMatchObject({ queued: false });
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // 2. When an in-flight immediate send rejects, its dedupe entry is removed so the retry goes out.
    sendSpy.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const failingSend = server.handleMessage(c.ws, JSON.stringify({ type: "agent_prompt", id: "f1", payload: { targetPaneId: "p2", text: "retry me" } }));
    expect(sendSpy).toHaveBeenCalledTimes(2);

    await server.handleMessage(c.ws, JSON.stringify({ type: "agent_prompt", id: "f_dup", payload: { targetPaneId: "p2", text: "retry me" } }));
    expect(ackOf(c, "f_dup")).toEqual({ duplicate: true });
    expect(sendSpy).toHaveBeenCalledTimes(2);

    rejectSend(new HerdrError("blocked", "blocked"));
    await failingSend;
    expect(c.ofType("error").at(-1)?.error?.code).toBe(ProtocolErrors.ERR_AGENT_BLOCKED);

    await server.handleMessage(c.ws, JSON.stringify({ type: "agent_prompt", id: "f2", payload: { targetPaneId: "p2", text: "retry me" } }));
    expect(ackOf(c, "f2")).toMatchObject({ queued: false });
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });
});
