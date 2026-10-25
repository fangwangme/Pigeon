import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentAdapterManager } from "../src/server/agent-adapters/index";
import { PaneStore } from "../src/server/pane-store";
import type { TurnsDeltaPayload } from "../src/server/pane-store";
import { tempDir } from "./helpers/fixtures";

// agent-session-normalization.md §5: log appends are read incrementally, never by re-reading the file.
const line = (o: object) => JSON.stringify(o) + "\n";
let store: PaneStore | null = null;
afterEach(() => store?.destroy());

describe("session log streaming (agent-session-normalization.md §5)", () => {
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
    appendFileSync(log, line({ step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>second</USER_REQUEST>", created_at: new Date(2000).toISOString() }));
    await Bun.sleep(400); // fs.watch plus the store's debounce

    expect(modes[0]).toBe(false);
    expect(modes.slice(1).length).toBeGreaterThan(0);
    expect(modes.slice(1).every((m) => m)).toBe(true);
    expect(store.getPaneTurns("p1").turns.map((t) => t.userPrompt?.text)).toEqual(["first", "second"]);
    expect(deltas.at(-1)!.appendTurns.map((t) => t.userPrompt?.text)).toEqual(["second"]);
  });
});
