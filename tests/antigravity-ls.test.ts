import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isLoopbackAddress,
  parseProcessListCandidates,
  discoverDaemonHubFiles,
  discoverAntigravityLs,
  syncAntigravityDesktopSessions,
} from "../src/server/usage/antigravity-ls";
import { scanAntigravityCacheDb } from "../src/server/usage/sources";

describe("Antigravity Language Server discovery and native cache (quota-and-usage.md §2.2, §3.1, security-and-pairing.md §6)", () => {
  test("loopback address validation accepts local interfaces and rejects external hosts", () => {
    expect(isLoopbackAddress("127.0.0.1:12345")).toBe(true);
    expect(isLoopbackAddress("localhost:54321")).toBe(true);
    expect(isLoopbackAddress("[::1]:8080")).toBe(true);
    expect(isLoopbackAddress("http://127.0.0.1:9090")).toBe(true);

    expect(isLoopbackAddress("192.168.1.5:8080")).toBe(false);
    expect(isLoopbackAddress("10.0.0.1:8080")).toBe(false);
    expect(isLoopbackAddress("example.com:8080")).toBe(false);
    expect(isLoopbackAddress("0.0.0.0:8080")).toBe(false);
  });

  test("process list parsing extracts port, csrf token, and prioritizes desktop over CLI", () => {
    const mockPsOutput = [
      "  101 /bin/bash /some/script",
      "  202 /opt/Antigravity/antigravity --type=renderer --something",
      "  303 /home/user/.local/share/agy/antigravity language_server --port 41845 --csrf_token cli-secret",
      "  404 /opt/Antigravity/resources/bin/language_server --extension_server_port 43915 --csrf_token desktop-secret",
    ];

    const candidates = parseProcessListCandidates(mockPsOutput);
    expect(candidates).toHaveLength(2);

    // Desktop candidate
    const desktop = candidates.find((c) => c.pid === 404);
    expect(desktop).toBeDefined();
    expect(desktop?.runtimeKind).toBe("desktop");
    expect(desktop?.port).toBe(43915);
    expect(desktop?.csrfToken).toBe("desktop-secret");

    // CLI candidate
    const cli = candidates.find((c) => c.pid === 303);
    expect(cli).toBeDefined();
    expect(cli?.runtimeKind).toBe("cli");
    expect(cli?.port).toBe(41845);
    expect(cli?.csrfToken).toBe("cli-secret");

    // Verify sorting order: desktop has higher priority than cli
    const priorityOrder: Record<string, number> = { desktop: 3, ide: 2, cli: 1 };
    candidates.sort((a, b) => priorityOrder[b.runtimeKind] - priorityOrder[a.runtimeKind]);
    expect(candidates[0].runtimeKind).toBe("desktop");
    expect(candidates[1].runtimeKind).toBe("cli");
  });

  test("daemon hub file discovery reads port and csrf token for live processes", () => {
    const testDir = join("/tmp", `pigeon-hub-test-${Date.now()}`);
    const daemonDir = join(testDir, ".gemini", "antigravity", "daemon");
    mkdirSync(daemonDir, { recursive: true });

    // Write a mock hub json pointing to the current test process PID (guaranteed alive)
    const hubFile = join(daemonDir, "hub_43915.json");
    writeFileSync(
      hubFile,
      JSON.stringify({
        pid: process.pid,
        httpPort: 43915,
        csrfToken: "live-csrf-token",
        lsVersion: "2.29.1",
      })
    );

    const candidates = discoverDaemonHubFiles(testDir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].pid).toBe(process.pid);
    expect(candidates[0].port).toBe(43915);
    expect(candidates[0].csrfToken).toBe("live-csrf-token");
    expect(candidates[0].runtimeKind).toBe("desktop");

    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  test("discovery refuses a non-loopback override address", async () => {
    const conn = await discoverAntigravityLs({ address: "192.168.1.50:45678" });
    expect(conn).toBeNull();
  });

  test("syncs .pb session usage from loopback LS mock into Pigeon native cache, caches mtimes, and survives LS offline", async () => {
    const testDir = join("/tmp", `pigeon-ls-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const testHome = join(testDir, "home");
    const testConversations = join(testHome, ".gemini", "antigravity", "conversations");
    const testCacheDb = join(testDir, "cache.db");

    mkdirSync(testConversations, { recursive: true });
    // Write a sample .pb file
    const sampleSessionId = "c4d7e8f9a0b1c2d3e4f50123456789ab";
    const samplePbFile = join(testConversations, `${sampleSessionId}.pb`);
    writeFileSync(samplePbFile, Buffer.from("dummy-pb-content"));

    // Write a .db file to ensure LS sync ignores .db files (handled by scanAntigravityDb directly)
    const sampleDbSessionId = "d5e8f9a0b1c2d3e4f50123456789ab01";
    const sampleDbFile = join(testConversations, `${sampleDbSessionId}.db`);
    writeFileSync(sampleDbFile, Buffer.from("dummy-db-content"));

    let metadataRequests = 0;

    // Start mock Language Server
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/RetrieveUserQuotaSummary")) {
          return Response.json({
            response: {
              groups: [
                {
                  name: "Gemini",
                  models: ["gemini-2.5-pro"],
                  userTier: "PRO",
                  rateLimit: { periodDurationMs: 18000000, nextResetTimestamp: new Date(Date.now() + 3600000).toISOString() },
                  quotaUsageHistory: { currentPeriodUsagePercent: 35 },
                },
              ],
            },
          });
        }

        if (url.pathname.endsWith("/GetAllCascadeTrajectories")) {
          return Response.json({
            trajectorySummaries: [
              {
                cascadeId: sampleSessionId,
                stepCount: 2,
              },
            ],
          });
        }

        if (url.pathname.endsWith("/GetCascadeTrajectoryGeneratorMetadata")) {
          metadataRequests++;
          return Response.json({
            generatorMetadata: [
              {
                chatModel: {
                  model: "MODEL_PLACEHOLDER_M319",
                  responseModel: "gemini-2.5-pro",
                  modelDisplayName: "Gemini 2.5 Pro",
                  chatStartMetadata: { createdAt: Date.now() - 60000 },
                  retryInfos: [
                    {
                      usage: {
                        inputTokens: 1200,
                        outputTokens: 300,
                        cacheReadTokens: 400,
                        cacheWriteTokens: 0,
                        timestamp: Date.now() - 50000,
                        responseId: "resp_step1",
                      },
                    },
                  ],
                },
              },
            ],
          });
        }

        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const conn = await discoverAntigravityLs({
        address: `127.0.0.1:${server.port}`,
        csrfToken: "mock-csrf-token",
      });

      expect(conn).not.toBeNull();
      expect(conn?.port).toBe(server.port);

      // Initial sync
      const syncedCount = await syncAntigravityDesktopSessions(conn!, testCacheDb, testHome);
      expect(syncedCount).toBe(1);
      expect(metadataRequests).toBe(1);

      // Verify records in Pigeon native cache.db
      const records = scanAntigravityCacheDb(testCacheDb);
      expect(records.length).toBe(1);
      expect(records[0].sessionId).toBe(sampleSessionId);
      expect(records[0].inputTokens).toBe(1200);
      expect(records[0].outputTokens).toBe(300);
      expect(records[0].cacheReadTokens).toBe(400);
      expect(records[0].totalTokens).toBe(1900);

      // Second sync without file modification should skip RPC
      const secondSynced = await syncAntigravityDesktopSessions(conn!, testCacheDb, testHome);
      expect(secondSynced).toBe(0);
      expect(metadataRequests).toBe(1); // Not re-requested

      // Stop mock server to simulate LS offline
      server.stop(true);

      // When LS is offline, sync returns 0 without crashing
      const offlineSynced = await syncAntigravityDesktopSessions(conn!, testCacheDb, testHome);
      expect(offlineSynced).toBe(0);

      // Existing cached data remains intact and readable
      const offlineRecords = scanAntigravityCacheDb(testCacheDb);
      expect(offlineRecords.length).toBe(1);
      expect(offlineRecords[0].sessionId).toBe(sampleSessionId);
    } finally {
      server.stop(true);
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
    }
  });

  test("syncAntigravityDesktopSessions migrates legacy cache schema, persists modelDisplayName, and resolves it ahead of routing responseModel slugs (quota-and-usage.md §3.1, §3.2)", async () => {
    const testDir = join("/tmp", `pigeon-ls-display-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const testHome = join(testDir, "home");
    const testConversations = join(testHome, ".gemini", "antigravity", "conversations");
    const testCacheDb = join(testDir, "cache.db");

    mkdirSync(testConversations, { recursive: true });
    const sessionId = "a1b2c3d4e5f60123456789abcdef0123";
    writeFileSync(join(testConversations, `${sessionId}.pb`), Buffer.from("pb-session"));

    // Seed legacy cache.db without display_name column to verify in-place migration
    const legacyDb = new Database(testCacheDb);
    legacyDb.run(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        client TEXT,
        last_modified_ms INTEGER,
        step_count INTEGER
      );
      CREATE TABLE session_usage (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        client TEXT,
        model_enum TEXT,
        served_model TEXT,
        model_id TEXT,
        timestamp INTEGER,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        response_id TEXT,
        step_index INTEGER DEFAULT 0
      );
    `);
    legacyDb.close();

    const tsBase = Date.parse("2026-11-18T12:00:00Z");
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/RetrieveUserQuotaSummary")) {
          return Response.json({ response: { groups: [] } });
        }
        if (url.pathname.endsWith("/GetAllCascadeTrajectories")) {
          return Response.json({ trajectorySummaries: [{ cascadeId: sessionId, stepCount: 2 }] });
        }
        if (url.pathname.endsWith("/GetCascadeTrajectoryGeneratorMetadata")) {
          return Response.json({
            generatorMetadata: [
              {
                chatModel: {
                  model: "MODEL_PLACEHOLDER_M669",
                  responseModel: "gemini-flash-worker-agy",
                  modelDisplayName: "Gemini 4 Hydrogen (Orchestrator)",
                  chatStartMetadata: { createdAt: tsBase },
                  retryInfos: [
                    {
                      usage: {
                        inputTokens: "4000",
                        outputTokens: "800",
                        cacheReadTokens: "1200",
                        cacheWriteTokens: "0",
                        timestamp: tsBase,
                        responseId: "resp_w1",
                      },
                    },
                  ],
                },
              },
              {
                chatModel: {
                  model: "MODEL_PLACEHOLDER_M669",
                  responseModel: "gemini-flash-worker-agy",
                  chatStartMetadata: { createdAt: tsBase + 5_000 },
                  retryInfos: [
                    {
                      usage: {
                        inputTokens: "1000",
                        outputTokens: "200",
                        cacheReadTokens: "0",
                        cacheWriteTokens: "0",
                        timestamp: tsBase + 5_000,
                        responseId: "resp_w2",
                      },
                    },
                  ],
                },
              },
            ],
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const conn = await discoverAntigravityLs({
        address: `127.0.0.1:${server.port}`,
        csrfToken: "mock-csrf",
      });
      expect(conn).not.toBeNull();

      const synced = await syncAntigravityDesktopSessions(conn!, testCacheDb, testHome);
      expect(synced).toBe(1);

      const verifyDb = new Database(testCacheDb, { readonly: true });
      const cols = (verifyDb.query("PRAGMA table_info('session_usage')").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain("display_name");
      const rawRow = verifyDb
        .query("SELECT display_name FROM session_usage WHERE response_id = 'resp_w1'")
        .get() as { display_name: string | null } | null;
      expect(rawRow?.display_name).toBe("Gemini 4 Hydrogen (Orchestrator)");
      verifyDb.close();

      const records = scanAntigravityCacheDb(testCacheDb);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        canonicalModelId: "gemini-4-hydrogen",
        inputTokens: 4000,
        outputTokens: 800,
        cacheReadTokens: 1200,
        totalTokens: 6000,
      });
      expect(records[1]).toMatchObject({
        canonicalModelId: "gemini-4-hydrogen",
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
      });
    } finally {
      server.stop(true);
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
