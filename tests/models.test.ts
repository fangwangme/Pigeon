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

  test("resolve by id, by label (case-insensitive), and an unknown value passed through (herdr-adapter.md §7.1)", async () => {
    const { home, env } = agentHome();
    const catalog = new ModelCatalog({ home, env });
    await catalog.refresh();
    // codex has model { id: "gpt-a", label: "GPT A" }
    expect(catalog.resolve("codex", "gpt-a")).toBe("gpt-a");
    expect(catalog.resolve("codex", "GPT A")).toBe("gpt-a");
    expect(catalog.resolve("codex", "gpt a")).toBe("gpt-a");
    expect(catalog.resolve("codex", "unknown-model")).toBe("unknown-model");
  });

  test("an AGY session whose transcript switches to Gemini 3.8 Flash (Medium) reports resolved model id through PaneStore / getPayload", async () => {
    const { home, env } = agentHome();
    const catalog = new ModelCatalog({ home, env });
    (catalog as any).lists.set("agy", [
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    ]);
    const brain = join(home, ".gemini", "antigravity-cli", "brain");
    const logs = join(brain, "s_agy", ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "transcript.jsonl"),
      JSON.stringify({
        step_index: 0,
        type: "USER_SETTINGS_CHANGE",
        content: "The user changed setting `Model Selection` from `Gemini 2.5 Flash` to `Gemini 3.8 Flash (Medium)`.",
        created_at: new Date(1000).toISOString(),
      }) + "\n" +
      JSON.stringify({
        step_index: 1,
        type: "USER_INPUT",
        content: "test",
        created_at: new Date(2000).toISOString(),
      }) + "\n"
    );

    const adapters = new AgentAdapterManager({ agy: { baseBrainDir: brain } });
    const { PaneStore } = await import("../src/server/pane-store");
    const store = new PaneStore(adapters);
    store.setModelResolver((agent, val) => catalog.resolve(agent, val));
    store.registerPaneSession("p_agy", "agy", "s_agy");
    const payload = store.getPayload("p_agy", "agy");
    expect(payload.session.model).toEqual({ value: "gemini-3.8-flash-medium", source: "log" });
  });
});

// Issue #21: Claude from Anthropic's Models API, the daily limit and persistence, OpenCode labels and levels.
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const effort = (levels: string[]) => ({ supported: levels.length > 0, ...Object.fromEntries(LEVELS.map((l) => [l, { supported: levels.includes(l) }])) });

function claudeCredentials(home: string) {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "test-access-token", refreshToken: "test-refresh-token", expiresAt: Date.now() + 30 * 86_400_000 } })
  );
}

/** A local stand-in for `GET /v1/models` that records each request's auth headers. */
function modelsApi() {
  const requests: Array<{ authorization: string | null; beta: string | null; version: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      requests.push({ authorization: req.headers.get("authorization"), beta: req.headers.get("anthropic-beta"), version: req.headers.get("anthropic-version") });
      return Response.json({
        data: [
          { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-10-01T00:00:00Z", capabilities: { effort: effort(LEVELS) } },
          { type: "model", id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z", capabilities: { effort: effort([]) } },
        ],
        has_more: false,
        first_id: "claude-opus-5-5",
        last_id: "claude-haiku-4-5-20251001",
      });
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/v1/models`, requests };
}

/** A WsServer on `catalog`; `ask` sends `models_refresh` with the payload and waits for its ack. */
async function refreshServer(catalog: ModelCatalog, home: string) {
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
  const c = fakeWs("dev_refresh");
  server.handleOpen(c.ws);
  await server.handleMessage(c.ws, JSON.stringify({ type: "hello", id: "h", payload: { protocolVersion: "1.0.0", subscribePaneId: "p1" } }));
  let n = 0;
  const ask = async (payload: object) => {
    const id = `r${++n}`;
    await server.handleMessage(c.ws, JSON.stringify({ type: "models_refresh", id, payload }));
    expect(c.ofType("ack").find((a: any) => a.replyTo === id)).toBeDefined();
  };
  return { ask };
}

describe("Claude and OpenCode model sources (herdr-adapter.md §7.1, issue #21)", () => {
  test("claude models come from the Models API with labels and effort levels", async () => {
    const { home, env } = agentHome();
    claudeCredentials(home);
    const api = modelsApi();
    const catalog = new ModelCatalog({ home, env, keychain: false, anthropicModelsUrl: api.url, cachePath: join(home, "state", "models.json") });
    await catalog.refresh();
    expect(catalog.models("claude").map((m) => [m.id, m.label, m.thinkingLevels ?? []])).toEqual([
      ["claude-opus-5-5", "Claude Opus 5.5", LEVELS],
      ["claude-haiku-4-5-20251001", "Claude Haiku 4.5", []],
    ]);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0].authorization).toBe("Bearer test-access-token");
    expect(api.requests[0].beta ?? "").toContain("oauth-2025-04-20");
    expect(api.requests[0].version).toBe("2023-06-01");
  });

  test("the Claude list is fetched at most once a day automatically and persists", async () => {
    const { home, env } = agentHome();
    claudeCredentials(home);
    const api = modelsApi();
    let now = Date.UTC(2026, 10, 12, 9, 0, 0);
    const options = { home, env, keychain: false, anthropicModelsUrl: api.url, cachePath: join(home, "state", "models.json"), now: () => now };
    const catalog = new ModelCatalog(options);
    await catalog.refresh();
    await catalog.refresh();
    expect(api.requests).toHaveLength(1);

    const { ask } = await refreshServer(catalog, home);
    await ask({ agent: "codex" });
    expect(api.requests).toHaveLength(1);
    await ask({ agent: "claude" });
    expect(api.requests).toHaveLength(2);

    now += 25 * 3_600_000;
    await catalog.refresh();
    expect(api.requests).toHaveLength(3);

    // A restarted daemon lists the cached models before any request succeeds.
    const restarted = new ModelCatalog({ ...options, anthropicModelsUrl: "http://127.0.0.1:9/v1/models" });
    expect(restarted.models("claude").map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-haiku-4-5-20251001"]);
  });

  test("opencode labels and levels come from its models cache", async () => {
    const { home, env } = agentHome();
    mkdirSync(join(home, ".cache", "opencode"), { recursive: true });
    writeFileSync(
      join(home, ".cache", "opencode", "models.json"),
      JSON.stringify({
        anthropic: { id: "anthropic", models: { "claude-x": { id: "claude-x", name: "Claude X", reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high"] }] } } },
        openai: { id: "openai", models: { "gpt-y": { id: "gpt-y", name: "GPT Y", reasoning: false } } },
      })
    );
    const catalog = new ModelCatalog({ home, env, keychain: false, cachePath: join(home, "state", "models.json") });
    await catalog.refresh();
    expect(catalog.models("opencode").map((m) => [m.id, m.label, m.thinkingLevels ?? []])).toEqual([
      ["anthropic/claude-x", "Claude X", ["low", "high"]],
      ["openai/gpt-y", "GPT Y", []],
    ]);
  });

  test("opencode's last-used model and effort come from its state file; none without it (herdr-adapter.md §5)", () => {
    const { home, env } = agentHome();
    const catalog = new ModelCatalog({ home, env, keychain: false, cachePath: join(home, "state", "models.json") });
    expect(catalog.lastUsed("opencode")).toBeUndefined();
    mkdirSync(join(home, ".local", "state", "opencode"), { recursive: true });
    writeFileSync(
      join(home, ".local", "state", "opencode", "model.json"),
      JSON.stringify({ recent: [{ providerID: "nvidia", modelID: "z-ai/glm-5.3-flash" }, { providerID: "openai", modelID: "gpt-y" }], variant: { "nvidia/z-ai/glm-5.3-flash": "max" } })
    );
    expect(catalog.lastUsed("opencode")).toEqual({ model: "nvidia/z-ai/glm-5.3-flash", thinking: "max" });
    expect(catalog.lastUsed("claude")).toBeUndefined();
  });

  test("without Claude credentials no Claude model is listed, not even the CLI's aliases (herdr-adapter.md §7.1)", async () => {
    const { home, env } = agentHome();
    const catalog = new ModelCatalog({ home, env, keychain: false, cachePath: join(home, "state", "models.json") });
    await catalog.refresh();
    expect(catalog.models("claude")).toEqual([]);
  });

  test("opencode lists only the models `opencode models` offers (herdr-adapter.md §7.1)", async () => {
    const { home, env } = agentHome();
    mkdirSync(join(home, ".cache", "opencode"), { recursive: true });
    writeFileSync(
      join(home, ".cache", "opencode", "models.json"),
      JSON.stringify({
        anthropic: { id: "anthropic", models: { "claude-x": { id: "claude-x", name: "Claude X" }, "claude-unused": { id: "claude-unused", name: "Unused" } } },
        mistral: { id: "mistral", models: { "m-z": { id: "m-z", name: "M Z" } } },
      })
    );
    const catalog = new ModelCatalog({ home, env, keychain: false, cachePath: join(home, "state", "models.json") });
    await catalog.refresh();
    expect(catalog.models("opencode").map((m) => [m.id, m.label])).toEqual([
      ["anthropic/claude-x", "Claude X"],
      ["openai/gpt-y", "openai/gpt-y"],
    ]);
  });
});
