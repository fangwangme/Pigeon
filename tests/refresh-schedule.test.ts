import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigManager } from "../src/server/config-manager";
import { HerdrClient } from "../src/server/herdr-client";
import { PushManager } from "../src/server/push";
import { QuotaService } from "../src/server/quota/index";
import { SkillScanner } from "../src/server/skill-scanner";
import { UsageService } from "../src/server/usage/index";
import { UsageStore } from "../src/server/usage/store";
import { WsServer } from "../src/server/ws-server";
import type { ClientConfig } from "../src/types/protocol";
import { fakeWs, tempDir } from "./helpers/fixtures";

// Issue #29. quota-and-usage.md §2.6, §3.7; protocol.md §4.16–§4.19, §5.11–§5.12.

const MIN = 60_000;

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function setup(client: Partial<ClientConfig>) {
  const d = tempDir("refresh-schedule");
  const home = join(d, "home");
  mkdirSync(home, { recursive: true });
  const cfg = new ConfigManager(join(d, "config.json"), { HOME: home });
  cfg.patchClientConfig({ usageScanInterval: "1m", quotaProviders: { claude: true, codex: false, antigravity: false }, ...client });

  const counts = { fetches: 0, scans: 0 };
  const snapshot = (provider: string) => ({ provider, windows: [], credits: [], fetchedAt: Date.now() });
  const quota = new QuotaService({
    configManager: cfg,
    claude: { fetch: async () => (counts.fetches++, snapshot("claude")) } as any,
    codex: { fetch: async () => snapshot("codex") } as any,
    antigravity: { fetch: async () => snapshot("antigravity") } as any,
  });
  const store = new UsageStore({ dbPath: join(d, "usage.db"), home, discoverLs: async () => null });
  store.scanIncremental = async () => (counts.scans++, { scannedFiles: 0, recordsAdded: 0 });
  const usage = new UsageService({
    configManager: cfg,
    store,
    pricing: { initialize: async () => {}, arePricesAvailable: () => false } as any,
  });
  const server = new WsServer({
    buildId: "build_refresh",
    herdrClient: new HerdrClient({ appSocketPath: join(d, "none-app.sock"), coreSocketPath: join(d, "none-core.sock") }),
    pushManager: new PushManager(join(d, "vapid.json")),
    configManager: cfg,
    skillScanner: new SkillScanner(home),
    quotaService: quota,
    usageService: usage,
  });
  return { server, counts };
}

let active: WsServer | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
  jest.useRealTimers();
});

describe("one daemon-owned refresh schedule (quota-and-usage.md §2.6)", () => {
  test("with no phone connected, the daemon refreshes both enabled items at start and on every tick", async () => {
    jest.useFakeTimers();
    const { server, counts } = setup({ quotaEnabled: true, usageEnabled: true });
    active = server;
    await flush();
    expect(counts).toEqual({ fetches: 1, scans: 1 });

    jest.advanceTimersByTime(MIN - 1);
    await flush();
    expect(counts).toEqual({ fetches: 1, scans: 1 });

    jest.advanceTimersByTime(1);
    await flush();
    expect(counts).toEqual({ fetches: 2, scans: 2 });
  });

  test("a tick refreshes only the enabled item: with quota off it scans usage alone", async () => {
    jest.useFakeTimers();
    const { server, counts } = setup({ quotaEnabled: false, usageEnabled: true });
    active = server;
    await flush();
    jest.advanceTimersByTime(MIN);
    await flush();
    expect(counts).toEqual({ fetches: 0, scans: 2 });
  });

  test("phones connecting and disconnecting more often than the interval neither delay nor add ticks", async () => {
    jest.useFakeTimers();
    const { server, counts } = setup({ quotaEnabled: true, usageEnabled: true });
    active = server;
    await flush();
    expect(counts).toEqual({ fetches: 1, scans: 1 });

    // The phone reconnects every ~15 s, as in the field logs of issue #29.
    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(10_000);
      const phone = fakeWs(`dev_${i}`);
      server.handleOpen(phone.ws);
      await flush();
      jest.advanceTimersByTime(4_000);
      server.handleClose(phone.ws);
      await flush();
    }
    expect(counts).toEqual({ fetches: 1, scans: 1 });

    jest.advanceTimersByTime(MIN - 56_000);
    await flush();
    expect(counts).toEqual({ fetches: 2, scans: 2 });
  });
});

describe("requested refresh and cache reads (protocol.md §4.16–§4.19)", () => {
  test("each page's Refresh refreshes only its own item, without moving the timer; other reads refresh nothing", async () => {
    jest.useFakeTimers();
    const { server, counts } = setup({ quotaEnabled: true, usageEnabled: true });
    active = server;
    await flush();
    expect(counts).toEqual({ fetches: 1, scans: 1 });

    const phone = fakeWs();
    server.handleOpen(phone.ws);
    jest.advanceTimersByTime(20_000);

    await server.handleMessage(phone.ws, JSON.stringify({ type: "quota_get", id: "q_refresh", payload: { refresh: true } }));
    expect(counts).toEqual({ fetches: 2, scans: 1 });
    expect(phone.sent.find((m) => m.type === "ack" && m.replyTo === "q_refresh")).toBeDefined();
    expect(phone.ofType("quota_updated").length).toBeGreaterThan(0);

    const all = ["claude", "codex", "agy", "opencode", "pi"];
    await server.handleMessage(phone.ws, JSON.stringify({ type: "usage_get", id: "u_force", payload: { preset: "7d", agents: all, force: true } }));
    expect(counts).toEqual({ fetches: 2, scans: 2 });
    expect(phone.sent.find((m) => m.type === "ack" && m.replyTo === "u_force")).toBeDefined();

    await server.handleMessage(phone.ws, JSON.stringify({ type: "quota_get", id: "q_read", payload: {} }));
    await server.handleMessage(phone.ws, JSON.stringify({ type: "usage_get", id: "u_read", payload: { preset: "7d", agents: all } }));
    await server.handleMessage(phone.ws, JSON.stringify({ type: "usage_day", id: "u_day", payload: { date: "2026-11-17", agents: all } }));
    await server.handleMessage(
      phone.ws,
      JSON.stringify({ type: "usage_model", id: "u_model", payload: { model: "m", from: "2026-11-01", to: "2026-11-17", agents: all } }),
    );
    for (const id of ["q_read", "u_read", "u_day", "u_model"]) {
      expect(phone.sent.find((m) => m.type === "ack" && m.replyTo === id)).toBeDefined();
    }
    expect(counts).toEqual({ fetches: 2, scans: 2 });

    // The requested refreshes at 20 s did not push the tick back: it still fires at 60 s.
    jest.advanceTimersByTime(MIN - 20_000);
    await flush();
    expect(counts).toEqual({ fetches: 3, scans: 3 });
  });
});
