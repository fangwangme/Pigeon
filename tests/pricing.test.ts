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
});
