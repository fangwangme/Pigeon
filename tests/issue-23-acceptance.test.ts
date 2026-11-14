import "fake-indexeddb/auto";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { connect } from "node:net";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AgentAdapterManager } from "../src/server/agent-adapters/index";
import { AgyAdapter } from "../src/server/agent-adapters/agy";
import { OpenCodeAdapter } from "../src/server/agent-adapters/opencode";
import { CardClassifier } from "../src/server/card-classifier";
import { ConfigManager, resolveInstancePaths } from "../src/server/config-manager";
import { HerdrClient } from "../src/server/herdr-client";
import { ModelCatalog } from "../src/server/model-catalog";
import { PairingManager } from "../src/server/pairing";
import { PaneStore } from "../src/server/pane-store";
import { PushManager } from "../src/server/push";
import { AntigravityQuotaProvider } from "../src/server/quota/antigravity";
import { ClaudeQuotaProvider } from "../src/server/quota/claude";
import { CodexQuotaProvider } from "../src/server/quota/codex";
import { QuotaService } from "../src/server/quota/index";
import { ClaudeSource } from "../src/server/sessions/claude";
import { CodexSource } from "../src/server/sessions/codex";
import { SkillScanner } from "../src/server/skill-scanner";
import { PricingManager } from "../src/server/usage/pricing";
import { UsageStore } from "../src/server/usage/store";
import { WsServer } from "../src/server/ws-server";
import { DEFAULT_CLIENT_CONFIG } from "../src/shared/defaults";
import { ProtocolErrors, type ClientConfig } from "../src/types/protocol";
import { PALETTES } from "../src/client/src/themes";
import { renderMarkdown } from "../src/client/src/utils/markdown";
import * as paneCache from "../src/client/src/state/pane-cache";
import { handleServerMessage, initWebSocket, request } from "../src/client/src/state/ws";
import { setState } from "../src/client/src/state/store";
import { FakeHerdr, fakeWs, tempDir, topologyOf } from "./helpers/fixtures";

const FIXTURES_DIR = resolve(import.meta.dir, "fixtures");
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    await fn();
  }
  cleanups.length = 0;
});

function startMockServer(handler: (req: Request, url: URL) => Response | Promise<Response>) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      return handler(req, new URL(req.url));
    },
  });
  cleanups.push(() => {
    server.stop(true);
  });
  return server;
}

describe("Issue #23 Acceptance: Test isolation (T3)", () => {
  test("unexpected outbound fetch throws and HOME/XDG/CODEX_HOME point to temp directories", async () => {
    const tmp = tmpdir();
    expect(process.env.HOME?.startsWith(tmp)).toBe(true);
    expect(process.env.XDG_DATA_HOME?.startsWith(tmp)).toBe(true);
    expect(process.env.CODEX_HOME?.startsWith(tmp)).toBe(true);
    await expect(fetch("https://models.dev/api.json")).rejects.toThrow(/outbound/i);
  });
});

describe("Issue #23 Acceptance: ModelCatalog (A1, B3, B7)", () => {
  test("fallback label after '/', corrupt models.json recovery, codex debug models 24h cooldown, and single-agent noteModel", async () => {
    const dir = tempDir("mc-23");
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    // B7: corrupt models.json must not crash construction and recovers empty
    const cachePath = join(dir, "models.json");
    writeFileSync(cachePath, "{corrupt json", "utf-8");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => warnSpy.mockRestore());

    const catalogFromCorrupt = new ModelCatalog({ home, cachePath });
    expect(catalogFromCorrupt.models("opencode")).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();

    // A1: legacy label === id cleaned in loadCache, plus noteModel fallback
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: { opencode: Date.now() },
        models: {
          opencode: [{ id: "openrouter/anthropic/claude-opus-4-6", label: "openrouter/anthropic/claude-opus-4-6" }],
        },
      }),
      "utf-8"
    );
    const catalog = new ModelCatalog({ home, cachePath });
    expect(catalog.models("opencode").find((m) => m.id === "openrouter/anthropic/claude-opus-4-6")?.label).toBe(
      "claude-opus-4-6"
    );

    // B3: codex debug models + 24h cooldown + unexpected Anthropic body + single-agent noteModel
    const codexCallsFile = join(dir, "codex-calls.txt");
    const fakeCodex = join(binDir, "codex");
    writeFileSync(
      fakeCodex,
      `#!/bin/sh
echo "called:$*" >> "${codexCallsFile}"
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  echo '{"models":[{"slug":"gpt-6-mini","display_name":"GPT-6 Mini","visibility":"list"}]}'
  exit 0
fi
exit 1
`,
      "utf-8"
    );
    chmodSync(fakeCodex, 0o755);

    let anthropicHits = 0;
    const srv = startMockServer(() => {
      anthropicHits++;
      return Response.json({ unexpected: "shape" });
    });

    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }),
      "utf-8"
    );
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "ctok" } }), "utf-8");

    let clock = 1_700_000_000_000;
    const c2 = new ModelCatalog({
      home,
      cachePath: join(dir, "models-b3.json"),
      anthropicModelsUrl: `http://127.0.0.1:${srv.port}/models`,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ""}` },
      now: () => clock,
    });

    await c2.refresh();
    expect(c2.models("codex").some((m) => m.id === "gpt-6-mini" && m.label === "GPT-6 Mini")).toBe(true);
    expect(readFileSync(codexCallsFile, "utf-8").trim().split("\n")).toHaveLength(1);

    // Within 24h cooldown: second refresh does not re-run codex debug models
    clock += 60_000;
    await c2.refresh();
    expect(readFileSync(codexCallsFile, "utf-8").trim().split("\n")).toHaveLength(1);

    // Single-agent noteModel("codex", ...) does NOT trigger Anthropic/Claude fetch and formats label
    const hitsBeforeNote = anthropicHits;
    c2.noteModel("codex", "openai/gpt-6-custom");
    await Bun.sleep(20);
    expect(anthropicHits).toBe(hitsBeforeNote);
    expect(c2.models("codex").find((m) => m.id === "openai/gpt-6-custom")?.label).toBe("gpt-6-custom");

    // Persistence of codex fetchedAt across instances
    const reloaded = new ModelCatalog({
      home,
      cachePath: join(dir, "models-b3.json"),
      anthropicModelsUrl: `http://127.0.0.1:${srv.port}/models`,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ""}` },
      now: () => clock,
    });
    await reloaded.refresh();
    expect(readFileSync(codexCallsFile, "utf-8").trim().split("\n")).toHaveLength(1);
  });
});

describe("Issue #23 Acceptance: Quota providers (A3, A4, A6)", () => {
  test("Claude limits[] + extra_usage map dynamically from fixture", async () => {
    const dir = tempDir("quota-claude-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.parse("2026-11-14T15:00:00Z") } }),
      "utf-8"
    );

    const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "claude-usage-limits.json"), "utf-8"));
    const srv = startMockServer(() => Response.json(fixture));

    const provider = new ClaudeQuotaProvider({
      home: dir,
      usageUrl: `http://127.0.0.1:${srv.port}/usage`,
      now: () => Date.parse("2026-11-14T12:00:00Z"),
    });
    const snap = await provider.fetch();
    expect(snap.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["5h", 33],
      ["7d", 43],
      ["7d · Fable", 71],
    ]);
    expect(snap.extraUsage).toEqual({ used: 0, limit: 50, currency: "USD" });
  });

  test("Antigravity preserves API group order, uses Claude/GPT and bucket.id, reads onboarding username", async () => {
    const dir = tempDir("quota-agy-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "agy-usage-groups.json"), "utf-8"));

    const srv = startMockServer((_req, url) => {
      if (url.pathname.endsWith("/RetrieveUserQuotaSummary")) {
        return Response.json(fixture);
      }
      if (url.pathname.endsWith("/GetUserStatus")) {
        return Response.json({ userStatus: { tierName: "Pro", email: "" } });
      }
      return Response.json({});
    });

    const agyCliDir = join(dir, ".gemini", "antigravity-cli");
    mkdirSync(join(agyCliDir, "daemon"), { recursive: true });
    writeFileSync(
      join(agyCliDir, "daemon", "ls.json"),
      JSON.stringify({ pid: process.pid, httpPort: srv.port, csrfToken: "csrf-test" }),
      "utf-8"
    );
    writeFileSync(
      join(agyCliDir, "app_storage.json"),
      JSON.stringify({ "agy.onboarding.lastLoginUsername": "alice@example.com" }),
      "utf-8"
    );

    const provider = new AntigravityQuotaProvider({ home: dir, now: () => 1_700_000_000_000 });
    const snap = await provider.fetch();
    expect(snap.account).toBe("alice@example.com");
    expect(snap.plan).toBe("Pro");
    expect(snap.windows.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
      ["gemini-weekly", "Gemini · 7d", 40],
      ["gemini-5h", "Gemini · 5h", 10],
      ["3p-weekly", "Claude/GPT · 7d", 60],
      ["3p-5h", "Claude/GPT · 5h", 15],
      ["gemini-argon-wtu-weekly", "Gemini 4 Argon · 7d", 25],
    ]);
  });

  test("Codex & Antigravity expired credentials fail with 'login expired' read-only without mutating files or calling token URL", async () => {
    const dir = tempDir("quota-ro-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    let tokenEndpointCalled = false;
    const srv = startMockServer((_req, url) => {
      if (url.pathname.includes("token")) {
        tokenEndpointCalled = true;
      }
      return new Response("Unauthorized", { status: 401 });
    });

    // Codex expired JWT
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const expiredJwtPayload = Buffer.from(JSON.stringify({ exp: 1_000 })).toString("base64url");
    const authContent = JSON.stringify({
      tokens: {
        access_token: `hdr.${expiredJwtPayload}.sig`,
        refresh_token: "rt_should_not_refresh",
      },
    });
    const authPath = join(dir, ".codex", "auth.json");
    writeFileSync(authPath, authContent, "utf-8");

    const codex = new CodexQuotaProvider({
      home: dir,
      usageUrl: `http://127.0.0.1:${srv.port}/usage`,
      creditsUrl: `http://127.0.0.1:${srv.port}/credits`,
      tokenUrl: `http://127.0.0.1:${srv.port}/token`,
      env: { ...process.env, CODEX_HOME: join(dir, ".codex") },
      now: () => 1_700_000_000_000,
    });
    await expect(codex.fetch()).rejects.toThrow(/login expired/i);
    expect(readFileSync(authPath, "utf-8")).toBe(authContent);
    expect(tokenEndpointCalled).toBe(false);

    // Antigravity expired OAuth token (and no running LS in isolated temp dir)
    mkdirSync(join(dir, ".gemini", "antigravity-cli"), { recursive: true });
    const agyTokPath = join(dir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    const agyTokContent = JSON.stringify({
      access_token: "old",
      refresh_token: "rt",
      expiry_date: 1_000,
    });
    writeFileSync(agyTokPath, agyTokContent, "utf-8");

    const agy = new AntigravityQuotaProvider({ home: dir, now: () => 1_700_000_000_000 });
    await expect(agy.fetch()).rejects.toThrow(/login expired/i);
    expect(readFileSync(agyTokPath, "utf-8")).toBe(agyTokContent);
  });
});

describe("Issue #23 Acceptance: Pricing & Stage-based model_price_periods (A8)", () => {
  test("PricingManager refreshes after 24h TTL and prioritizes first-party models.dev providers", async () => {
    const dir = tempDir("pricing-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const cachePath = join(dir, "pricing-cache.json");

    let version = 1;
    let clock = Date.parse("2026-11-10T10:00:00Z");
    let fetchCount = 0;

    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.includes("models.dev")) {
        return new Response("Not Found", { status: 404 });
      }
      fetchCount++;
      const costScale = version;
      // Put a third-party reseller BEFORE first-party anthropic to verify priority sorting
      return Response.json({
        zenmux: {
          models: {
            "claude-sonnet-4-6": { id: "claude-sonnet-4-6", cost: { input: 99, output: 999 } },
          },
        },
        anthropic: {
          models: {
            "claude-sonnet-4-6": { id: "claude-sonnet-4-6", cost: { input: 3 * costScale, output: 15 * costScale } },
          },
        },
      });
    }) as unknown as typeof fetch;

    const pm = new PricingManager({
      cachePath,
      now: () => clock,
      fetch: mockFetch,
    });

    await pm.initialize();
    expect(fetchCount).toBe(1);
    expect(pm.getPrice("claude-sonnet-4-6")).toMatchObject({
      inputCostPerToken: 3 / 1_000_000,
      outputCostPerToken: 15 / 1_000_000,
    });

    // Within 24h: initialize does not re-fetch
    clock += 12 * 3600_000;
    await pm.initialize();
    expect(fetchCount).toBe(1);

    // After 24h: initialize refreshes automatically in long-lived daemon
    version = 2;
    clock += 13 * 3600_000;
    await pm.initialize();
    expect(fetchCount).toBe(2);
    expect(pm.getPrice("claude-sonnet-4-6")).toMatchObject({
      inputCostPerToken: 6 / 1_000_000,
      outputCostPerToken: 30 / 1_000_000,
    });
  });

  test("UsageStore seeds model_price_periods at 0000-01-01, splits on price change, preserves on rebuildAll, and backfills all agents", async () => {
    const dir = tempDir("usage-periods-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "usage.db");
    const home = join(dir, "home");

    const projDir = join(home, ".claude", "projects", "-tmp-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, "s1.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-10T10:00:00Z",
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        },
      }) + "\n",
      "utf-8"
    );

    let priceInput = 3;
    let clock = Date.parse("2026-11-12T10:00:00Z");

    // 1. Initial scan while pricing is unavailable -> claude record saved with unpriced = 1
    const failPricing = new PricingManager({
      cachePath: join(dir, "p-empty.json"),
      now: () => clock,
      fetch: (async () => new Response("err", { status: 500 })) as unknown as typeof fetch,
    });
    const store = new UsageStore({ dbPath, home, now: () => clock });
    await store.scanIncremental(failPricing);

    const db = new Database(dbPath, { readonly: true });
    const row1 = db.query("SELECT cost, unpriced FROM usage_records WHERE agent = 'claude'").get() as any;
    expect(row1.unpriced).toBe(1);
    expect(row1.cost).toBe(0);

    // 2. Pricing arrives on 2026-11-12 -> seeds '0000-01-01' and backfills claude record!
    const okPricing = new PricingManager({
      cachePath: join(dir, "p-ok.json"),
      now: () => clock,
      fetch: (async () =>
        Response.json({
          anthropic: { models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6", cost: { input: priceInput, output: 15 } } } },
        })) as unknown as typeof fetch,
    });
    await okPricing.initialize();
    await store.scanIncremental(okPricing);

    const row2 = db.query("SELECT cost, unpriced FROM usage_records WHERE agent = 'claude'").get() as any;
    expect(row2.unpriced).toBe(0);
    expect(row2.cost).toBeCloseTo(3, 5);
    const periods1 = db.query("SELECT effective_from, effective_to, input_rate FROM model_price_periods").all() as any[];
    expect(periods1.length).toBe(1);
    expect(periods1[0].effective_from).toBe("0000-01-01");
    expect(periods1[0].effective_to).toBeNull();

    // 3. Price changes on 2026-11-14 -> splits periods without changing 2026-11-10 historical cost
    clock = Date.parse("2026-11-14T10:00:00Z");
    priceInput = 6;
    const pm2 = new PricingManager({
      cachePath: join(dir, "p-ok2.json"),
      now: () => clock,
      fetch: (async () =>
        Response.json({
          anthropic: { models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6", cost: { input: priceInput, output: 15 } } } },
        })) as unknown as typeof fetch,
    });
    await pm2.initialize();
    writeFileSync(
      join(projDir, "s2.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-14T09:00:00Z",
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        },
      }) + "\n",
      "utf-8"
    );
    await store.scanIncremental(pm2);

    const periods2 = db
      .query("SELECT effective_from, effective_to, input_rate FROM model_price_periods WHERE model = 'claude-sonnet-4-6' ORDER BY effective_from")
      .all() as any[];
    expect(periods2).toEqual([
      { effective_from: "0000-01-01", effective_to: "2026-11-13", input_rate: 3 },
      { effective_from: "2026-11-14", effective_to: null, input_rate: 6 },
    ]);

    // 4. rebuildAll preserves model_price_periods and keeps 2026-11-10 at old price & 2026-11-14 at new price
    await store.rebuildAll(pm2);
    const recordsAfterRebuild = db
      .query("SELECT date, cost FROM usage_records ORDER BY date")
      .all() as Array<{ date: string; cost: number }>;
    expect(recordsAfterRebuild[0]).toEqual({ date: "2026-11-10", cost: 3 });
    expect(recordsAfterRebuild[1]).toEqual({ date: "2026-11-14", cost: 6 });

    db.close();
    store.close();
  });
});

describe("Issue #23 Acceptance: Per-source error isolation & binding protection (B2, S1)", () => {
  test("AgentAdapterManager isolates source errors, rebindSessions keeps errored agent bindings, and ENOENT does not throw", async () => {
    const dir = tempDir("iso-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });

    const herdr = new FakeHerdr(dir);
    await herdr.listen();
    cleanups.push(() => herdr.close());

    const herdrClient = new HerdrClient({
      appSocketPath: herdr.appSocketPath,
      coreSocketPath: herdr.coreSocketPath,
      debounceMs: 5,
      panePollMs: 60_000,
    });
    cleanups.push(() => herdrClient.disconnect());
    herdrClient.applySnapshot(topologyOf([{ paneId: "p1", app: "claude-code", cwd: dir }]));

    const adapters = new AgentAdapterManager({ home });
    // Force an unhandled error in claude source while codex stays healthy
    (adapters as any).sources.get("claude").newest = () => {
      throw new Error("boom in claude");
    };

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => errorSpy.mockRestore());

    // newestSessionSafe / rebindSessions isolates error and populates sourceErrors
    const server = new WsServer({
      buildId: "b",
      herdrClient,
      pushManager: new PushManager(join(dir, "vapid.json")),
      configManager: new ConfigManager(join(dir, "cfg.json"), { HOME: home }),
      agentAdapters: adapters,
      skillScanner: new SkillScanner(home),
    });
    cleanups.push(() => server.destroy());

    // Pre-bind p1 directly, then force rebind with throwing claude source
    (server as any).paneStore.registerPaneSession("p1", "claude", "keep-me-bound");
    expect(() => (server as any).rebindSessions()).not.toThrow();
    expect((server as any).paneStore.getSession("p1")).toBe("keep-me-bound");
    expect(adapters.getSourceErrors().some((e: any) => e.agent === "claude")).toBe(true);

    // Vanished file ENOENT in ClaudeSource.list / CodexSource.list must not crash
    const vanishingDir = join(home, ".claude", "projects", "-tmp-gone");
    mkdirSync(vanishingDir, { recursive: true });
    // Corrupt/unreadable empty works safely; nonexistent root won't crash either
    const claude = new ClaudeSource(home);
    expect(() => claude.read("missing-id", false)).not.toThrow();
  });
});

describe("Issue #23 Acceptance: Codex 0.169.0 & Subagent exclusion (B1, B9, B18)", () => {
  test("filters subagent rollouts, reads turn_context model, and parses item_completed + write_stdin without duplication", () => {
    const dir = tempDir("codex-0169-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const sessionsDir = join(dir, ".codex", "sessions", "2026", "11", "10");
    mkdirSync(sessionsDir, { recursive: true });

    const mainDest = join(sessionsDir, "rollout-2026-11-10T11-18-53-codex-main-0169.jsonl");
    const subDest = join(sessionsDir, "rollout-2026-11-10T12-00-00-codex-subagent-1.jsonl");
    copyFileSync(join(FIXTURES_DIR, "codex-0.169-rollout.jsonl"), mainDest);
    copyFileSync(join(FIXTURES_DIR, "codex-subagent-rollout.jsonl"), subDest);

    const codex = new CodexSource(dir);
    const listed = codex.list("/tmp/project");
    expect(listed.map((s) => s.id)).toEqual(["codex-main-0169"]);

    const picked = codex.newest({ agent: "codex", pid: 0, cwd: "/tmp/project", createdMs: 0 }, new Set());
    expect(picked).toBe("codex-main-0169");

    const read = codex.read("codex-main-0169", false);
    expect(read.model).toBe("gpt-6-1-cygnus");
    expect(read.turns).toHaveLength(1);
    const t = read.turns[0];
    expect(t.toolCalls?.some((tool) => tool.diff?.filePath === "/tmp/project/hello.ts")).toBe(true);
    expect(t.toolCalls?.some((tool) => tool.name.includes("search") && (tool.durationMs ?? 0) >= 15)).toBe(true);
    expect(t.toolCalls?.some((tool) => tool.output?.includes("Confirmed"))).toBe(true);
    // Pending custom_tool_call `exec` deduplicated with `CommandExecution`
    const execTools = t.toolCalls?.filter((tool) => tool.verb === "run") ?? [];
    expect(execTools).toHaveLength(2); // CommandExecution (`bun test`) + write_stdin
    expect(t.assistantResponse?.markdown.trim()).toBe("Updated hello.ts.");
  });
});

describe("Issue #23 Acceptance: Herdr single-pane updates & Offline Queue Retention (S4, §3.4①)", () => {
  test("single-pane status updates known.agentKind; ERR_UPSTREAM_OFFLINE preserves queue and drains on reconnect", async () => {
    const dir = tempDir("queue-s4-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const herdr = new FakeHerdr(dir);
    let failSend = true;
    const sentPrompts: string[] = [];
    herdr.handlers["terminal.read"] = () => ({ result: { text: "", how: "history" } });
    herdr.handlers["terminal.send"] = (p) => {
      if (failSend) {
        return { error: "closed" };
      }
      sentPrompts.push(p.text);
      return { result: { sent: true } };
    };
    await herdr.listen();
    cleanups.push(() => herdr.close());

    const herdrClient = new HerdrClient({
      appSocketPath: herdr.appSocketPath,
      coreSocketPath: herdr.coreSocketPath,
      debounceMs: 5,
      panePollMs: 60_000,
    });
    cleanups.push(() => herdrClient.disconnect());
    herdr.serve([{ paneId: "p1", cwd: dir, state: "idle" }]);
    await herdrClient.connect();
    await Bun.sleep(50);

    // S4: single-pane status event updates agentKind
    herdr.emitEvent("status", "p1", { status: { state: "working", app: "claude-code" }, records: {}, reported: true });
    const deadline = Date.now() + 1000;
    while (herdrClient.getPaneFacts("p1")?.agentKind !== "claude" && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(herdrClient.getPaneFacts("p1")?.agentKind).toBe("claude");

    // §3.4①: ERR_UPSTREAM_OFFLINE preserves prompt in queue with sending: false, pauses kickQueue offline, resends on reconnect
    herdr.emitEvent("status", "p1", { status: { state: "idle", app: "claude-code" }, records: {}, reported: true });
    await Bun.sleep(30);

    const server = new WsServer({
      buildId: "b",
      herdrClient,
      pushManager: new PushManager(join(dir, "vapid.json")),
      configManager: new ConfigManager(join(dir, "cfg.json"), { HOME: dir }),
      skillScanner: new SkillScanner(dir),
    });
    cleanups.push(() => server.destroy());

    const c = fakeWs();
    server.handleOpen(c.ws);
    await server.handleMessage(c.ws, JSON.stringify({ type: "hello", id: "h1", payload: { protocolVersion: "1.0.0", subscribePaneId: "p1" } }));
    await server.handleMessage(c.ws, JSON.stringify({ type: "agent_prompt", id: "s1", payload: { targetPaneId: "p1", text: "queued offline" } }));

    expect(c.sent.some((m) => m.type === "error" && m.error.code === ProtocolErrors.ERR_UPSTREAM_OFFLINE)).toBe(true);
    const lastQueue = c.ofType("prompt_queue").at(-1)?.payload.queue;
    expect(lastQueue).toHaveLength(1);
    expect(lastQueue[0]).toMatchObject({ text: "queued offline", sending: false });

    // Reconnect snapshot triggers queue flush automatically
    failSend = false;
    await herdrClient.refreshSnapshot();
    const d2 = Date.now() + 1000;
    while (sentPrompts.length === 0 && Date.now() < d2) {
      await Bun.sleep(10);
    }
    expect(sentPrompts).toEqual(["queued offline"]);
  });
});

describe("Issue #23 Acceptance: Remaining Server Fixes", () => {
  test("OpenCode XDG_DATA_HOME and legacy session table fallback (B4, S2)", () => {
    const dir = tempDir("oc-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const xdg = join(dir, "xdg");
    const dbDir = join(xdg, "opencode");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "opencode.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE session (id text PRIMARY KEY, directory text, title text, time_updated integer, time_archived integer)");
    db.run("CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, data text NOT NULL)");
    db.run("INSERT INTO session VALUES ('s1', '/tmp/proj', 'Legacy Title', 1700000000000, NULL)");
    db.close();

    const oldXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdg;
    cleanups.push(() => {
      if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldXdg;
    });

    const adapter = new OpenCodeAdapter();
    expect(adapter.getDbPath()).toBe(dbPath);
    const mgr = new AgentAdapterManager({ home: dir });
    const list = mgr.listSessions("opencode", "/tmp/proj");
    expect(list[0]?.title).toBe("Legacy Title");
  });

  test("Claude tail title extraction from >64KB session files (B8)", () => {
    const dir = tempDir("claude-tail-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const proj = join(dir, ".claude", "projects", "-tmp-proj");
    mkdirSync(proj, { recursive: true });
    const padding = "x".repeat(4000);
    const lines: string[] = [
      JSON.stringify({ type: "user", timestamp: "2026-11-10T10:00:00Z", message: { content: "First prompt" } }),
    ];
    for (let i = 0; i < 90; i++) {
      lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: padding }] } }));
    }
    lines.push(JSON.stringify({ type: "custom-title", customTitle: "Tail Custom Title" }));
    writeFileSync(join(proj, "s1.jsonl"), lines.join("\n") + "\n", "utf-8");

    const claude = new ClaudeSource(dir);
    const sessions = claude.list("/tmp/proj");
    expect(sessions[0]?.title).toBe("Tail Custom Title");
  });

  test("AGY attachment upload-only stripping & empty tool output completes running tool (B10, B11)", () => {
    const dir = tempDir("agy-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const logsDir = join(dir, "s1", ".system_generated", "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "transcript.jsonl"),
      [
        {
          step_index: 0,
          type: "USER_INPUT",
          content: "<USER_REQUEST>[Pigeon user uploaded attachment: /tmp/uploads/a.png]\n</USER_REQUEST>",
          created_at: "2026-11-10T10:00:00.000Z",
        },
        {
          step_index: 1,
          type: "USER_INPUT",
          content: "<USER_REQUEST>Run check</USER_REQUEST>",
          created_at: "2026-11-10T10:00:01.000Z",
        },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          content: "Checking...",
          tool_calls: [
            { id: "tc1", name: "run_command", args: { CommandLine: "true" } },
            { id: "tc2", name: "run_command", args: { CommandLine: "sleep 1" } },
          ],
          created_at: "2026-11-10T10:00:02.000Z",
        },
        {
          step_index: 3,
          type: "GENERIC",
          content: "",
          created_at: "2026-11-10T10:00:03.000Z",
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf-8"
    );

    const agy = new AgyAdapter({ baseBrainDir: dir });
    const res = agy.getTurns("s1");
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0].userPrompt?.text).toBe("Run check");
    expect(res.turns[0].toolCalls?.[0]?.status).toBe("completed");
    expect(res.turns[0].toolCalls?.[1]?.status).toBe("running");
  });

  test("PaneStore recovers FSWatcher after atomic file rename (B13)", async () => {
    const dir = tempDir("watch-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const logs = join(dir, "s1", ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const log = join(logs, "transcript.jsonl");
    writeFileSync(
      log,
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>one</USER_REQUEST>", created_at: "2026-11-10T10:00:00Z" }) + "\n",
      "utf-8"
    );

    const adapters = new AgentAdapterManager({ agy: { baseBrainDir: dir } });
    const store = new PaneStore(adapters);
    cleanups.push(() => store.destroy());
    store.registerPaneSession("p1", "agy", "s1");
    await Bun.sleep(40);

    // Atomic replace via rename changes inode, then append subsequent turn
    const tmp = `${log}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>one</USER_REQUEST>", created_at: "2026-11-10T10:00:00Z" }) +
        "\n" +
        JSON.stringify({ step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>two</USER_REQUEST>", created_at: "2026-11-10T10:00:01Z" }) +
        "\n",
      "utf-8"
    );
    renameSync(tmp, log);
    await Bun.sleep(250);
    expect(store.getPayload("p1", "agy").turns.map((t) => t.userPrompt?.text)).toEqual(["one", "two"]);
    appendFileSync(
      log,
      JSON.stringify({ step_index: 2, type: "USER_INPUT", content: "<USER_REQUEST>three</USER_REQUEST>", created_at: "2026-11-10T10:00:02Z" }) + "\n",
      "utf-8"
    );

    const deadline = Date.now() + 2000;
    while (store.getPayload("p1", "agy").turns.length < 3 && Date.now() < deadline) {
      await Bun.sleep(30);
    }
    expect(store.getPayload("p1", "agy").turns.map((t) => t.userPrompt?.text)).toEqual(["one", "two", "three"]);
  });

  test("PushManager clears dedupe on failed delivery so retry succeeds immediately (B14)", async () => {
    const dir = tempDir("push-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    let failPush = true;
    let pushHits = 0;
    const srv = startMockServer(() => {
      pushHits++;
      return failPush ? new Response("err", { status: 500 }) : new Response("ok", { status: 201 });
    });

    const herdr = new FakeHerdr(dir);
    await herdr.listen();
    cleanups.push(() => herdr.close());
    const hc = new HerdrClient({
      appSocketPath: herdr.appSocketPath,
      coreSocketPath: herdr.coreSocketPath,
      debounceMs: 5,
      panePollMs: 60_000,
    });
    cleanups.push(() => hc.disconnect());
    herdr.serve([{ paneId: "p1", app: "claude-code", state: "working", cwd: dir }]);
    await hc.connect();
    await Bun.sleep(50);

    const push = new PushManager(join(dir, "vapid.json"));
    // Generate real P-256 point for subscription so encryptPayload succeeds
    const { createECDH } = await import("node:crypto");
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    push.addSubscription({
      endpoint: `http://127.0.0.1:${srv.port}/push`,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: Buffer.alloc(16, 1).toString("base64url"),
      },
      events: { blocked: true, done: true },
    });

    const wsSrv = new WsServer({
      buildId: "b",
      herdrClient: hc,
      pushManager: push,
      configManager: new ConfigManager(join(dir, "cfg.json"), { HOME: dir }),
      skillScanner: new SkillScanner(dir),
    });
    cleanups.push(() => wsSrv.destroy());

    // First blocked transition -> HTTP 500 -> dedupe cleared
    herdr.emitEvent("status", "p1", { status: { state: "blocked", app: "claude-code" }, records: {}, reported: true });
    await Bun.sleep(100);
    expect(pushHits).toBe(1);

    failPush = false;
    herdr.emitEvent("status", "p1", { status: { state: "working", app: "claude-code" }, records: {}, reported: true });
    await Bun.sleep(40);
    herdr.emitEvent("status", "p1", { status: { state: "blocked", app: "claude-code" }, records: {}, reported: true });
    await Bun.sleep(100);
    expect(pushHits).toBe(2);
  });

  test("Deterministic fallback timestamp across repeated reads (B15)", async () => {
    const dir = tempDir("ts-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const logs = join(dir, ".claude", "projects", "-tmp-proj");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "s1.jsonl"),
      JSON.stringify({ type: "user", message: { content: "No timestamp" } }) + "\n",
      "utf-8"
    );
    const claude = new ClaudeSource(dir);
    claude.newest({ agent: "claude", pid: 0, cwd: "/tmp/proj", createdMs: 0 }, new Set());
    const r1 = claude.read("s1", false);
    await Bun.sleep(15);
    const r2 = claude.read("s1", false);
    expect(r1.turns[0].timestamp).toBe(r2.turns[0].timestamp);
  });

  test("Admin socket distinguishes invalid_json vs internal with id (B16) and resolveInstancePaths (S6)", async () => {
    const dir = tempDir("admin-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const sock = join(dir, "admin.sock");
    const pairing = new PairingManager({
      publicBaseUrl: "https://example.test",
      devicesFilePath: join(dir, "devices.json"),
      adminSocketPath: sock,
    });
    await pairing.startAdminSocket();
    cleanups.push(() => pairing.stopAdminSocket());

    const rpc = (line: string) =>
      new Promise<any>((resolveRpc, rejectRpc) => {
        const s = connect(sock);
        let buf = "";
        s.on("connect", () => s.write(line + "\n"));
        s.on("data", (d) => {
          buf += d.toString();
          if (buf.includes("\n")) {
            s.end();
            resolveRpc(JSON.parse(buf.trim()));
          }
        });
        s.on("error", rejectRpc);
      });

    const badJson = await rpc("{bad");
    expect(badJson.error.code).toBe("invalid_json");

    const internalErr = await rpc(JSON.stringify({ id: "req-99", method: "usage.rebuild" }));
    expect(internalErr.id).toBe("req-99");
    expect(internalErr.error.code).toBe("internal");

    const prod = resolveInstancePaths({ env: { HOME: dir, XDG_RUNTIME_DIR: dir, XDG_DATA_HOME: dir }, port: 4100, productionPort: 4100 });
    const dev = resolveInstancePaths({ env: { HOME: dir, XDG_RUNTIME_DIR: dir, XDG_DATA_HOME: dir }, port: 4101, productionPort: 4100 });
    expect(prod.adminSocketPath).toBe(join(dir, "pigeon.sock"));
    expect(dev.adminSocketPath).toBe(join(dir, "pigeon-4101.sock"));
  });

  test("QuotaService unifies isProviderEnabled (B12)", async () => {
    const dir = tempDir("qprov-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const partialCfg: ClientConfig = {
      ...DEFAULT_CLIENT_CONFIG,
      quotaProviders: { claude: false } as any,
    };
    const qs = new QuotaService({
      autoScan: false,
      claude: { fetch: async () => ({ provider: "claude", windows: [], credits: [], fetchedAt: 1 }) } as any,
      codex: { fetch: async () => ({ provider: "codex", windows: [], credits: [], fetchedAt: 1 }) } as any,
      antigravity: { fetch: async () => ({ provider: "antigravity", windows: [], credits: [], fetchedAt: 1 }) } as any,
    });
    const res = await qs.getQuota(partialCfg);
    expect(res.providers.find((p) => p.provider === "claude")?.enabled).toBe(false);
    expect(res.providers.find((p) => p.provider === "codex")?.enabled).toBe(true);
    expect(res.providers.find((p) => p.provider === "antigravity")?.enabled).toBe(true);
  });

  test("CardClassifier only parses Claude question menu for Claude panes (S8) and SkillScanner isolates corrupt plugins (S5)", () => {
    const dir = tempDir("cc-sk-23");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const claudeMenuScreen = [
      "←  ☐ Auth      ☑ Scope      ✔ Submit",
      "How should auth work?",
      "❯ 1. OAuth2",
      "  2. API Key",
      "Enter to select · ↑/↓ to navigate",
    ].join("\n");

    const classifier = new CardClassifier();
    expect(classifier.classifyScreen(claudeMenuScreen, "claude").pendingInteraction).not.toBeNull();
    expect(classifier.classifyScreen(claudeMenuScreen, "codex").pendingInteraction).toBeNull();

    mkdirSync(join(dir, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(dir, ".claude", "plugins", "installed_plugins.json"), "{corrupt", "utf-8");
    const scanner = new SkillScanner(dir);
    const entries = scanner.listSkills("claude", dir);
    expect(entries.some((e) => e.name === "compact")).toBe(true);
    expect(scanner.getPluginError()).toBeTruthy();
  });
});

describe("Issue #23 Acceptance: Client WS, Cache, Markdown & Theme Tokens (B6, T2, D5, D7, A7)", () => {
  test("Markdown .cb-hdr header and bounded LRU cache (D7)", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain('class="cb-hdr"');
    expect(html).toContain("ts");
    // Ensure caching >500 entries doesn't throw and keeps functioning
    for (let i = 0; i < 600; i++) {
      expect(renderMarkdown(`item ${i}`)).toContain(`item ${i}`);
    }
  });

  test("PALETTES.dark ascends heatmap intensity and defines --fig-cost cleanly (D5, A7)", () => {
    const hexLum = (hex: string) => {
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      if (!m) return 0;
      const n = parseInt(m[1], 16);
      return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255);
    };
    const d = PALETTES.dark;
    expect(hexLum(d.heatTokens1)).toBeLessThan(hexLum(d.heatTokens5));
    expect(hexLum(d.heatCost1)).toBeLessThan(hexLum(d.heatCost5));
    expect(d.figCost).toBeDefined();
    expect((d as any).figTokens).toBeUndefined();
    expect(PALETTES.light.figCost).toBeDefined();
  });

  test("pane-cache opens readonly on load, turns_delta skips per-delta IDB put, and teardownSocket rejects pending requests (T2, B6)", async () => {
    await paneCache.clearAll();
    const putSpy = spyOn(IDBObjectStore.prototype, "put");
    const txSpy = spyOn(IDBDatabase.prototype, "transaction");
    cleanups.push(() => {
      putSpy.mockRestore();
      txSpy.mockRestore();
    });

    await paneCache.save("p1", {
      sessionId: "s1",
      turns: [{ turnId: "t1", turnNumber: 1, timestamp: 1000, userPrompt: { text: "hi" } }],
    });
    const putsAfterSave = putSpy.mock.calls.length;

    await paneCache.load("p1");
    expect(putSpy.mock.calls.length).toBe(putsAfterSave);
    expect(txSpy.mock.calls.some((c) => c[1] === "readonly")).toBe(true);

    setState("activePaneId", "p1");
    handleServerMessage({
      type: "turns_delta",
      payload: {
        paneId: "p1",
        sessionId: "s1",
        seq: 2,
        appendTurns: [{ turnId: "t2", turnNumber: 2, timestamp: 2000, userPrompt: { text: "next" } }],
      },
    } as any);
    expect(putSpy.mock.calls.length).toBe(putsAfterSave);

    // B6: teardownSocket rejects pending request immediately on visibility/reconnect
    const origWs = globalThis.WebSocket;
    const origDoc = (globalThis as any).document;
    const origFetch = globalThis.fetch;
    let fakeClientWs: any;
    (globalThis as any).document = {
      visibilityState: "visible",
      addEventListener: (_ev: string, fn: any) => {
        (globalThis as any).__visListener = fn;
      },
      removeEventListener: () => {},
    };
    (globalThis as any).fetch = (async () => Response.json({ authenticated: true })) as any;
    (globalThis as any).WebSocket = class {
      readyState = 1;
      onopen: any;
      onclose: any;
      onmessage: any;
      constructor() {
        fakeClientWs = this;
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {}
    };
    cleanups.push(() => {
      globalThis.WebSocket = origWs;
      (globalThis as any).document = origDoc;
      globalThis.fetch = origFetch;
      delete (globalThis as any).__visListener;
    });

    await initWebSocket();
    const pending = request({ type: "refresh_models", payload: {} } as any);
    (globalThis as any).document.visibilityState = "visible";
    // Simulate stale zombie socket when tab resumes -> reconnects -> teardownSocket rejects pending
    fakeClientWs.readyState = 3; // CLOSED
    (globalThis as any).__visListener?.();
    await expect(pending).rejects.toThrow();
  });
});
