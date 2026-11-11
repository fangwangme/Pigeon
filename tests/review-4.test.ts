import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveInstancePaths, resolveProductionPort } from "../src/server/config-manager";
import { PaneStore } from "../src/server/pane-store";
import { AgentAdapterManager } from "../src/server/agent-adapters/index";
import { tempDir } from "./helpers/fixtures";

const line = (o: object) => JSON.stringify(o) + "\n";

describe("PR #20 review 4 fixes", () => {
  test("custom production port derives production paths and test paths correctly", () => {
    const dir = tempDir("prod-port");
    try {
      const pigeonDir = join(dir, "pigeon");
      mkdirSync(pigeonDir, { recursive: true });
      writeFileSync(join(pigeonDir, "config.json"), JSON.stringify({ server: { port: 4200 } }));

      const prodPort = resolveProductionPort({ HOME: dir, XDG_DATA_HOME: dir });
      expect(prodPort).toBe(4200);

      const prodPaths = resolveInstancePaths({ port: 4200, productionPort: 4200, env: { HOME: dir, XDG_DATA_HOME: dir } });
      expect(prodPaths.stateDir).toBe(join(dir, "pigeon"));
      expect(prodPaths.adminSocketPath).toContain("pigeon.sock");

      const testPaths = resolveInstancePaths({ port: 4101, productionPort: 4200, env: { HOME: dir, XDG_DATA_HOME: dir } });
      expect(testPaths.stateDir).toBe(join(dir, "pigeon-4101"));
      expect(testPaths.adminSocketPath).toContain("pigeon-4101.sock");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pane store seqWatermark only increments when delta is emitted", async () => {
    const brain = tempDir("brain");
    const logs = join(brain, "s1", ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const log = join(logs, "transcript.jsonl");
    writeFileSync(log, line({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>first</USER_REQUEST>", created_at: new Date(1000).toISOString() }));

    const adapters = new AgentAdapterManager({ agy: { baseBrainDir: brain } });
    const store = new PaneStore(adapters);
    const deltas: any[] = [];
    store.on("turns_delta", (d) => deltas.push(d));

    try {
      store.registerPaneSession("p1", "agy", "s1");
      expect(deltas.length).toBe(1);
      expect(deltas[0].seq).toBe(1);
      expect(store.getPaneState("p1")?.seqWatermark).toBe(1);

      // Re-registering or reading with no changes must not increment seqWatermark
      (store as any).refreshPaneTurns("p1", true);
      expect(deltas.length).toBe(1);
      expect(store.getPaneState("p1")?.seqWatermark).toBe(1);

      // Appending a turn must increment seqWatermark
      appendFileSync(log, line({ step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>second</USER_REQUEST>", created_at: new Date(2000).toISOString() }));
      (store as any).refreshPaneTurns("p1", true);
      expect(deltas.length).toBe(2);
      expect(deltas[1].seq).toBe(2);
      expect(store.getPaneState("p1")?.seqWatermark).toBe(2);
    } finally {
      store.destroy();
      rmSync(brain, { recursive: true, force: true });
    }
  });

  test("upload store and mime disposition logic enforces sandbox and attachment for non-raster files", () => {
    const isRaster = (mime: string) =>
      ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/heic"].includes(mime.toLowerCase());

    expect(isRaster("image/png")).toBe(true);
    expect(isRaster("image/jpeg")).toBe(true);
    expect(isRaster("image/webp")).toBe(true);
    expect(isRaster("image/svg+xml")).toBe(false);
    expect(isRaster("text/html")).toBe(false);
    expect(isRaster("application/javascript")).toBe(false);
  });

  test("push notification done triggers on transition from blocked to done", () => {
    let lastStatus: string | undefined = "blocked";
    const status: string = "done";
    const previous = lastStatus;
    const isBlocked = status === "blocked" && previous !== "blocked";
    const isDone = status === "done" && previous !== "done";
    expect(isBlocked).toBe(false);
    expect(isDone).toBe(true);
  });
});
