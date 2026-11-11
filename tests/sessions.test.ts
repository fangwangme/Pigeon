import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentAdapterManager } from "../src/server/agent-adapters/index";
import { JsonlTail } from "../src/server/sessions/common";
import { ConfigManager } from "../src/server/config-manager";
import { HerdrClient } from "../src/server/herdr-client";
import { PushManager } from "../src/server/push";
import { SkillScanner } from "../src/server/skill-scanner";
import { WsServer } from "../src/server/ws-server";
import { FakeHerdr, fakeWs, tempDir, topologyOf, type FakePane } from "./helpers/fixtures";

// agent-session-normalization.md §2 (binding and record formats), §3 (model), protocol.md §4.10, §5.6.
const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");
const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

let cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

/** A WsServer whose agent stores live under `home`, with one tab holding `panes`. */
async function setup(home: string, panes: FakePane[], folder = "/work") {
  const herdr = new FakeHerdr(tempDir("herdr"));
  await herdr.listen();
  herdr.handlers["terminal.read"] = () => ({ result: { text: "", how: "history" } });
  const client = new HerdrClient({ appSocketPath: herdr.appSocketPath, coreSocketPath: herdr.coreSocketPath, debounceMs: 5, panePollMs: 60_000 });
  client.applySnapshot(topologyOf(panes, { folder }));
  const server = new WsServer({
    buildId: "b",
    herdrClient: client,
    pushManager: new PushManager(join(home, "vapid.json")),
    configManager: new ConfigManager(join(home, "config.json"), { HOME: home }),
    skillScanner: new SkillScanner(home),
    agentAdapters: new AgentAdapterManager({ home }),
  });
  cleanup.push(async () => {
    server.destroy();
    client.disconnect();
    await herdr.close();
  });
  const open = async (paneId: string) => {
    const c = fakeWs();
    server.handleOpen(c.ws);
    await server.handleMessage(c.ws, JSON.stringify({ type: "hello", id: "h", payload: { protocolVersion: "1.0.0", subscribePaneId: paneId } }));
    const boot = c.ofType("pane_bootstrap").at(-1)?.payload;
    if (boot?.turns?.turns) {
      for (const turn of boot.turns.turns) {
        const calls: any[] = [];
        for (const item of turn.items ?? []) {
          if (item.kind === "tool" && item.call?.id) {
            const reqId = `d_${item.call.id}`;
            await server.handleMessage(c.ws, JSON.stringify({ type: "detail_get", id: reqId, payload: { paneId, kind: "tool", turnId: turn.turnId, callId: item.call.id } }));
            const ack = c.ofType("ack").find((a) => a.replyTo === reqId)?.payload;
            if (ack?.call) calls.push(ack.call);
          } else if (item.kind === "reasoning") {
            const reqId = `dr_${turn.turnId}`;
            await server.handleMessage(c.ws, JSON.stringify({ type: "detail_get", id: reqId, payload: { paneId, kind: "reasoning", turnId: turn.turnId } }));
            const ack = c.ofType("ack").find((a) => a.replyTo === reqId)?.payload;
            if (ack?.text) turn.reasoning = { text: ack.text };
          }
        }
        if (calls.length) turn.toolCalls = calls;
      }
      if (boot.turns.sessionStats?.files) {
        const diffs: any[] = [];
        for (const f of boot.turns.sessionStats.files) {
          const reqId = `df_${f.filePath}`;
          await server.handleMessage(c.ws, JSON.stringify({ type: "detail_get", id: reqId, payload: { paneId, kind: "file", filePath: f.filePath } }));
          const ack = c.ofType("ack").find((a) => a.replyTo === reqId)?.payload;
          if (ack?.diff) diffs.push(ack.diff);
        }
        if (diffs.length) boot.turns.sessionStats.diffs = diffs;
      }
    }
    return c;
  };
  return { herdr, client, server, open };
}

const turnsOf = (c: ReturnType<typeof fakeWs>) => c.ofType("pane_bootstrap").at(-1)?.payload.turns;

function claudeTranscript(proj: string) {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 6, 10, 0, s)).toISOString();
  return jsonl([
    { type: "user", uuid: "u1", timestamp: at(0), cwd: proj, message: { role: "user", content: "Fix the tests" } },
    { type: "assistant", timestamp: at(1), message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "thinking", thinking: "Look at the tests first" }] } },
    { type: "assistant", timestamp: at(2), message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test", description: "Run the test suite" } }] } },
    { type: "user", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1 fail", is_error: true }] } },
    { type: "assistant", timestamp: at(4), message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: join(proj, "a.ts"), old_string: "a\nb", new_string: "a\nc\nd" } }] } },
    { type: "user", timestamp: at(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } },
    { type: "assistant", timestamp: at(6), message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: [{ content: "Fix", status: "completed", activeForm: "Fixing" }, { content: "Ship", status: "pending", activeForm: "Shipping" }] } }] } },
    { type: "user", timestamp: at(7), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "ok" }] } },
    { type: "assistant", timestamp: at(8), message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "Fixed **a.ts**." }] } },
    { type: "custom-title", customTitle: "Fix tests", sessionId: "s1" },
    { type: "user", timestamp: at(9), isMeta: true, message: { role: "user", content: "<command-name>/clear</command-name>" } },
    { type: "user", timestamp: at(10), message: { role: "user", content: "Which db?" } },
    { type: "assistant", timestamp: at(11), message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: "t4", name: "AskUserQuestion", input: { questions: [{ question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "SQLite", description: "Local file" }, { label: "Postgres", description: "Server" }] }] } }] } },
    { type: "assistant", timestamp: at(12), isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "sub-agent chatter" }] } },
  ]);
}

describe("binding a pane to its session (agent-session-normalization.md §2.0)", () => {
  test("claude: the process map names the session exactly", async () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
    writeFileSync(join(home, ".claude", "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: "s1", cwd: proj }));
    mkdirSync(join(home, ".claude", "projects", slug(proj)), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", slug(proj), "s1.jsonl"), claudeTranscript(proj));
    // A newer session in the same folder must not win over the exact match.
    writeFileSync(join(home, ".claude", "projects", slug(proj), "s2.jsonl"), jsonl([{ type: "user", message: { role: "user", content: "other" } }]));
    const { open } = await setup(home, [{ paneId: "p1", app: "claude-code", cwd: proj, pid: 4242 }]);
    const payload = turnsOf(await open("p1"));
    expect(payload.session).toMatchObject({ bound: true, agent: "claude", sessionId: "s1", model: { value: "claude-opus-5-5", source: "log" } });
    expect(payload.sessionTitle).toBe("Fix tests");
  });

  test("codex: the newest session of the folder written since the terminal started", async () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    const dir = join(home, ".codex", "sessions", "2026", "11", "06");
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "rollout-2026-11-06T09-00-00-c0.jsonl");
    writeFileSync(old, jsonl([{ type: "session_meta", payload: { id: "c0", cwd: proj } }]));
    const before = (Date.now() - 7_200_000) / 1000;
    utimesSync(old, before, before); // written before the terminal started
    writeFileSync(join(dir, "rollout-2026-11-06T10-00-00-c1.jsonl"), jsonl([{ type: "session_meta", payload: { id: "c1", cwd: proj } }]));
    writeFileSync(join(dir, "rollout-2026-11-06T10-00-01-cx.jsonl"), jsonl([{ type: "session_meta", payload: { id: "cx", cwd: "/elsewhere" } }]));
    const { open } = await setup(home, [{ paneId: "p1", app: "codex", cwd: proj, createdMs: Date.now() - 60_000 }]);
    expect(turnsOf(await open("p1")).session).toMatchObject({ bound: true, agent: "codex", sessionId: "c1" });
  });

  test("a session already bound to one pane is not bound to a second pane in the same folder", async () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    const dir = join(home, ".codex", "sessions", "2026", "11", "06");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-2026-11-06T10-00-00-c1.jsonl"), jsonl([{ type: "session_meta", payload: { id: "c1", cwd: proj } }]));
    const created = Date.now() - 60_000;
    const { open } = await setup(home, [
      { paneId: "p1", app: "codex", cwd: proj, createdMs: created },
      { paneId: "p2", app: "codex", cwd: proj, createdMs: created },
    ]);
    const bound = [turnsOf(await open("p1")).session.bound, turnsOf(await open("p2")).session.bound];
    expect(bound.sort()).toEqual([false, true]);
  });

  test("a bound pane keeps its session when a newer pane's session appears in the same folder (rule 6)", async () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    const dir = join(home, ".codex", "sessions", "2026", "11", "06");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-2026-11-06T10-00-00-c1.jsonl"), jsonl([{ type: "session_meta", payload: { id: "c1", cwd: proj } }]));
    const first = { paneId: "p1", app: "codex", cwd: proj, createdMs: Date.now() - 60_000 };
    const { client, server } = await setup(home, [first]);
    expect(server.paneStore.boundSession("p1")?.sessionId).toBe("c1");
    writeFileSync(join(dir, "rollout-2026-11-06T10-05-00-c2.jsonl"), jsonl([{ type: "session_meta", payload: { id: "c2", cwd: proj } }]));
    client.applySnapshot(topologyOf([first, { paneId: "p2", app: "codex", cwd: proj, createdMs: Date.now() - 1_000 }], { folder: "/work" }));
    expect([server.paneStore.boundSession("p1")?.sessionId, server.paneStore.boundSession("p2")?.sessionId]).toEqual(["c1", "c2"]);
  });

  test("claude's process map wins over the session a pane was resumed with, so /clear is followed (rule 5)", async () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
    mkdirSync(join(home, ".claude", "projects", slug(proj)), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", slug(proj), "s1.jsonl"), claudeTranscript(proj));
    writeFileSync(join(home, ".claude", "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: "s1", cwd: proj }));
    const pane = { paneId: "p1", app: "claude-code", cwd: proj, pid: 4242 };
    const { client, server } = await setup(home, [pane]);
    server.paneStore.setLaunch("p1", { agent: "claude", resumeSessionId: "s1" });
    writeFileSync(join(home, ".claude", "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: "s2", cwd: proj }));
    client.applySnapshot(topologyOf([pane], { folder: "/work" }));
    expect(server.paneStore.boundSession("p1")?.sessionId).toBe("s2");
  });

  test("a half-written claude process map leaves the pane unbound instead of failing (§1)", async () => {
    const home = tempDir("home");
    mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
    writeFileSync(join(home, ".claude", "sessions", "4242.json"), '{"pid": 42');
    const { open } = await setup(home, [{ paneId: "p1", app: "claude-code", cwd: tempDir("proj"), pid: 4242 }]);
    expect(turnsOf(await open("p1")).session.bound).toBe(false);
  });

  test("a pane whose agent exits is unbound (rule 7)", async () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    const dir = join(home, ".codex", "sessions", "2026", "11", "06");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-2026-11-06T10-00-00-c1.jsonl"), jsonl([{ type: "session_meta", payload: { id: "c1", cwd: proj } }]));
    const { client, server } = await setup(home, [{ paneId: "p1", app: "codex", cwd: proj, createdMs: Date.now() - 60_000 }]);
    expect(server.paneStore.boundSession("p1")?.sessionId).toBe("c1");
    client.applySnapshot(topologyOf([{ paneId: "p1", cwd: proj }], { folder: "/work" }));
    expect(server.paneStore.boundSession("p1")).toBeNull();
  });

  test("an agent pane without a matching session stays unbound", async () => {
    const { open } = await setup(tempDir("home"), [{ paneId: "p1", app: "codex", cwd: tempDir("proj") }]);
    const payload = turnsOf(await open("p1"));
    expect(payload.session.bound).toBe(false);
    expect(payload.turns).toEqual([]);
  });
});

describe("following the session the agent writes (agent-session-normalization.md §2.0, issue #3)", () => {
  /** A process that holds `first` open on fd 3 and, after one line on stdin, holds `second` instead. */
  async function holder(first: string, second: string) {
    const proc = Bun.spawn(["sh", "-c", 'exec 3<"$1"; read _; exec 3<&-; exec 3<"$2"; exec sleep 60', "sh", first, second], { stdin: "pipe" });
    cleanup.push(() => proc.kill());
    const holds = async (path: string) => {
      const end = Date.now() + 2000;
      while (Date.now() < end) {
        try {
          if (readlinkSync(`/proc/${proc.pid}/fd/3`) === path) return;
        } catch {}
        await Bun.sleep(10);
      }
      throw new Error(`process never opened ${path}`);
    };
    await holds(first);
    return {
      pid: proc.pid,
      switchFiles: async () => {
        proc.stdin.write("\n");
        proc.stdin.flush();
        await holds(second);
      },
    };
  }

  test("an agent whose process holds one of its session files open is bound to that file, and follows it when the process switches files (rule 1)", async () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    const dir = join(home, ".codex", "sessions", "2026", "11", "07");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "rollout-2026-11-07T10-00-00-ca.jsonl");
    const b = join(dir, "rollout-2026-11-07T10-05-00-cb.jsonl");
    writeFileSync(a, jsonl([{ type: "session_meta", payload: { id: "ca", cwd: proj } }]));
    writeFileSync(b, jsonl([{ type: "session_meta", payload: { id: "cb", cwd: proj } }]));
    const older = (Date.now() - 30_000) / 1000;
    utimesSync(a, older, older); // the held file is not the newest, so only the open file can name it
    const proc = await holder(a, b);
    const pane = { paneId: "p1", app: "codex", cwd: proj, pid: proc.pid, createdMs: Date.now() - 60_000 };
    const { client, server } = await setup(home, [pane]);
    expect(server.paneStore.boundSession("p1")?.sessionId).toBe("ca");

    await proc.switchFiles();
    const newer = Date.now() / 1000 + 5;
    utimesSync(a, newer, newer); // now the released file is the newest: following it would be wrong
    client.applySnapshot(topologyOf([pane], { folder: "/work" }));
    expect(server.paneStore.boundSession("p1")?.sessionId).toBe("cb");
  });

  test("AGY: a newer session after /clear moves the pane to it (rule 6)", async () => {
    const home = tempDir("home");
    const brain = join(home, ".gemini", "antigravity-cli", "brain");
    const transcript = (id: string, text: string) => {
      const logs = join(brain, id, ".system_generated", "logs");
      mkdirSync(logs, { recursive: true });
      const file = join(logs, "transcript.jsonl");
      writeFileSync(file, jsonl([{ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: new Date().toISOString(), content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` }]));
      return file;
    };
    const first = transcript("g1", "before clear");
    const earlier = (Date.now() - 30_000) / 1000;
    utimesSync(first, earlier, earlier);
    const pane = { paneId: "p1", app: "antigravity", cwd: tempDir("proj"), createdMs: Date.now() - 60_000 };
    const { client, server } = await setup(home, [pane]);
    expect(server.paneStore.boundSession("p1")?.sessionId).toBe("g1");

    transcript("g2", "after clear");
    client.applySnapshot(topologyOf([pane], { folder: "/work" }));
    expect(server.paneStore.boundSession("p1")?.sessionId).toBe("g2");
  });

  test("a resumed pane that rule 6 moved to a newer session keeps it when another pane opens in the folder (rule 6)", async () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    const dir = join(home, ".codex", "sessions", "2026", "11", "07");
    mkdirSync(dir, { recursive: true });
    const rollout = (id: string, ageMs: number) => {
      const file = join(dir, `rollout-2026-11-07T10-00-00-${id}.jsonl`);
      writeFileSync(file, jsonl([{ type: "session_meta", payload: { id, cwd: proj } }]));
      const at = (Date.now() - ageMs) / 1000;
      utimesSync(file, at, at);
    };
    rollout("c1", 30_000);
    const first = { paneId: "p1", app: "codex", cwd: proj, createdMs: Date.now() - 60_000 };
    const { client, server } = await setup(home, [first]);
    server.paneStore.setLaunch("p1", { agent: "codex", resumeSessionId: "c1" });
    rollout("c2", 0);
    client.applySnapshot(topologyOf([first], { folder: "/work" }));
    expect(server.paneStore.boundSession("p1")?.sessionId).toBe("c2");

    const second = { paneId: "p2", app: "codex", cwd: proj, createdMs: Date.now() - 10_000 };
    client.applySnapshot(topologyOf([first, second], { folder: "/work" }));
    expect([server.paneStore.boundSession("p1")?.sessionId, server.paneStore.boundSession("p2")?.sessionId]).toEqual(["c2", undefined]);
  });
});

describe("session titles (protocol.md §5.3, agent-session-normalization.md §2.4, §2.5, issue #3)", () => {
  async function claudePane(tabName: string) {
    const home = tempDir("home");
    const proj = tempDir("proj");
    mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
    writeFileSync(join(home, ".claude", "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: "s1", cwd: proj }));
    mkdirSync(join(home, ".claude", "projects", slug(proj)), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", slug(proj), "s1.jsonl"), claudeTranscript(proj));
    const herdr = new FakeHerdr(tempDir("herdr"));
    await herdr.listen();
    herdr.handlers["terminal.read"] = () => ({ result: { text: "", how: "history" } });
    const client = new HerdrClient({ appSocketPath: herdr.appSocketPath, coreSocketPath: herdr.coreSocketPath, debounceMs: 5, panePollMs: 60_000 });
    const topology = topologyOf([{ paneId: "p1", app: "claude-code", cwd: proj, pid: 4242 }]);
    topology.ls.spaces[0].tabs[0].name = tabName;
    client.applySnapshot(topology);
    const server = new WsServer({
      buildId: "b",
      herdrClient: client,
      pushManager: new PushManager(join(home, "vapid.json")),
      configManager: new ConfigManager(join(home, "config.json"), { HOME: home }),
      skillScanner: new SkillScanner(home),
      agentAdapters: new AgentAdapterManager({ home }),
    });
    cleanup.push(async () => {
      server.destroy();
      client.disconnect();
      await herdr.close();
    });
    const c = fakeWs();
    server.handleOpen(c.ws);
    await server.handleMessage(c.ws, JSON.stringify({ type: "hello", id: "h", payload: { protocolVersion: "1.0.0", subscribePaneId: "p1" } }));
    const label = async () => {
      const end = Date.now() + 2000;
      let last: string | undefined;
      while (Date.now() < end) {
        last = c.ofType("snapshot_update").at(-1)?.payload.workspaces[0].tabs[0].label;
        if (last !== "Claude Code") return last;
        await Bun.sleep(10);
      }
      return last;
    };
    return { label };
  }

  test("an unnamed tab is labelled with its bound session's title; a tab named in Herdr keeps its name", async () => {
    expect(await (await claudePane("1")).label()).toBe("Fix tests");
    expect(await (await claudePane("Release prep")).label()).toBe("Release prep");
  });

  test("codex and pi live reads carry no sessionTitle, but listings show first prompt (agent-session-normalization.md §2.4, §2.5, §2.6)", async () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    const codexDir = join(home, ".codex", "sessions", "2026", "11", "07");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "rollout-2026-11-07T10-00-00-c1.jsonl"),
      jsonl([
        { type: "session_meta", payload: { id: "c1", cwd: proj } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Refactor the parser" }] } },
      ])
    );
    const piProj = tempDir("proj");
    const piDir = join(home, ".pi", "agent", "sessions", `--${piProj.slice(1).replace(/\//g, "-")}--`);
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "2026-11-07T10-00-00_p1.jsonl"),
      jsonl([
        { type: "session", id: "p1", cwd: piProj },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "List files" }] } },
      ])
    );
    const created = Date.now() - 60_000;
    const { open } = await setup(home, [
      { paneId: "p1", app: "codex", cwd: proj, createdMs: created },
      { paneId: "p2", app: "pi", cwd: piProj, createdMs: created },
    ]);
    expect(turnsOf(await open("p1")).sessionTitle).toBeUndefined();
    expect(turnsOf(await open("p2")).sessionTitle).toBeUndefined();

    const adapters = new AgentAdapterManager({ home });
    expect(adapters.listSessions("codex", proj)).toEqual([
      { id: "c1", title: "Refactor the parser", updatedAt: expect.any(Number) },
    ]);
    expect(adapters.listSessions("pi", piProj)).toEqual([
      { id: "2026-11-07T10-00-00_p1", title: "List files", updatedAt: expect.any(Number) },
    ]);
  });
});

describe("Claude Code records (agent-session-normalization.md §2.3, §3)", () => {
  async function claudeTurns() {
    const home = tempDir("home");
    const proj = tempDir("proj");
    mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
    writeFileSync(join(home, ".claude", "sessions", "77.json"), JSON.stringify({ pid: 77, sessionId: "s1", cwd: proj }));
    mkdirSync(join(home, ".claude", "projects", slug(proj)), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", slug(proj), "s1.jsonl"), claudeTranscript(proj));
    const { open } = await setup(home, [{ paneId: "p1", app: "claude-code", cwd: proj, pid: 77 }]);
    return { proj, payload: turnsOf(await open("p1")) };
  }

  test("a turn runs from one prompt to the next; meta lines and sub-agent records are not shown", async () => {
    const { payload } = await claudeTurns();
    expect(payload.turns.map((t: any) => t.userPrompt?.text)).toEqual(["Fix the tests", "Which db?"]);
    expect(JSON.stringify(payload.turns)).not.toContain("sub-agent chatter");
  });

  test("reasoning, tool calls with verbs, descriptions and results, and the final text", async () => {
    const { proj, payload } = await claudeTurns();
    const turn = payload.turns[0];
    expect(turn.reasoning.text).toBe("Look at the tests first");
    expect(turn.toolCalls.map((c: any) => [c.name, c.verb, c.status])).toEqual([
      ["Bash", "run", "failed"],
      ["Edit", "edit", "completed"],
      ["TodoWrite", "other", "completed"],
    ]);
    expect(turn.toolCalls[0]).toMatchObject({ description: "Run the test suite", target: "bun test", output: "1 fail" });
    expect(turn.toolCalls[1].diff).toMatchObject({ filePath: join(proj, "a.ts"), status: "modified", additions: 2, deletions: 1 });
    expect(turn.assistantResponse.markdown).toBe("Fixed **a.ts**.");
  });

  test("the latest todo list and the per-file session changes (§3.1, §3.2)", async () => {
    const { proj, payload } = await claudeTurns();
    expect(payload.todos).toEqual([
      { text: "Fix", status: "completed" },
      { text: "Ship", status: "pending" },
    ]);
    expect(payload.sessionStats).toMatchObject({ filesModified: 1, additions: 2, deletions: 1 });
    expect(payload.sessionStats.diffs[0].filePath).toBe(join(proj, "a.ts"));
    expect(payload.sessionStats.diffs[0].patch).toContain("+c");
  });

  test("a question tool call without a result is the turn's pending question", async () => {
    const { payload } = await claudeTurns();
    expect(payload.turns[1].pendingQuestion.questions[0]).toEqual({
      question: "Which database?",
      header: "DB",
      multiSelect: false,
      options: [
        { label: "SQLite", description: "Local file" },
        { label: "Postgres", description: "Server" },
      ],
    });
  });
});

describe("Codex records (agent-session-normalization.md §2.4)", () => {
  test("commands, apply_patch files, update_plan todos, reasoning and replies", async () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    const dir = join(home, ".codex", "sessions", "2026", "11", "06");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rollout-2026-11-06T10-00-00-c1.jsonl"),
      jsonl([
        { type: "session_meta", payload: { id: "c1", cwd: proj } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a test" }] } },
        { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Plan it" }] } },
        { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls" }), call_id: "f1" } },
        { type: "response_item", payload: { type: "function_call_output", call_id: "f1", output: "a.ts\n" } },
        { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "f2", input: "*** Begin Patch\n*** Add File: b.ts\n+x\n+y\n*** End Patch" } },
        { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "f2", output: "Done" } },
        { type: "response_item", payload: { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Write test", status: "in_progress" }] }), call_id: "f3" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added b.ts" }] } },
      ])
    );
    const { open } = await setup(home, [{ paneId: "p1", app: "codex", cwd: proj, createdMs: Date.now() - 60_000 }]);
    const payload = turnsOf(await open("p1"));
    expect(payload.turns).toHaveLength(1);
    const turn = payload.turns[0];
    expect(turn.userPrompt.text).toBe("Add a test");
    expect(turn.reasoning.text).toBe("Plan it");
    expect(turn.toolCalls.map((c: any) => [c.verb, c.target ?? null])).toEqual([
      ["run", "ls"],
      ["create", "b.ts"],
      ["other", null],
    ]);
    expect(turn.toolCalls[1].diff).toMatchObject({ filePath: "b.ts", status: "created", additions: 2, deletions: 0 });
    expect(turn.assistantResponse.markdown).toBe("Added b.ts");
    expect(payload.todos).toEqual([{ text: "Write test", status: "in_progress" }]);
  });
});

describe("Pi records (agent-session-normalization.md §2.5)", () => {
  test("messages, tool calls and their results", async () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    const dir = join(home, ".pi", "agent", "sessions", `--${proj.slice(1).replace(/\//g, "-")}--`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-11-06T10-00-00_p1.jsonl"),
      jsonl([
        { type: "session", id: "p1", cwd: proj },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "List files" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "k1", name: "bash", arguments: { command: "ls" } }] } },
        { type: "message", message: { role: "toolResult", toolCallId: "k1", content: [{ type: "text", text: "a.ts" }], isError: false } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "One file." }] } },
      ])
    );
    const { open } = await setup(home, [{ paneId: "p1", app: "pi", cwd: proj, createdMs: Date.now() - 60_000 }]);
    const payload = turnsOf(await open("p1"));
    expect(payload.session).toMatchObject({ bound: true, sessionId: "2026-11-06T10-00-00_p1" });
    const turn = payload.turns[0];
    expect(turn.userPrompt.text).toBe("List files");
    expect(turn.toolCalls[0]).toMatchObject({ verb: "run", target: "ls", output: "a.ts", status: "completed" });
    expect(turn.assistantResponse.markdown).toBe("One file.");
  });
});

describe("listing past sessions (protocol.md §4.10, agent-session-normalization.md §2.6)", () => {
  test("claude sessions of the workspace folder and below, newest first, titled", async () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    const write = (folder: string, id: string, records: object[], ageS: number) => {
      const d = join(home, ".claude", "projects", slug(folder));
      mkdirSync(d, { recursive: true });
      const f = join(d, `${id}.jsonl`);
      writeFileSync(f, jsonl(records));
      const t = Date.now() / 1000 - ageS;
      utimesSync(f, t, t);
    };
    write(proj, "old", [{ type: "user", cwd: proj, message: { role: "user", content: "First prompt" } }], 600);
    write(join(proj, "sub"), "new", [{ type: "user", cwd: join(proj, "sub"), message: { role: "user", content: "x" } }, { type: "custom-title", customTitle: "Named one" }], 60);
    write("/elsewhere", "other", [{ type: "user", cwd: "/elsewhere", message: { role: "user", content: "no" } }], 1);
    const { server } = await setup(home, [{ paneId: "p1", app: "claude-code", cwd: proj }], proj);
    const c = fakeWs();
    server.handleOpen(c.ws);
    await server.handleMessage(c.ws, JSON.stringify({ type: "sessions_list", id: "l", payload: { workspaceId: "w1", agentKind: "claude" } }));
    const ack = c.ofType("ack").at(-1);
    expect(ack.payload.sessions.map((s: any) => [s.id, s.title])).toEqual([
      ["new", "Named one"],
      ["old", "First prompt"],
    ]);
  });
});

describe("partial lines (agent-session-normalization.md §4.2)", () => {
  test("a multi-byte character split between two reads is decoded intact (B6)", () => {
    const path = join(tempDir("tail"), "session.jsonl");
    const line = Buffer.from(JSON.stringify({ text: "修复队列" }) + "\n", "utf-8");
    const cut = line.indexOf(Buffer.from("复", "utf-8")) + 1; // inside the three bytes of 复
    writeFileSync(path, line.subarray(0, cut));
    const tail = new JsonlTail(path);
    expect(tail.read().records).toEqual([]);
    appendFileSync(path, line.subarray(cut));
    expect(tail.read().records).toEqual([{ text: "修复队列" }]);
  });
});
