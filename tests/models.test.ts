import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentAdapterManager } from "../src/server/agent-adapters/index";
import { ConfigManager } from "../src/server/config-manager";
import { HerdrClient } from "../src/server/herdr-client";
import { ModelCatalog } from "../src/server/model-catalog";
import { PushManager } from "../src/server/push";
import { SkillScanner } from "../src/server/skill-scanner";
import { WsServer } from "../src/server/ws-server";
import { FakeHerdr, fakeWs, tempDir, topologyOf } from "./helpers/fixtures";

// herdr-adapter.md §7.1 (model catalog), protocol.md §4.14 (models_refresh), §5.9 (recipes_sync). Issue #3.
let cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

function codexCache(home: string, models: object[]) {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({ models }));
}

/** A home with every agent's model source, and a PATH whose `opencode models` prints two models. */
function agentHome() {
  const home = tempDir("home");
  codexCache(home, [
    { slug: "gpt-a", display_name: "GPT A", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
    { slug: "secret", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: [] },
  ]);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "models-store.json"),
    JSON.stringify({
      openai: {
        models: [
          { id: "gpt-5", name: "GPT-5", reasoning: true, thinkingLevelMap: { off: null, minimal: "minimal", low: "low", high: "high", max: null } },
          { id: "gpt-4o", name: "GPT-4o", reasoning: false },
        ],
      },
    })
  );
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "opencode"), "#!/bin/sh\n[ \"$1\" = models ] && printf 'anthropic/claude-x\\nopenai/gpt-y\\n'\n");
  chmodSync(join(bin, "opencode"), 0o755);
  return { home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } };
}

describe("model catalog (herdr-adapter.md §7.1)", () => {
  test("each agent's recipe lists its models from the agent's own source, with thinking levels", async () => {
    const { home, env } = agentHome();
    const catalog = new ModelCatalog({ home, env });
    await catalog.refresh();
    expect(catalog.models("codex")).toEqual([{ id: "gpt-a", label: "GPT A", thinkingLevels: ["low", "high"] }]);
    const pi = catalog.models("pi");
    expect(pi.map((m) => [m.id, m.label])).toEqual([
      ["openai/gpt-5", "GPT-5"],
      ["openai/gpt-4o", "GPT-4o"],
    ]);
    expect(pi[0].thinkingLevels).toEqual(["minimal", "low", "high"]);
    expect(pi[1].thinkingLevels ?? []).toEqual([]);
    expect(catalog.models("opencode").map((m) => m.id)).toEqual(["anthropic/claude-x", "openai/gpt-y"]);
    // agy is not on this PATH: its list is empty, not an error.
    expect(catalog.models("agy")).toEqual([]);
  });

  test("models_refresh re-reads every source and sends recipes_sync to every client", async () => {
    const { home, env } = agentHome();
    codexCache(home, []);
    const catalog = new ModelCatalog({ home, env });
    await catalog.refresh();
    const herdr = new FakeHerdr(tempDir("herdr"));
    await herdr.listen();
    herdr.handlers["terminal.read"] = () => ({ result: { text: "", how: "history" } });
    const client = new HerdrClient({ appSocketPath: herdr.appSocketPath, coreSocketPath: herdr.coreSocketPath, debounceMs: 5, panePollMs: 60_000 });
    client.applySnapshot(topologyOf([{ paneId: "p1", app: "codex", cwd: home }]));
    const server = new WsServer({
      buildId: "b",
      herdrClient: client,
      pushManager: new PushManager(join(home, "vapid.json")),
      configManager: new ConfigManager(join(home, "config.json"), { HOME: home }),
      skillScanner: new SkillScanner(home),
      agentAdapters: new AgentAdapterManager({ home }),
      modelCatalog: catalog,
    });
    cleanup.push(async () => {
      server.destroy();
      client.disconnect();
      await herdr.close();
    });
    const connect = async () => {
      const c = fakeWs(`dev_${Math.random()}`);
      server.handleOpen(c.ws);
      await server.handleMessage(c.ws, JSON.stringify({ type: "hello", id: "h", payload: { protocolVersion: "1.0.0", subscribePaneId: "p1" } }));
      return c;
    };
    const asker = await connect();
    const other = await connect();
    expect(asker.ofType("welcome").at(-1).payload.recipes.codex.models).toEqual([]);

    codexCache(home, [{ slug: "gpt-new", display_name: "GPT New", visibility: "list", supported_reasoning_levels: [{ effort: "medium" }] }]);
    await server.handleMessage(asker.ws, JSON.stringify({ type: "models_refresh", id: "r1", payload: {} }));
    const ack = asker.ofType("ack").find((a: any) => a.replyTo === "r1");
    expect(ack.payload.recipes.codex.models.map((m: any) => m.id)).toEqual(["gpt-new"]);
    expect(other.ofType("recipes_sync").at(-1).payload.recipes.codex.models.map((m: any) => m.id)).toEqual(["gpt-new"]);
  });
});
