import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingManager } from "../src/server/usage/pricing";

describe("PricingManager fallback and retry (quota-and-usage.md §3.3)", () => {
  const testDir = join(tmpdir(), `pigeon_pricing_test_${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  test("falls back to stale cache (>24h) on network failure and keeps prices available", async () => {
    const cachePath = join(testDir, "stale-pricing.json");
    const twoDaysAgo = Date.now() - 48 * 3600 * 1000;
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: twoDaysAgo,
        entries: {
          "claude-3-5-sonnet": { inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 },
        },
      })
    );

    // Mock fetch to simulate offline
    const mockOfflineFetch = () => Promise.reject(new Error("offline"));

    const pm = new PricingManager({ cachePath, fetch: mockOfflineFetch as any });
    await pm.initialize();

    expect(pm.arePricesAvailable()).toBe(true);
    expect(pm.getPrice("claude-3-5-sonnet")).toMatchObject({
      inputCostPerToken: 0.000003,
    });
  });

  test("does not set loaded = true permanently on complete failure, allowing retry", async () => {
    const cachePath = join(testDir, "nonexistent-pricing.json");

    let networkAttempts = 0;
    let shouldFail = true;
    const mockFetch = (url: any) => {
      networkAttempts++;
      if (shouldFail) return Promise.reject(new Error("network error"));
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            "claude-3-5-sonnet": { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
          }),
      } as any);
    };

    let fakeNow = 1_000_000;
    const pm = new PricingManager({ cachePath, fetch: mockFetch as any, now: () => fakeNow });
    await pm.initialize();
    expect(pm.arePricesAvailable()).toBe(false);

    // Now network recovers and retry cooldown passes
    shouldFail = false;
    fakeNow += 11 * 60 * 1000;

    // Second initialize should retry network fetch
    await pm.initialize();
    expect(pm.arePricesAvailable()).toBe(true);
    expect(networkAttempts).toBeGreaterThanOrEqual(2);
  });

  test("throttles network retry on failure so foreground scans do not stall repeatedly", async () => {
    const cachePath = join(testDir, "throttled-pricing.json");
    let networkAttempts = 0;
    const mockFetch = () => {
      networkAttempts++;
      return Promise.reject(new Error("network timeout"));
    };

    let fakeNow = 1_000_000;
    const pm = new PricingManager({ cachePath, fetch: mockFetch as any, now: () => fakeNow });
    await pm.initialize();
    expect(networkAttempts).toBe(3); // attempted 3 sources once

    // Call initialize again immediately: should be throttled by nextRetryAt
    await pm.initialize();
    expect(networkAttempts).toBe(3); // did not retry within cooldown

    // After retry interval:
    fakeNow += 10 * 60 * 1000 + 1;
    await pm.initialize();
    expect(networkAttempts).toBe(6); // retried after cooldown
  });

  test("refreshes stale catalog after 24h TTL and prefers first-party models.dev providers", async () => {
    const cachePath = join(testDir, "ttl-first-party.json");
    let version = 1;
    let clock = Date.parse("2026-11-10T10:00:00Z");
    let fetchCount = 0;

    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.includes("models.dev")) return new Response("Not Found", { status: 404 });
      fetchCount++;
      const scale = version;
      // Place third-party reseller before first-party provider to verify priority order
      return Response.json({
        zenmux: { models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6", cost: { input: 99, output: 999 } } } },
        anthropic: { models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6", cost: { input: 3 * scale, output: 15 * scale } } } },
      });
    }) as unknown as typeof fetch;

    const pm = new PricingManager({ cachePath, now: () => clock, fetch: mockFetch });
    await pm.initialize();
    expect(fetchCount).toBe(1);
    expect(pm.getPrice("claude-sonnet-4-6")).toMatchObject({
      inputCostPerToken: 3 / 1_000_000,
      outputCostPerToken: 15 / 1_000_000,
    });

    clock += 12 * 3600_000;
    await pm.initialize();
    expect(fetchCount).toBe(1);

    version = 2;
    clock += 13 * 3600_000;
    await pm.initialize();
    expect(fetchCount).toBe(2);
    expect(pm.getPrice("claude-sonnet-4-6")).toMatchObject({
      inputCostPerToken: 6 / 1_000_000,
      outputCostPerToken: 30 / 1_000_000,
    });
  });
});
