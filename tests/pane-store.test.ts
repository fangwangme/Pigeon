import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentAdapterManager } from "../src/server/agent-adapters/index";
import { PaneStore } from "../src/server/pane-store";
import type { TurnsDeltaPayload } from "../src/server/pane-store";
import { tempDir } from "./helpers/fixtures";

// agent-session-normalization.md §4: log appends are read incrementally, never by re-reading the file.
const line = (o: object) => JSON.stringify(o) + "\n";
let store: PaneStore | null = null;
afterEach(() => store?.destroy());

describe("session log streaming (agent-session-normalization.md §4)", () => {
  test("the first read is full; reads after a log append are incremental and stream the new turn", async () => {
    const brain = tempDir("brain");
    const logs = join(brain, "s1", ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const log = join(logs, "transcript.jsonl");
    writeFileSync(log, line({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>first</USER_REQUEST>", created_at: new Date(1000).toISOString() }));

    const adapters = new AgentAdapterManager({ agy: { baseBrainDir: brain } });
    const modes: boolean[] = [];
    const getTurns = adapters.getTurns.bind(adapters);
    adapters.getTurns = (agent, sessionId, incremental) => {
      modes.push(!!incremental);
      return getTurns(agent, sessionId, incremental);
    };
    store = new PaneStore(adapters);
    const deltas: TurnsDeltaPayload[] = [];
    store.on("turns_delta", (d) => deltas.push(d));

    store.registerPaneSession("p1", "agy", "s1");
    await Bun.sleep(50);
    appendFileSync(log, line({ step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>second</USER_REQUEST>", created_at: new Date(2000).toISOString() }));
    const deadline = Date.now() + 1500;
    while (modes.length < 2 && Date.now() < deadline) {
      await Bun.sleep(25);
    }

    expect(modes[0]).toBe(false);
    expect(modes.slice(1).length).toBeGreaterThan(0);
    expect(modes.slice(1).every((m) => m)).toBe(true);
    expect(store.getPayload("p1", "agy").turns.map((t) => t.userPrompt?.text)).toEqual(["first", "second"]);
    expect(deltas.at(-1)!.appendTurns.map((t) => t.userPrompt?.text)).toEqual(["second"]);
  });

  test("a session bound before its log exists starts streaming once the log appears and binding runs again", async () => {
    const brain = tempDir("brain");
    const logs = join(brain, "s1", ".system_generated", "logs");
    const log = join(logs, "transcript.jsonl");
    store = new PaneStore(new AgentAdapterManager({ agy: { baseBrainDir: brain } }));
    const deltas: TurnsDeltaPayload[] = [];
    store.on("turns_delta", (d) => deltas.push(d));

    store.registerPaneSession("p1", "agy", "s1"); // no log yet
    mkdirSync(logs, { recursive: true });
    writeFileSync(log, line({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>first</USER_REQUEST>", created_at: new Date(1000).toISOString() }));
    store.registerPaneSession("p1", "agy", "s1"); // the next snapshot's binding
    await Bun.sleep(50);
    appendFileSync(log, line({ step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>second</USER_REQUEST>", created_at: new Date(2000).toISOString() }));
    const deadline = Date.now() + 1500;
    while (store.getPayload("p1", "agy").turns.length < 2 && Date.now() < deadline) {
      await Bun.sleep(25);
    }

    expect(store.getPayload("p1", "agy").turns.map((t) => t.userPrompt?.text)).toEqual(["first", "second"]);
  });

  test("seqWatermark only increments when delta is emitted (protocol.md §5.6)", async () => {
    const brain = tempDir("brain");
    const logs = join(brain, "s1", ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const log = join(logs, "transcript.jsonl");
    writeFileSync(log, line({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>first</USER_REQUEST>", created_at: new Date(1000).toISOString() }));

    const adapters = new AgentAdapterManager({ agy: { baseBrainDir: brain } });
    store = new PaneStore(adapters);
    const deltas: TurnsDeltaPayload[] = [];
    store.on("turns_delta", (d) => deltas.push(d));

    store.registerPaneSession("p1", "agy", "s1");
    expect(deltas.length).toBe(1);
    expect(deltas[0].seq).toBe(1);
    expect(store.getPaneState("p1")?.seqWatermark).toBe(1);

    // Re-reading with no changes must not increment seqWatermark or emit delta
    (store as any).refreshPaneTurns("p1", true);
    expect(deltas.length).toBe(1);
    expect(store.getPaneState("p1")?.seqWatermark).toBe(1);

    // Appending a turn increments seqWatermark and emits delta
    appendFileSync(log, line({ step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>second</USER_REQUEST>", created_at: new Date(2000).toISOString() }));
    (store as any).refreshPaneTurns("p1", true);
    expect(deltas.length).toBe(2);
    expect(deltas[1].seq).toBe(2);
    expect(store.getPaneState("p1")?.seqWatermark).toBe(2);
  });

  test("recovers FSWatcher after atomic file rename (agent-session-normalization.md §4.2)", async () => {
    const brain = tempDir("watch-rename");
    const logs = join(brain, "s1", ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const log = join(logs, "transcript.jsonl");
    writeFileSync(log, line({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>one</USER_REQUEST>", created_at: "2026-11-10T10:00:00Z" }), "utf-8");

    store = new PaneStore(new AgentAdapterManager({ agy: { baseBrainDir: brain } }));
    store.registerPaneSession("p1", "agy", "s1");
    await Bun.sleep(40);

    const tmp = `${log}.tmp`;
    writeFileSync(
      tmp,
      line({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>one</USER_REQUEST>", created_at: "2026-11-10T10:00:00Z" }) +
        line({ step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>two</USER_REQUEST>", created_at: "2026-11-10T10:00:01Z" }),
      "utf-8"
    );
    renameSync(tmp, log);
    await Bun.sleep(250);
    expect(store.getPayload("p1", "agy").turns.map((t) => t.userPrompt?.text)).toEqual(["one", "two"]);

    appendFileSync(log, line({ step_index: 2, type: "USER_INPUT", content: "<USER_REQUEST>three</USER_REQUEST>", created_at: "2026-11-10T10:00:02Z" }), "utf-8");
    const deadline = Date.now() + 2000;
    while (store.getPayload("p1", "agy").turns.length < 3 && Date.now() < deadline) {
      await Bun.sleep(30);
    }
    expect(store.getPayload("p1", "agy").turns.map((t) => t.userPrompt?.text)).toEqual(["one", "two", "three"]);
  });

  test("a session read that fails keeps the pane's last turns (architecture.md §5)", async () => {
    const brain = tempDir("brain");
    const logs = join(brain, "s1", ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const log = join(logs, "transcript.jsonl");
    writeFileSync(log, line({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>first</USER_REQUEST>", created_at: new Date(1000).toISOString() }));
    const adapters = new AgentAdapterManager({ agy: { baseBrainDir: brain } });
    store = new PaneStore(adapters);
    const deltas: TurnsDeltaPayload[] = [];
    store.on("turns_delta", (d) => deltas.push(d));
    store.registerPaneSession("p1", "agy", "s1");
    await Bun.sleep(50);

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      (adapters as any).sources.get("agy").read = () => {
        throw new Error("EACCES");
      };
      const before = deltas.length;
      appendFileSync(log, line({ step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>second</USER_REQUEST>", created_at: new Date(2000).toISOString() }));
      const deadline = Date.now() + 1500;
      while (!adapters.getSourceErrors().length && Date.now() < deadline) await Bun.sleep(25);

      expect(adapters.getSourceErrors().map((e) => e.op)).toEqual(["read"]);
      expect(deltas.length).toBe(before);
      expect(store.getPayload("p1", "agy").turns.map((t) => t.userPrompt?.text)).toEqual(["first"]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
