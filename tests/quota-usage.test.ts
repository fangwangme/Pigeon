import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigManager } from "../src/server/config-manager";
import { HerdrClient } from "../src/server/herdr-client";
import { PushManager } from "../src/server/push";
import { ClaudeQuotaProvider } from "../src/server/quota/claude";
import { QuotaService } from "../src/server/quota/index";
import { SkillScanner } from "../src/server/skill-scanner";
import { validateClientMessage } from "../src/server/ws-validate";
import { PricingManager } from "../src/server/usage/pricing";
import { scanAntigravityDb, scanOpenCodeDb } from "../src/server/usage/sources";
import { UsageService } from "../src/server/usage/index";
import { UsageStore } from "../src/server/usage/store";
import { WsServer } from "../src/server/ws-server";
import { quotaLevel, quotaPace } from "../src/shared/quota";
import { cacheHitPercent, comparisonRange, heatmapLayout, resolveRange } from "../src/shared/usage";
import { ProtocolErrors } from "../src/types/protocol";
import { FakeHerdr, fakeWs, tempDir, topologyOf } from "./helpers/fixtures";

// Issue #13. quota-and-usage.md §2.3–§2.5, §3.4–§3.6, §4; protocol.md §4.16, §6.3.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-09T09:33:00Z");

describe("quota pace and level (quota-and-usage.md §2.4)", () => {
  const win = (usedPercent: number, periodMs: number | null, remainingMs: number | null) => ({
    usedPercent,
    periodMs,
    resetsAt: remainingMs === null ? null : NOW + remainingMs,
  });

  test("ahead of the time-based expectation gives the deficit and the time until it runs out", () => {
    // 5h window, 2h57m left: 123 of 300 minutes passed, expected 41%.
    const pace = quotaPace(win(52, 5 * HOUR, 177 * MIN), NOW);
    expect(pace?.kind).toBe("ahead");
    expect(pace?.expectedPercent).toBeCloseTo(41, 5);
    expect(pace?.deficit).toBeCloseTo(11, 5);
    // (100 − 52) ÷ (52 ÷ 123min)
    expect(pace?.etaMs).toBeCloseTo((48 * 123 * MIN) / 52, -2);
  });

  test("within 5 points of the expectation is on track", () => {
    expect(quotaPace(win(44, 5 * HOUR, 177 * MIN), NOW)?.kind).toBe("on_track");
  });

  test("below the expectation is behind", () => {
    // weekly window, 4d15h left: 57 of 168 hours passed, expected about 34%.
    const pace = quotaPace(win(17, 7 * DAY, 4 * DAY + 15 * HOUR), NOW);
    expect(pace?.kind).toBe("behind");
    expect(pace?.etaMs).toBeUndefined();
  });

  test("no pace at 0% or 100%, or without a period or a reset time", () => {
    expect(quotaPace(win(0, 5 * HOUR, 5 * HOUR), NOW)).toBeNull();
    expect(quotaPace(win(100, 5 * HOUR, HOUR), NOW)).toBeNull();
    expect(quotaPace(win(30, null, HOUR), NOW)).toBeNull();
    expect(quotaPace(win(30, 5 * HOUR, null), NOW)).toBeNull();
  });

  test("level is normal below 80, warn from 80, exhausted at 100", () => {
    expect(quotaLevel(79.9)).toBe("normal");
    expect(quotaLevel(80)).toBe("warn");
    expect(quotaLevel(99.5)).toBe("warn");
    expect(quotaLevel(100)).toBe("exhausted");
  });
});

describe("usage ranges, comparison, layout and hit ratio (quota-and-usage.md §3.2, §3.4–§3.6)", () => {
  const TODAY = "2026-11-09"; // a Monday
  const FIRST = "2026-01-07";

  test("presets resolve to their documented dates", () => {
    const r = (preset: any, extra: object = {}) => resolveRange(preset, TODAY, { firstDay: FIRST, ...extra });
    expect(r("today")).toEqual({ from: TODAY, to: TODAY });
    expect(r("7d")).toEqual({ from: "2026-11-03", to: TODAY });
    expect(r("30d")).toEqual({ from: "2026-10-11", to: TODAY });
    expect(r("year")).toEqual({ from: "2026-01-01", to: TODAY });
    expect(r("all")).toEqual({ from: FIRST, to: TODAY });
    expect(r("custom", { from: "2026-10-31", to: "2026-10-01" })).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  test("today compares with the same weekday a week earlier up to the same time", () => {
    expect(comparisonRange({ from: TODAY, to: TODAY }, "today", TODAY, FIRST, 17 * 60 + 33)).toEqual({ from: "2026-11-02", to: "2026-11-02", untilMinutes: 17 * 60 + 33 });
  });

  test("a single past day compares with that weekday a week earlier, whole day", () => {
    expect(comparisonRange({ from: "2026-11-06", to: "2026-11-06" }, "custom", TODAY, FIRST, 600)).toEqual({ from: "2026-10-30", to: "2026-10-30", untilMinutes: null });
  });

  test("a period compares with the period of equal length just before it", () => {
    expect(comparisonRange({ from: "2026-11-03", to: TODAY }, "7d", TODAY, FIRST, 600)).toEqual({ from: "2026-10-27", to: "2026-11-02", untilMinutes: null });
  });

  test("year and all are not compared, nor a comparison that starts before the first day with usage", () => {
    expect(comparisonRange({ from: "2026-01-01", to: TODAY }, "year", TODAY, FIRST, 600)).toBeNull();
    expect(comparisonRange({ from: FIRST, to: TODAY }, "all", TODAY, FIRST, 600)).toBeNull();
    expect(comparisonRange({ from: "2026-10-11", to: TODAY }, "30d", TODAY, "2026-10-01", 600)).toBeNull();
  });

  test("heatmap orientation follows the range length", () => {
    expect(heatmapLayout({ from: "2026-11-03", to: TODAY })).toBe("strip");
    // Six Monday-based weeks (10-05 … 11-09).
    expect(heatmapLayout({ from: "2026-10-05", to: TODAY })).toBe("week-rows");
    // One day earlier reaches into a seventh week.
    expect(heatmapLayout({ from: "2026-10-04", to: TODAY })).toBe("week-columns");
    expect(heatmapLayout({ from: "2026-01-01", to: TODAY })).toBe("week-columns");
  });

  test("cache-hit ratio is cache read over total tokens", () => {
    expect(cacheHitPercent(9999, 10000)).toBe(99.99);
    expect(cacheHitPercent(500, 1000)).toBe(50);
    expect(cacheHitPercent(0, 0)).toBe(0);
  });
});

describe("claude quota provider (quota-and-usage.md §2.2, §2.3)", () => {
  let home: string;
  let credPath: string;
  let server: ReturnType<typeof Bun.serve>;
  let tokenCalls: number;
  let onToken: () => Response;
  let acceptedToken: string;
  const usageBody = {
    five_hour: { utilization: 52, resets_at: "2026-11-09T12:30:00Z" },
    seven_day: { utilization: 17, resets_at: "2026-11-14T00:30:00Z" },
  };

  const writeCreds = (accessToken: string, refreshToken: string, expiresAt: number) =>
    writeFileSync(
      credPath,
      JSON.stringify({
        claudeAiOauth: { accessToken, refreshToken, expiresAt, subscriptionType: "pro", scopes: ["user:inference"] },
        mcpOAuth: { keep: "me" },
      }),
    );
  const readCreds = () => JSON.parse(readFileSync(credPath, "utf-8"));

  beforeEach(() => {
    home = tempDir("quota-claude");
    mkdirSync(join(home, ".claude"), { recursive: true });
    credPath = join(home, ".claude", ".credentials.json");
    tokenCalls = 0;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/token") {
          tokenCalls++;
          return onToken();
        }
        if (url.pathname === "/usage") {
          if (req.headers.get("authorization") !== `Bearer ${acceptedToken}`) return new Response("{}", { status: 401 });
          return Response.json(usageBody);
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterEach(() => server.stop(true));

  const provider = () =>
    new ClaudeQuotaProvider({
      home,
      usageUrl: `http://127.0.0.1:${server.port}/usage`,
      tokenUrl: `http://127.0.0.1:${server.port}/token`,
      keychain: false,
      now: () => NOW,
    });

  test("claude usage windows: only the reported windows, with period, share and reset time; plan from the credential", async () => {
    writeCreds("live", "rt", NOW + HOUR);
    acceptedToken = "live";
    const snap = await provider().fetch();
    expect(snap.provider).toBe("claude");
    expect(snap.plan).toBe("pro");
    expect(snap.windows).toHaveLength(2);
    expect(snap.windows[0]).toMatchObject({ id: "five_hour", usedPercent: 52, periodMs: 5 * HOUR, resetsAt: Date.parse("2026-11-09T12:30:00Z") });
    expect(snap.windows[1]).toMatchObject({ id: "seven_day", usedPercent: 17, periodMs: 7 * DAY, resetsAt: Date.parse("2026-11-14T00:30:00Z") });
    expect(tokenCalls).toBe(0);
  });

  test("claude credential refresh: an expired token is refreshed once and written back with every other field kept", async () => {
    writeCreds("old", "rt-old", NOW - MIN);
    acceptedToken = "pigeon-new";
    onToken = () => Response.json({ access_token: "pigeon-new", refresh_token: "rt-pigeon", expires_in: 3600 });
    const snap = await provider().fetch();
    expect(snap.windows).toHaveLength(2);
    expect(tokenCalls).toBe(1);
    const stored = readCreds();
    expect(stored.claudeAiOauth).toMatchObject({ accessToken: "pigeon-new", refreshToken: "rt-pigeon", expiresAt: NOW + 3600 * 1000, subscriptionType: "pro", scopes: ["user:inference"] });
    expect(stored.mcpOAuth).toEqual({ keep: "me" });
  });

  test("claude credential refresh: when the agent rotated the file during the refresh, Pigeon keeps it and uses the agent's token", async () => {
    writeCreds("old", "rt-old", NOW - MIN);
    acceptedToken = "agent-new";
    onToken = () => {
      // Claude Code refreshed at the same moment and wrote its own tokens.
      writeCreds("agent-new", "rt-agent", NOW + HOUR);
      return Response.json({ access_token: "pigeon-new", refresh_token: "rt-pigeon", expires_in: 3600 });
    };
    const snap = await provider().fetch();
    expect(snap.windows).toHaveLength(2);
    expect(tokenCalls).toBe(1);
    expect(readCreds().claudeAiOauth).toMatchObject({ accessToken: "agent-new", refreshToken: "rt-agent" });
  });

  test("claude credential refresh: a rejected refresh leaves the file untouched and names the provider", async () => {
    writeCreds("old", "rt-old", NOW - MIN);
    const before = readFileSync(credPath, "utf-8");
    acceptedToken = "never";
    onToken = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    await expect(provider().fetch()).rejects.toThrow(/claude/i);
    expect(readFileSync(credPath, "utf-8")).toBe(before);
    expect(tokenCalls).toBe(1);
  });
});

describe("quota config and usage request validation (quota-and-usage.md §2.5, protocol.md §4.16, §6.3)", () => {
  let herdr: FakeHerdr;
  let client: HerdrClient;
  let server: WsServer;
  let dir: string;

  beforeEach(async () => {
    dir = tempDir("quota-ws");
    herdr = new FakeHerdr(dir);
    await herdr.listen();
    client = new HerdrClient({ appSocketPath: herdr.appSocketPath, coreSocketPath: herdr.coreSocketPath, debounceMs: 5, panePollMs: 60_000 });
    client.applySnapshot(topologyOf([{ paneId: "p1", app: "claude-code", cwd: dir }]));
    server = new WsServer({
      buildId: "build_test",
      herdrClient: client,
      pushManager: new PushManager(join(dir, "vapid.json")),
      configManager: new ConfigManager(join(dir, "config.json"), { HOME: dir }),
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

  test("quota config: a fresh config enables exactly the providers logged in here, shows remaining, shows the button", () => {
    const h = tempDir("quota-home");
    mkdirSync(join(h, ".codex"), { recursive: true });
    writeFileSync(join(h, ".codex", "auth.json"), "{}");
    const cfg = new ConfigManager(join(h, "config.json"), { HOME: h }).getClientConfig();
    expect(cfg.quotaProviders).toEqual({ claude: false, codex: true, antigravity: false });
    expect(cfg.quotaDisplay).toBe("remaining");
    expect(cfg.quotaButton).toBe(true);
  });

  test("quota config: valid quota keys are saved and invalid values refused", async () => {
    const ok = fakeWs();
    await send(ok.ws, { type: "config_patch", id: "p0", payload: { client: { quotaDisplay: "used", quotaButton: false, quotaProviders: { antigravity: true } } } });
    expect(lastError(ok.sent)).toBeUndefined();
    const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")).client;
    expect(saved).toMatchObject({ quotaDisplay: "used", quotaButton: false, quotaProviders: { antigravity: true } });
    for (const client of [{ quotaDisplay: "left" }, { quotaButton: "yes" }, { quotaProviders: { claude: "on" } }, { quotaProviders: { gemini: true } }]) {
      const c = fakeWs();
      await send(c.ws, { type: "config_patch", id: "p1", payload: { client } });
      expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
    }
  });

  test("usage request validation: well-formed requests pass; unknown preset, custom without dates, dates on a fixed preset, or no agents are refused", async () => {
    const all = ["claude", "codex", "agy", "opencode", "pi"];
    for (const payload of [{ preset: "today", agents: all }, { preset: "custom", from: "2026-10-01", to: "2026-10-31", agents: ["codex"] }]) {
      expect(validateClientMessage({ type: "usage_get", id: "u0", payload }).ok).toBe(true);
    }
    expect(validateClientMessage({ type: "quota_get", id: "q0", payload: { force: true } }).ok).toBe(true);
    for (const payload of [
      { preset: "quarter", agents: all },
      { preset: "custom", agents: all },
      { preset: "7d", from: "2026-11-01", to: "2026-11-07", agents: all },
      { preset: "today", agents: [] },
      { preset: "today", agents: ["gemini"] },
    ]) {
      const c = fakeWs();
      await send(c.ws, { type: "usage_get", id: "u1", payload });
      expect(lastError(c.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
    }
  });

  test("scanner throws on corrupted SQLite database so store skips fingerprint (quota-and-usage.md §3.1)", () => {
    const d = tempDir("usage-corrupt");
    const corruptDb = join(d, "corrupt.db");
    writeFileSync(corruptDb, "NOT A VALID SQLITE DATABASE FILE HEADER");
    expect(() => scanAntigravityDb(corruptDb)).toThrow();
    expect(() => scanOpenCodeDb(corruptDb)).toThrow();
  });

  test("UsageStore.scanIncremental skips updating scan_file_state on corrupted SQLite database (quota-and-usage.md §3.1)", async () => {
    const d = tempDir("usage-store-corrupt");
    const fakeHome = join(d, "home");
    const origData = process.env.XDG_DATA_HOME;
    const origCodex = process.env.CODEX_HOME;
    process.env.XDG_DATA_HOME = join(fakeHome, "share");
    process.env.CODEX_HOME = join(fakeHome, "codex");

    try {
      const agyConvs = join(fakeHome, ".gemini", "antigravity-cli", "conversations");
      mkdirSync(agyConvs, { recursive: true });
      const corruptDb = join(agyConvs, "corrupt.db");
      writeFileSync(corruptDb, "NOT A VALID SQLITE DATABASE FILE HEADER");

      const pricing = new PricingManager({ cachePath: join(d, "pricing.json"), fetch: (() => Promise.reject()) as any });
      const store = new UsageStore({ dbPath: join(d, "usage.db"), home: fakeHome, discoverLs: async () => null });
      await store.scanIncremental(pricing);

      const state = (store as any).db.query("SELECT * FROM scan_file_state WHERE path = ?").get(corruptDb);
      expect(state).toBeNull();
      store.close();
    } finally {
      process.env.XDG_DATA_HOME = origData;
      process.env.CODEX_HOME = origCodex;
    }
  });

  test("UsageService with autoScan: false does not start timer, and rebuild() serializes with scan()", async () => {
    const d = tempDir("usage-service");
    const fakeHome = join(d, "home");
    const origData = process.env.XDG_DATA_HOME;
    const origCodex = process.env.CODEX_HOME;
    process.env.XDG_DATA_HOME = join(fakeHome, "share");
    process.env.CODEX_HOME = join(fakeHome, "codex");

    try {
      const store = new UsageStore({ dbPath: join(d, "usage.db"), home: fakeHome, discoverLs: async () => null });
      const service = new UsageService({
        store,
        pricing: new PricingManager({ cachePath: join(d, "pricing.json"), fetch: (() => Promise.reject()) as any }),
        autoScan: false,
      });

      expect((service as any).backgroundTimer).toBeNull();

      // Hook into rebuildAll to hold execution via deferred promise
      let rebuildStarted = false;
      let rebuildFinished = false;
      let resolveRebuild: () => void = () => {};
      const deferred = new Promise<void>((r) => {
        resolveRebuild = r;
      });

      const origRebuildAll = store.rebuildAll.bind(store);
      store.rebuildAll = async (pricing) => {
        rebuildStarted = true;
        await deferred;
        const res = await origRebuildAll(pricing);
        rebuildFinished = true;
        return res;
      };

      const rebuildPromise = service.rebuild();
      while (!rebuildStarted) {
        await new Promise((r) => setTimeout(r, 2));
      }

      // Concurrently invoke scan() while rebuildAll is held
      let scanFinished = false;
      const scanPromise = service.scan().then((res) => {
        scanFinished = true;
        return res;
      });

      // Verify that scan() has NOT finished while rebuild() is in progress
      await new Promise((r) => setTimeout(r, 15));
      expect(rebuildFinished).toBe(false);
      expect(scanFinished).toBe(false);

      // Now allow rebuild to complete
      resolveRebuild();

      const [rebuildRes, scanRes] = await Promise.all([rebuildPromise, scanPromise]);
      expect(rebuildFinished).toBe(true);
      expect(scanFinished).toBe(true);
      expect(rebuildRes.scannedFiles).toBeGreaterThanOrEqual(0);
      expect(scanRes.scannedFiles).toBeGreaterThanOrEqual(0);

      service.destroy();
    } finally {
      process.env.XDG_DATA_HOME = origData;
      process.env.CODEX_HOME = origCodex;
    }
  });

  test("quotaUsageEnabled master switch: config validation, preservation, and command gating (quota-and-usage.md §1.1, protocol.md §4.16–§4.19, §6.3)", async () => {
    // 1. Fresh config has quotaUsageEnabled: true
    const cfgMgr = new ConfigManager(join(dir, "config.json"), { HOME: dir });
    expect(cfgMgr.getClientConfig().quotaUsageEnabled).toBe(true);

    // 2. Patch with invalid value is rejected
    const badWs = fakeWs();
    await send(badWs.ws, { type: "config_patch", id: "p_bad", payload: { client: { quotaUsageEnabled: "no" } } });
    expect(lastError(badWs.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);

    // 3. Patch with quotaUsageEnabled: false is accepted, preserving other fields
    const patchWs = fakeWs();
    await send(patchWs.ws, { type: "config_patch", id: "p_ok", payload: { client: { quotaUsageEnabled: false, quotaDisplay: "used" } } });
    expect(lastError(patchWs.sent)).toBeUndefined();
    expect(server.configManager.getClientConfig().quotaUsageEnabled).toBe(false);
    expect(server.configManager.getClientConfig().quotaDisplay).toBe("used");
    const diskClient = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")).client;
    expect(diskClient.quotaUsageEnabled).toBe(false);
    expect(diskClient.quotaDisplay).toBe("used");

    // 4. When quotaUsageEnabled is false, quota_get, usage_get, usage_day, usage_model are all rejected with ERR_FEATURE_DISABLED
    const qWs = fakeWs();
    await send(qWs.ws, { type: "quota_get", id: "q1", payload: {} });
    expect(lastError(qWs.sent)).toBe(ProtocolErrors.ERR_FEATURE_DISABLED);

    const uWs = fakeWs();
    await send(uWs.ws, { type: "usage_get", id: "u1", payload: { preset: "7d", agents: ["claude"] } });
    expect(lastError(uWs.sent)).toBe(ProtocolErrors.ERR_FEATURE_DISABLED);

    const udWs = fakeWs();
    await send(udWs.ws, { type: "usage_day", id: "ud1", payload: { date: "2026-11-10", agents: ["claude"] } });
    expect(lastError(udWs.sent)).toBe(ProtocolErrors.ERR_FEATURE_DISABLED);

    const umWs = fakeWs();
    await send(umWs.ws, { type: "usage_model", id: "um1", payload: { model: "claude-3-opus", from: "2026-11-01", to: "2026-11-10", agents: ["claude"] } });
    expect(lastError(umWs.sent)).toBe(ProtocolErrors.ERR_FEATURE_DISABLED);

    // 5. Re-enabling the switch restores command access and preserves previous quotaDisplay
    const reenableWs = fakeWs();
    await send(reenableWs.ws, { type: "config_patch", id: "p_on", payload: { client: { quotaUsageEnabled: true } } });
    expect(lastError(reenableWs.sent)).toBeUndefined();
    expect(server.configManager.getClientConfig().quotaUsageEnabled).toBe(true);
    expect(server.configManager.getClientConfig().quotaDisplay).toBe("used");

    const qWs2 = fakeWs();
    await send(qWs2.ws, { type: "quota_get", id: "q2", payload: {} });
    expect(lastError(qWs2.sent)).toBeUndefined();
  });

  test("UsageService background timer and transition scan respects quotaUsageEnabled (quota-and-usage.md §1.1)", async () => {
    const d = tempDir("usage-service-toggle");
    const fakeHome = join(d, "home");
    mkdirSync(fakeHome, { recursive: true });

    let scanCount = 0;
    const mockStore = {
      close: () => {},
      scanIncremental: async () => {
        scanCount++;
        return { scannedFiles: 0, recordsAdded: 0 };
      },
    } as unknown as UsageStore;

    // 1. Initialized with quotaUsageEnabled: false
    const cfgPath = join(d, "config.json");
    const cfgMgr = new ConfigManager(cfgPath, { HOME: fakeHome });
    cfgMgr.patchClientConfig({ quotaUsageEnabled: false });

    const service = new UsageService({
      configManager: cfgMgr,
      store: mockStore,
      autoScan: true,
    });

    // When quotaUsageEnabled is false, autoScan / startBackgroundTimer does not scan and sets no timer
    expect(scanCount).toBe(0);
    expect((service as any).backgroundTimer).toBeNull();

    // Calling startBackgroundTimer explicitly also early-exits
    service.startBackgroundTimer();
    expect(scanCount).toBe(0);
    expect((service as any).backgroundTimer).toBeNull();

    // 2. Toggling quotaUsageEnabled to true via updateConfig triggers exactly one scan and arms the timer
    cfgMgr.patchClientConfig({ quotaUsageEnabled: true });
    service.updateConfig();
    expect((service as any).backgroundTimer).not.toBeNull();
    // Wait for the async scan to settle
    await (service as any).scanPromise;
    expect(scanCount).toBe(1);

    // Calling updateConfig again while already enabled does not trigger extra scan
    service.updateConfig();
    expect(scanCount).toBe(1);

    // 3. Toggling off disarms timer and stops background scans
    cfgMgr.patchClientConfig({ quotaUsageEnabled: false });
    service.updateConfig();
    expect((service as any).backgroundTimer).toBeNull();

    service.destroy();
  });

  test("server accurately tracks and returns actual scan and fetch timestamps for usage and quota", async () => {
    const d = tempDir("actual-timestamps");
    const fakeHome = join(d, "home");
    mkdirSync(fakeHome, { recursive: true });

    let fakeNow = 1700000000000;
    const nowFn = () => fakeNow;

    // 1. UsageStore: scan records actual scan time in lastScannedAt and returns it in scannedAt
    const store = new UsageStore({ dbPath: join(d, "usage.db"), home: fakeHome, now: nowFn, discoverLs: async () => null });
    const pricing = new PricingManager({ cachePath: join(d, "pricing.json"), fetch: (() => Promise.reject()) as any });

    // Initial state before scan
    expect(store.getLastScannedAt()).toBe(0);

    // Perform scan at t = 1700000000000
    await store.scanIncremental(pricing);
    expect(store.getLastScannedAt()).toBe(1700000000000);

    // Later at t = 1700000050000, client requests report without scanning
    fakeNow = 1700000050000;
    const rep = store.getUsageReport({ preset: "today", agents: ["claude"] }, { from: "2023-11-14", to: "2023-11-14" }, "2023-11-14", false);
    // scannedAt reflects the actual scan time (1700000000000), not the query time (1700000050000)!
    expect(rep.scannedAt).toBe(1700000000000);

    store.close();

    // 2. QuotaService: returns actual fetchedAt from providers, and cached requests reuse that server timestamp
    const qService = new QuotaService({
      now: nowFn,
      claude: { fetch: async () => ({ provider: "claude" as const, windows: [], credits: [], fetchedAt: fakeNow }) } as any,
      codex: { fetch: async () => ({ provider: "codex" as const, windows: [], credits: [], fetchedAt: fakeNow }) } as any,
      antigravity: { fetch: async () => ({ provider: "antigravity" as const, windows: [], credits: [], fetchedAt: fakeNow }) } as any,
    });

    const res1 = await qService.getQuota({ quotaProviders: { claude: true, codex: false, antigravity: false } } as any);
    expect(res1.fetchedAt).toBe(1700000050000);

    // 30 seconds later, within 60s cache window:
    fakeNow = 1700000080000;
    const res2 = await qService.getQuota({ quotaProviders: { claude: true, codex: false, antigravity: false } } as any);
    // res2 should return the original server fetch time from cache!
    expect(res2.fetchedAt).toBe(1700000050000);
  });
});
