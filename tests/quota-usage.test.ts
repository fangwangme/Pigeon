import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  beforeEach(() => {
    home = tempDir("quota-claude");
    mkdirSync(join(home, ".claude"), { recursive: true });
    credPath = join(home, ".claude", ".credentials.json");
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
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
  });

  test("claude credentials are read-only (D7)", async () => {
    writeCreds("old", "rt-old", NOW - MIN);
    const before = readFileSync(credPath, "utf-8");
    acceptedToken = "old";
    const error = await provider().fetch().then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(/claude/i);
    expect(error?.message).toMatch(/refresh/i);
    expect(readFileSync(credPath, "utf-8")).toBe(before);
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

  test("UsageService rebuild() serializes with scan()", async () => {
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
      });

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

  test("split quotaEnabled & usageEnabled: defaults, legacy config drop, validation, and independent command gating (quota-and-usage.md §1.1, protocol.md §4.16–§4.19, §6.3)", async () => {
    // 1. Fresh config has quotaEnabled: false, usageEnabled: true, usageScanInterval: "15m"
    const freshCfg = new ConfigManager(join(dir, "fresh-config.json"), { HOME: dir }).getClientConfig();
    expect(freshCfg.quotaEnabled).toBe(false);
    expect(freshCfg.usageEnabled).toBe(true);
    expect(freshCfg.usageScanInterval).toBe("15m");
    expect((freshCfg as any).quotaUsageEnabled).toBeUndefined();

    // 2. Legacy config with quotaUsageEnabled drops it and never inherits into new switches
    const legacyPath = join(dir, "legacy-config.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({ client: { quotaUsageEnabled: true, quotaDisplay: "used" } }),
      "utf-8"
    );
    const legacyCfg = new ConfigManager(legacyPath, { HOME: dir }).getClientConfig();
    expect(legacyCfg.quotaEnabled).toBe(false);
    expect(legacyCfg.usageEnabled).toBe(true);
    expect(legacyCfg.quotaDisplay).toBe("used");
    expect((legacyCfg as any).quotaUsageEnabled).toBeUndefined();

    const legacyOffPath = join(dir, "legacy-off-config.json");
    writeFileSync(legacyOffPath, JSON.stringify({ client: { quotaUsageEnabled: false } }), "utf-8");
    const legacyOffCfg = new ConfigManager(legacyOffPath, { HOME: dir }).getClientConfig();
    expect(legacyOffCfg.quotaEnabled).toBe(false);
    expect(legacyOffCfg.usageEnabled).toBe(true);
    expect((legacyOffCfg as any).quotaUsageEnabled).toBeUndefined();

    // 3. Patch with legacy quotaUsageEnabled or bad types is rejected with ERR_INVALID_PAYLOAD
    for (const client of [{ quotaUsageEnabled: true }, { quotaEnabled: "no" }, { usageEnabled: 1 }]) {
      const badWs = fakeWs();
      await send(badWs.ws, { type: "config_patch", id: "p_bad", payload: { client } });
      expect(lastError(badWs.sent)).toBe(ProtocolErrors.ERR_INVALID_PAYLOAD);
    }

    // 4. Default state (quotaEnabled: false, usageEnabled: true): quota_get -> ERR_FEATURE_DISABLED; usage_* -> ok
    const qOffWs = fakeWs();
    await send(qOffWs.ws, { type: "quota_get", id: "q_off", payload: {} });
    expect(lastError(qOffWs.sent)).toBe(ProtocolErrors.ERR_FEATURE_DISABLED);

    const uOnWs = fakeWs();
    await send(uOnWs.ws, { type: "usage_get", id: "u_on", payload: { preset: "7d", agents: ["claude"] } });
    expect(lastError(uOnWs.sent)).toBeUndefined();

    // 5. Flip to quotaEnabled: true, usageEnabled: false -> usage_* rejected, quota_get succeeds
    const stateDir = server.configManager.getServerConfig().stateDir;
    const dbPath = join(stateDir, "usage.db");
    const dbBefore = existsSync(dbPath) ? readFileSync(dbPath) : null;

    const patchWs = fakeWs();
    await send(patchWs.ws, {
      type: "config_patch",
      id: "p_flip",
      payload: { client: { quotaEnabled: true, usageEnabled: false } },
    });
    expect(lastError(patchWs.sent)).toBeUndefined();
    expect(server.configManager.getClientConfig().quotaEnabled).toBe(true);
    expect(server.configManager.getClientConfig().usageEnabled).toBe(false);

    const qOnWs = fakeWs();
    await send(qOnWs.ws, { type: "quota_get", id: "q_on", payload: {} });
    expect(lastError(qOnWs.sent)).toBeUndefined();

    for (const msg of [
      { type: "usage_get", id: "u1", payload: { preset: "7d", agents: ["claude"] } },
      { type: "usage_day", id: "ud1", payload: { date: "2026-11-10", agents: ["claude"] } },
      { type: "usage_model", id: "um1", payload: { model: "claude-3-opus", from: "2026-11-01", to: "2026-11-10", agents: ["claude"] } },
    ]) {
      const uOffWs = fakeWs();
      await send(uOffWs.ws, msg);
      expect(lastError(uOffWs.sent)).toBe(ProtocolErrors.ERR_FEATURE_DISABLED);
    }
    const dbAfter = existsSync(dbPath) ? readFileSync(dbPath) : null;
    expect(dbAfter).toEqual(dbBefore);
  });

  test("startup refresh, read-only quota_get, provider error retention, toggle refresh, and push notifications (quota-and-usage.md §1.1, §2.6, protocol.md §5.11–§5.12)", async () => {
    const d = tempDir("quota-online-lifecycle");
    const fakeHome = join(d, "home");
    mkdirSync(fakeHome, { recursive: true });
    let fakeNow = 1_700_000_000_000;
    const nowFn = () => fakeNow;

    const cfgMgr = new ConfigManager(join(d, "config.json"), { HOME: fakeHome });
    cfgMgr.patchClientConfig({
      quotaEnabled: true,
      usageEnabled: true,
      usageScanInterval: "5m",
      quotaProviders: { claude: true, codex: false, antigravity: false },
    });

    let fetchCount = 0;
    let shouldFail = false;
    const qService = new QuotaService({
      configManager: cfgMgr,
      now: nowFn,
      claude: {
        fetch: async () => {
          fetchCount++;
          if (shouldFail) throw new Error("429 rate limited");
          return {
            provider: "claude",
            windows: [{ id: "5h", label: "5h", usedPercent: fetchCount * 10, periodMs: 18_000_000, resetsAt: fakeNow + 3_600_000 }],
            credits: [],
            fetchedAt: fakeNow,
          };
        },
      } as any,
      codex: { fetch: async () => ({ provider: "codex", windows: [], credits: [], fetchedAt: fakeNow }) } as any,
      antigravity: { fetch: async () => ({ provider: "antigravity", windows: [], credits: [], fetchedAt: fakeNow }) } as any,
    });

    let scanCount = 0;
    const store = new UsageStore({ dbPath: join(d, "usage.db"), home: fakeHome, now: nowFn, discoverLs: async () => null });
    const uService = new UsageService({
      configManager: cfgMgr,
      store,
      pricing: new PricingManager({ cachePath: join(d, "pricing.json"), fetch: (() => Promise.reject()) as any }),
      now: nowFn,
    });
    const origScan = store.scanIncremental.bind(store);
    store.scanIncremental = async (pricing) => {
      scanCount++;
      return origScan(pricing);
    };

    const wsSrv = new WsServer({
      buildId: "build_lifecycle",
      herdrClient: client,
      pushManager: new PushManager(join(d, "vapid.json")),
      configManager: cfgMgr,
      skillScanner: new SkillScanner(fakeHome),
      quotaService: qService,
      usageService: uService,
    });

    try {
      // 1. Daemon refreshes enabled items at start even with no phone connected
      await (qService as any).refreshAllPromise;
      await (uService as any).scanPromise;
      expect(fetchCount).toBe(1);
      expect(scanCount).toBe(1);

      // 2. Connecting a phone does not re-fetch; plain quota_get reads cache only
      const phone1 = fakeWs();
      wsSrv.handleOpen(phone1.ws);
      fakeNow += 60_000;
      for (let i = 0; i < 3; i++) {
        await wsSrv.handleMessage(phone1.ws, JSON.stringify({ type: "quota_get", id: `qg_${i}`, payload: {} }));
      }
      expect(fetchCount).toBe(1);
      const qAck = phone1.sent.filter((m) => m.type === "ack" && m.replyTo?.startsWith("qg_")).at(-1);
      expect(qAck?.payload?.providers?.[0]?.snapshot?.windows?.[0]?.usedPercent).toBe(10);

      // 3. Provider failure retains previous snapshot next to the error and emits quota_updated
      shouldFail = true;
      const errNow = (fakeNow += 310_000);
      await qService.fetchAll();
      expect(fetchCount).toBe(2);
      const qPush = phone1.sent.find((m) => m.type === "quota_updated");
      expect(qPush).toBeDefined();

      await wsSrv.handleMessage(phone1.ws, JSON.stringify({ type: "quota_get", id: "qg_err", payload: {} }));
      expect(fetchCount).toBe(2);
      const errAck = phone1.sent.filter((m) => m.type === "ack" && m.replyTo === "qg_err").at(-1);
      const claudeState = errAck?.payload?.providers?.find((p: any) => p.provider === "claude");
      expect(claudeState?.snapshot?.windows?.[0]?.usedPercent).toBe(10);
      expect(claudeState?.error?.message).toMatch(/429 rate limited/);
      expect(claudeState?.error?.at).toBe(errNow);

      // 4. Toggling a switch off -> on triggers immediate refresh only for that item
      shouldFail = false;
      await wsSrv.handleMessage(phone1.ws, JSON.stringify({ type: "config_patch", id: "p_qoff", payload: { client: { quotaEnabled: false } } }));
      const scansBeforeToggle = scanCount;
      await wsSrv.handleMessage(phone1.ws, JSON.stringify({ type: "config_patch", id: "p_qon", payload: { client: { quotaEnabled: true } } }));
      await (qService as any).refreshAllPromise;
      expect(fetchCount).toBe(3);
      expect(scanCount).toBe(scansBeforeToggle);
    } finally {
      wsSrv.destroy();
    }
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

    expect(store.getLastScannedAt()).toBe(0);

    await store.scanIncremental(pricing);
    expect(store.getLastScannedAt()).toBe(1700000000000);

    fakeNow = 1700000050000;
    const rep = store.getUsageReport({ preset: "today", agents: ["claude"] }, { from: "2023-11-14", to: "2023-11-14" }, "2023-11-14", false);
    expect(rep.scannedAt).toBe(1700000000000);

    store.close();

    // 2. QuotaService: fetchAll records actual fetch timestamp, and repeated getQuota reads return cached timestamp with no upstream call
    let calls = 0;
    const cfg = { quotaEnabled: true, quotaProviders: { claude: true, codex: false, antigravity: false } } as any;
    const qService = new QuotaService({
      now: nowFn,
      claude: {
        fetch: async () => {
          calls++;
          return { provider: "claude" as const, windows: [], credits: [], fetchedAt: fakeNow };
        },
      } as any,
      codex: { fetch: async () => ({ provider: "codex" as const, windows: [], credits: [], fetchedAt: fakeNow }) } as any,
      antigravity: { fetch: async () => ({ provider: "antigravity" as const, windows: [], credits: [], fetchedAt: fakeNow }) } as any,
    });

    await qService.fetchAll(cfg);
    const res1 = await qService.getQuota(cfg);
    expect(res1.fetchedAt).toBe(1700000050000);

    fakeNow = 1700000080000;
    const res2 = await qService.getQuota(cfg);
    expect(res2.fetchedAt).toBe(1700000050000);
    expect(calls).toBe(1);
  });

  test("UsageStore seeds model_price_periods at 0000-01-01, splits on price change, preserves on rebuildAll, and backfills unpriced records", async () => {
    const dir = tempDir("usage-periods");
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

    const failPricing = new PricingManager({
      cachePath: join(dir, "p-empty.json"),
      now: () => clock,
      fetch: (async () => new Response("err", { status: 500 })) as unknown as typeof fetch,
    });
    const store = new UsageStore({ dbPath, home, now: () => clock, discoverLs: async () => null });
    await store.scanIncremental(failPricing);

    const db = new Database(dbPath, { readonly: true });
    const row1 = db.query("SELECT cost, unpriced FROM usage_records WHERE agent = 'claude'").get() as any;
    expect(row1.unpriced).toBe(1);
    expect(row1.cost).toBe(0);

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
    expect(periods1).toEqual([{ effective_from: "0000-01-01", effective_to: null, input_rate: 3 }]);

    const entriesSpy = spyOn(okPricing, "getCatalogEntries");
    await store.scanIncremental(okPricing);
    expect(entriesSpy).not.toHaveBeenCalled();
    entriesSpy.mockRestore();

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

    await store.rebuildAll(pm2);
    const recordsAfterRebuild = db
      .query("SELECT date, cost FROM usage_records ORDER BY date")
      .all() as Array<{ date: string; cost: number }>;
    expect(recordsAfterRebuild).toEqual([
      { date: "2026-11-10", cost: 3 },
      { date: "2026-11-14", cost: 6 },
    ]);

    db.close();
    store.close();
  });
});

function pbVarint(n: number): number[] {
  const out: number[] = [];
  let v = Math.floor(n);
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

function pbFieldVarint(fieldNum: number, val: number): Buffer {
  return Buffer.from([...pbVarint((fieldNum << 3) | 0), ...pbVarint(val)]);
}

function pbFieldBytes(fieldNum: number, data: Buffer | string): Buffer {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return Buffer.from([...pbVarint((fieldNum << 3) | 2), ...pbVarint(buf.length), ...buf]);
}

interface MockAgyStep {
  uuid: string;
  tsMs: number;
  modelEnum?: string;
  servedModel?: string;
  displayName?: string;
  input?: number;
  totOut?: number;
  cacheWrite?: number;
  cacheRead?: number;
  thinkingOut?: number;
  respOut?: number;
  respId?: string;
}

function writeMockAntigravityDb(path: string, steps: MockAgyStep[]): void {
  const db = new Database(path);
  db.run("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);");
  db.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");

  const insStep = db.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)");
  const insGen = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");

  steps.forEach((s, idx) => {
    const sec = Math.floor(s.tsMs / 1000);
    const nanos = (s.tsMs % 1000) * 1_000_000;
    const tsMsg = Buffer.concat([pbFieldVarint(1, sec), pbFieldVarint(2, nanos)]);
    const stepMeta = Buffer.concat([pbFieldBytes(1, tsMsg), pbFieldBytes(12, s.uuid)]);
    insStep.run(idx, stepMeta);

    const usageParts: Buffer[] = [];
    if (s.input !== undefined) usageParts.push(pbFieldVarint(2, s.input));
    if (s.totOut !== undefined) usageParts.push(pbFieldVarint(3, s.totOut));
    if (s.cacheWrite !== undefined) usageParts.push(pbFieldVarint(4, s.cacheWrite));
    if (s.cacheRead !== undefined) usageParts.push(pbFieldVarint(5, s.cacheRead));
    if (s.thinkingOut !== undefined) usageParts.push(pbFieldVarint(9, s.thinkingOut));
    if (s.respOut !== undefined) usageParts.push(pbFieldVarint(10, s.respOut));
    if (s.respId !== undefined) usageParts.push(pbFieldBytes(11, s.respId));

    const payloadParts: Buffer[] = [pbFieldBytes(4, Buffer.concat(usageParts))];
    if (s.servedModel !== undefined) payloadParts.push(pbFieldBytes(19, s.servedModel));
    if (s.modelEnum !== undefined) {
      payloadParts.push(pbFieldBytes(20, Buffer.concat([pbFieldBytes(1, "model_enum"), pbFieldBytes(2, s.modelEnum)])));
    }
    if (s.displayName !== undefined) payloadParts.push(pbFieldBytes(21, s.displayName));

    const genBlob = Buffer.concat([pbFieldBytes(4, s.uuid), pbFieldBytes(1, Buffer.concat(payloadParts))]);
    insGen.run(idx, genBlob);
  });

  db.close();
}

describe("Antigravity token accounting and contemporaneous model resolution (quota-and-usage.md §3.1–§3.3)", () => {
  test("scanAntigravityDb counts total output including thinking tokens, reads cacheWriteTokens, normalizes (Orchestrator) and -xhigh display names, and inherits same-session sibling identity", () => {
    const d = tempDir("agy-db-scan");
    const dbFile = join(d, "session-orch.db");
    const baseTs = Date.parse("2026-11-18T12:00:00Z");

    writeMockAntigravityDb(dbFile, [
      {
        uuid: "u0",
        tsMs: baseTs,
        modelEnum: "MODEL_PLACEHOLDER_M669",
        servedModel: "gemini-flash-worker-agy",
        displayName: "Gemini 4 Hydrogen (Orchestrator)",
        input: 10_000,
        totOut: 1_000,
        thinkingOut: 700,
        respOut: 300,
        cacheRead: 5_000,
        cacheWrite: 200,
        respId: "r0",
      },
      {
        uuid: "u1",
        tsMs: baseTs + 1_000,
        modelEnum: "MODEL_PLACEHOLDER_M669",
        servedModel: "gemini-flash-worker-agy",
        displayName: "Gemini 4 Oxygen (Orchestrator)",
        input: 2_000,
        thinkingOut: 400,
        respOut: 100,
        respId: "r1",
      },
      {
        uuid: "u2",
        tsMs: baseTs + 2_000,
        modelEnum: "MODEL_PLACEHOLDER_M901",
        servedModel: "gemini-4-hydrogen-xhigh",
        displayName: "Gemini 4 Hydrogen (XHigh)",
        input: 1_000,
        totOut: 200,
        respId: "r2",
      },
      {
        uuid: "u3",
        tsMs: baseTs + 3_000,
        modelEnum: "MODEL_PLACEHOLDER_M901",
        input: 1_500,
        totOut: 250,
        respId: "r3",
      },
    ]);

    const recs = scanAntigravityDb(dbFile);
    expect(recs).toHaveLength(4);

    expect(recs[0]).toMatchObject({
      canonicalModelId: "gemini-4-hydrogen",
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 200,
      totalTokens: 16_200,
    });
    expect(recs[1]).toMatchObject({
      canonicalModelId: "gemini-4-oxygen",
      inputTokens: 2_000,
      outputTokens: 500,
      totalTokens: 2_500,
    });
    expect(recs[2]).toMatchObject({
      canonicalModelId: "gemini-4-hydrogen",
      outputTokens: 200,
    });
    expect(recs[3]).toMatchObject({
      canonicalModelId: "gemini-4-hydrogen",
      outputTokens: 250,
    });
  });

  test("UsageStore resolves unversioned Antigravity family labels by models.dev release_date across generations, preserves historical assignments on rebuildAll, and upgrades release-day records on catalog refresh", async () => {
    const d = tempDir("agy-contemporaneous");
    const fakeHome = join(d, "home");
    const convDir = join(fakeHome, ".gemini", "antigravity-cli", "conversations");
    mkdirSync(convDir, { recursive: true });

    writeMockAntigravityDb(join(convDir, "s_nov14.db"), [
      {
        uuid: "n14-1",
        tsMs: Date.parse("2026-11-14T12:00:00Z"),
        modelEnum: "MODEL_PLACEHOLDER_M668",
        servedModel: "gemini-pro-orchestrator-g1-pro",
        displayName: "Orchestrator (Argon)",
        input: 1_000_000,
        totOut: 100_000,
        thinkingOut: 60_000,
        respOut: 40_000,
        respId: "n14-r1",
      },
      {
        uuid: "n14-2",
        tsMs: Date.parse("2026-11-14T12:05:00Z"),
        modelEnum: "MODEL_PLACEHOLDER_M669",
        servedModel: "gemini-flash-worker-agy",
        displayName: "Gemini Flash",
        input: 1_000_000,
        totOut: 100_000,
        respId: "n14-r2",
      },
      {
        uuid: "n14-3",
        tsMs: Date.parse("2026-11-14T12:10:00Z"),
        modelEnum: "MODEL_PLACEHOLDER_M681",
        servedModel: "gemini-pro-orchestrator-argon",
        input: 1_000_000,
        totOut: 100_000,
        respId: "n14-r3",
      },
    ]);

    writeMockAntigravityDb(join(convDir, "s_nov18.db"), [
      {
        uuid: "n18-1",
        tsMs: Date.parse("2026-11-18T12:00:00Z"),
        modelEnum: "MODEL_PLACEHOLDER_M667",
        servedModel: "gemini-pro-orchestrator",
        displayName: "Orchestrator (Carbon)",
        input: 1_000_000,
        totOut: 100_000,
        respId: "n18-r1",
      },
    ]);

    writeMockAntigravityDb(join(convDir, "s_mar01.db"), [
      {
        uuid: "m01-1",
        tsMs: Date.parse("2027-03-01T12:00:00Z"),
        modelEnum: "MODEL_PLACEHOLDER_M667",
        servedModel: "gemini-pro-orchestrator",
        displayName: "Orchestrator (Carbon)",
        input: 1_000_000,
        totOut: 100_000,
        respId: "m01-r1",
      },
    ]);

    let includeCarbon42 = false;
    let clock = Date.parse("2027-03-01T12:30:00Z");
    const cachePath = join(d, "pricing-cache.json");

    const mockCatalogFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.includes("models.dev")) return new Response("Not Found", { status: 404 });
      const models: Record<string, any> = {
        "gemini-3.5-flash": { id: "gemini-3.5-flash", release_date: "2026-05-19", cost: { input: 1.5, output: 9, cache_read: 0.15 } },
        "gemini-3.8-flash": { id: "gemini-3.8-flash", release_date: "2026-09-02", cost: { input: 0.75, output: 3.75, cache_read: 0.075 } },
        "gemini-4-argon": { id: "gemini-4-argon", release_date: "2026-10-13", cost: { input: 2, output: 10, cache_read: 0.1 } },
        "gemini-4-carbon": { id: "gemini-4-carbon", release_date: "2026-11-10", cost: { input: 4, output: 20, cache_read: 0.2 } },
      };
      if (includeCarbon42) {
        models["gemini-4.2-carbon"] = { id: "gemini-4.2-carbon", release_date: "2027-03-01", cost: { input: 5, output: 25, cache_read: 0.25 } };
      }
      return Response.json({ google: { models } });
    }) as unknown as typeof fetch;

    const pm = new PricingManager({ cachePath, now: () => clock, fetch: mockCatalogFetch });
    const store = new UsageStore({ dbPath: join(d, "usage.db"), home: fakeHome, now: () => clock, discoverLs: async () => null });
    const dayModels = (date: string) =>
      store
        .getUsageReport({ preset: "custom", from: date, to: date, agents: ["agy"] }, { from: date, to: date }, "2027-03-05", true)
        .models.map((m) => ({ model: m.model, messages: m.messages, cost: m.cost, unpriced: m.unpriced }));

    try {
      await pm.initialize();
      await store.scanIncremental(pm);

      expect(dayModels("2026-11-14")).toEqual([
        { model: "gemini-4-argon", messages: 2, cost: 6, unpriced: false },
        { model: "gemini-3-8-flash", messages: 1, cost: 1.125, unpriced: false },
      ]);
      expect(dayModels("2026-11-18")).toEqual([{ model: "gemini-4-carbon", messages: 1, cost: 6, unpriced: false }]);
      expect(dayModels("2027-03-01")).toEqual([{ model: "gemini-4-carbon", messages: 1, cost: 6, unpriced: false }]);

      // Catalog refreshes on 2027-03-05 introducing gemini-4.2-carbon (release_date 2027-03-01)
      includeCarbon42 = true;
      clock = Date.parse("2027-03-05T12:00:00Z");
      writeMockAntigravityDb(join(convDir, "s_mar05.db"), [
        {
          uuid: "m05-1",
          tsMs: Date.parse("2027-03-05T12:00:00Z"),
          modelEnum: "MODEL_PLACEHOLDER_M667",
          servedModel: "gemini-pro-orchestrator",
          displayName: "Orchestrator (Carbon)",
          input: 1_000_000,
          totOut: 100_000,
          respId: "m05-r1",
        },
      ]);

      await pm.initialize();
      await store.scanIncremental(pm);

      // New and release-day records resolve to gemini-4-2-carbon, while 2026-11-18 stays gemini-4-carbon
      expect(dayModels("2027-03-05")).toEqual([{ model: "gemini-4-2-carbon", messages: 1, cost: 7.5, unpriced: false }]);
      expect(dayModels("2027-03-01")).toEqual([{ model: "gemini-4-2-carbon", messages: 1, cost: 7.5, unpriced: false }]);
      expect(dayModels("2026-11-18")).toEqual([{ model: "gemini-4-carbon", messages: 1, cost: 6, unpriced: false }]);

      // Offline rebuildAll preserves contemporaneous model assignments for both old and new eras
      const offlinePm = new PricingManager({
        cachePath,
        now: () => clock + 48 * HOUR,
        fetch: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
      });
      await offlinePm.initialize();
      await store.rebuildAll(offlinePm);

      expect(dayModels("2026-11-14")).toEqual([
        { model: "gemini-4-argon", messages: 2, cost: 6, unpriced: false },
        { model: "gemini-3-8-flash", messages: 1, cost: 1.125, unpriced: false },
      ]);
      expect(dayModels("2026-11-18")).toEqual([{ model: "gemini-4-carbon", messages: 1, cost: 6, unpriced: false }]);
      expect(dayModels("2027-03-01")).toEqual([{ model: "gemini-4-2-carbon", messages: 1, cost: 7.5, unpriced: false }]);
      expect(dayModels("2027-03-05")).toEqual([{ model: "gemini-4-2-carbon", messages: 1, cost: 7.5, unpriced: false }]);
    } finally {
      store.close();
    }
  });

  test("scanOpenCodeDb advances incrementally by rowid/time_updated and resets on DB recreation, and UsageService scans off-thread in Worker (quota-and-usage.md §3.1, §3.7)", async () => {
    const d = tempDir("opencode-worker");
    const fakeHome = join(d, "home");
    const ocDir = join(fakeHome, ".local", "share", "opencode");
    mkdirSync(ocDir, { recursive: true });
    const ocDbPath = join(ocDir, "opencode.db");

    const origData = process.env.XDG_DATA_HOME;
    const origCodex = process.env.CODEX_HOME;
    process.env.XDG_DATA_HOME = join(fakeHome, ".local", "share");
    process.env.CODEX_HOME = join(fakeHome, "codex");

    try {
      const ocDb = new Database(ocDbPath);
      ocDb.run(`
        CREATE TABLE session_message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          seq INTEGER NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL
        );
      `);
      const ins = ocDb.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', ?, ?, ?, ?)"
      );
      const t1 = (() => {
        const day = new Date();
        day.setHours(10, 0, 0, 0);
        return day.getTime();
      })();
      ins.run("m1", "s1", 1, t1, t1, JSON.stringify({ model: "claude-sonnet-4-6", tokens: { input: 100, output: 20, cache: { read: 50, write: 0 } } }));
      ins.run("m2", "s1", 2, t1 + 1000, t1 + 1000, JSON.stringify({ model: "claude-sonnet-4-6", tokens: { input: 200, output: 30, cache: { read: 0, write: 0 } } }));

      let cursorProgress: [number, number] = [0, 0];
      const initial = scanOpenCodeDb(ocDbPath, { skipped: 0 }, {
        lastRowId: 0,
        lastUpdatedMs: 0,
        onProgress: (r, u) => (cursorProgress = [r, u]),
      });
      expect(initial).toHaveLength(2);
      expect(cursorProgress).toEqual([2, t1 + 1000]);

      // Append a new message + update an existing message via time_updated
      const t2 = t1 + 120_000;
      ins.run("m3", "s1", 3, t2, t2, JSON.stringify({ model: "claude-sonnet-4-6", tokens: { input: 300, output: 40, cache: { read: 100, write: 0 } } }));
      ocDb.run("UPDATE session_message SET time_updated = ?, data = ? WHERE id = 'm1'", [
        t2 + 1000,
        JSON.stringify({ model: "claude-sonnet-4-6", tokens: { input: 150, output: 25, cache: { read: 80, write: 0 } } }),
      ]);

      const delta = scanOpenCodeDb(ocDbPath, { skipped: 0 }, {
        lastRowId: cursorProgress[0],
        lastUpdatedMs: cursorProgress[1],
        onProgress: (r, u) => (cursorProgress = [r, u]),
      });
      expect(delta.map((r) => r.messageKey).sort()).toEqual(["m1", "m2", "m3"]);
      expect(delta.find((r) => r.messageKey === "m1")?.inputTokens).toBe(150);
      expect(cursorProgress).toEqual([3, t2 + 1000]);

      // Run UsageService with Worker enabled (scan + rebuild)
      const cachePath = join(d, "pricing-cache.json");
      writeFileSync(
        cachePath,
        JSON.stringify({
          fetchedAt: Date.now(),
          models: { "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
        }),
        "utf-8"
      );

      let updatedEvents = 0;
      const debugLines: string[] = [];
      const svc = new UsageService({
        useWorker: true,
        dbPath: join(d, "usage.db"),
        pricingCachePath: cachePath,
        home: fakeHome,
        onUpdated: () => updatedEvents++,
        debugLogger: (m) => debugLines.push(m),
      });
      try {
        const res1 = await svc.scan();
        expect(res1.recordsAdded).toBeGreaterThanOrEqual(3);
        expect(updatedEvents).toBe(1);
        expect(debugLines.some((l) => l.includes("debug usage scan start"))).toBe(true);
        expect(debugLines.some((l) => l.includes("debug usage scan done"))).toBe(true);

        const rep = await svc.getUsage({ preset: "today", agents: ["opencode"] });
        expect(rep.totals.messages).toBe(3);
        // After DB recreation (max rowid drops back to 1), scanOpenCodeDb resets and scans full
        ocDb.run("DELETE FROM session_message");
        ins.run("m_new", "s2", 1, t2 + 5000, t2 + 5000, JSON.stringify({ model: "claude-sonnet-4-6", tokens: { input: 50, output: 10, cache: { read: 0, write: 0 } } }));
        const resetScan = scanOpenCodeDb(ocDbPath, { skipped: 0 }, {
          lastRowId: cursorProgress[0],
          lastUpdatedMs: cursorProgress[1],
        });
        expect(resetScan.map((r) => r.messageKey)).toEqual(["m_new"]);

        const rebuilt = await svc.rebuild();
        expect(rebuilt.recordCount).toBe(1);
      } finally {
        svc.destroy();
      }
      ocDb.close();
    } finally {
      if (origData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = origData;
      if (origCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = origCodex;
    }
  });
});
