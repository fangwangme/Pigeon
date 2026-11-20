import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PricingManager } from "../src/server/usage/pricing";
import { tempDir } from "./helpers/fixtures";

describe("PricingManager fallback and retry (quota-and-usage.md §3.3)", () => {
  const testDir = tempDir("pricing");

  test("falls back to stale cache (>24h) on network failure and keeps prices available", async () => {
    const cachePath = join(testDir, "stale-pricing.json");
    const twoDaysAgo = Date.now() - 48 * 3600 * 1000;
    writeFileSync(
      cachePath,
      JSON.stringify({
        schemaVersion: 3,
        fetchedAt: twoDaysAgo,
        entries: {
          "claude-3-5-sonnet": { inputCostPerToken: 0.000003, outputCostPerToken: 0.000015, tier: "official-global", source: "anthropic" },
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

  test("an offline retry that reloads the same stale catalog is not a catalog change", async () => {
    const cachePath = join(testDir, "stale-retry.json");
    writeFileSync(cachePath, JSON.stringify({ schemaVersion: 3, fetchedAt: Date.now() - 48 * 3600 * 1000, entries: { "claude-3-5-sonnet": { inputCostPerToken: 0.000003, outputCostPerToken: 0.000015, tier: "official-global", source: "anthropic" } } }));
    let clock = Date.now();
    const pm = new PricingManager({ cachePath, fetch: (() => Promise.reject(new Error("offline"))) as any, now: () => clock, retryIntervalMs: 1000 });
    await pm.initialize();
    const loaded = pm.getCatalogVersion();
    clock += 2000;
    await pm.initialize();
    expect(pm.getCatalogVersion()).toBe(loaded);
  });

  test("does not set loaded = true permanently on complete failure, allowing retry", async () => {
    const cachePath = join(testDir, "nonexistent-pricing.json");

    let networkAttempts = 0;
    let shouldFail = true;
    const mockFetch = () => {
      networkAttempts++;
      if (shouldFail) return Promise.reject(new Error("network error"));
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            "claude-3-5-sonnet": { litellm_provider: "anthropic", input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
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
    expect(networkAttempts).toBe(2); // attempted both sources once

    // Call initialize again immediately: should be throttled by nextRetryAt
    await pm.initialize();
    expect(networkAttempts).toBe(2); // did not retry within cooldown

    // After retry interval:
    fakeNow += 10 * 60 * 1000 + 1;
    await pm.initialize();
    expect(networkAttempts).toBe(4); // retried after cooldown
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

  test("succeeds when a pricing source takes 3s to respond (quota-and-usage.md §3.3)", async () => {
    const cachePath = join(testDir, "slow-source-pricing.json");
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.includes("models.dev")) return new Response("Not Found", { status: 404 });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 3_000);
        const onAbort = () => {
          clearTimeout(timer);
          reject(init?.signal?.reason ?? new Error("Aborted"));
        };
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener("abort", onAbort, { once: true });
      });
      return Response.json({
        anthropic: { models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6", cost: { input: 3, output: 15 } } } },
      });
    }) as unknown as typeof fetch;

    const pm = new PricingManager({ cachePath, fetch: mockFetch });
    await pm.initialize();

    expect(pm.arePricesAvailable()).toBe(true);
    expect(pm.getPrice("claude-sonnet-4-6")).toMatchObject({
      inputCostPerToken: 3 / 1_000_000,
      outputCostPerToken: 15 / 1_000_000,
    });
  }, 10_000);

  test("LiteLLM official-global owner entries outrank models.dev regional entries", async () => {
    const cachePath = join(testDir, "global-before-regional.json");
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.includes("models.dev")) return new Response("Not Found", { status: 404 });
      return Response.json({
        zhipuai: { models: { "glm-5.3": { id: "glm-5.3", cost: { input: 5, output: 20 } } } },
        "minimax-cn": { models: { "minimax-m3.1-flash": { id: "minimax-m3.1-flash", cost: { input: 5, output: 20 } } } },
        "moonshotai-cn": { models: { "kimi-k3": { id: "kimi-k3", cost: { input: 5, output: 20 } } } },
      });
    }) as unknown as typeof fetch;
    const litellmFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes("models.dev")) return mockFetch(input);
      return Response.json({
        "glm-5.3": { litellm_provider: "zai", input_cost_per_token: 1.4e-6, output_cost_per_token: 4.4e-6 },
        "minimax-m3.1-flash": { litellm_provider: "minimax", input_cost_per_token: 0.15e-6, output_cost_per_token: 0.6e-6 },
        "kimi-k3": { litellm_provider: "moonshot", input_cost_per_token: 3e-6, output_cost_per_token: 15e-6 },
      });
    }) as unknown as typeof fetch;

    const pm = new PricingManager({ cachePath, fetch: litellmFetch });
    await pm.initialize();

    expect(pm.getPrice("glm-5-3")).toMatchObject({ inputCostPerToken: 1.4 / 1_000_000, tier: "official-global", source: "zai" });
    expect(pm.getPrice("minimax-m3-1-flash")).toMatchObject({ inputCostPerToken: 0.15 / 1_000_000, tier: "official-global", source: "minimax" });
    expect(pm.getPrice("kimi-k3")).toMatchObject({ inputCostPerToken: 3 / 1_000_000, tier: "official-global", source: "moonshot" });
  });

  test("bare owner names are official for their owner, not fallback", async () => {
    const cachePath = join(testDir, "bare-owners.json");
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.includes("models.dev")) return new Response("Not Found", { status: 404 });
      return Response.json({
        thinkingmachines: { models: { "thinkingmachines/Inkling": { id: "thinkingmachines/Inkling", cost: { input: 1, output: 2 } } } },
        meta: { models: { muse: { id: "muse", cost: { input: 1, output: 2 } } } },
        nvidia: { models: { nemotron: { id: "nemotron", cost: { input: 1, output: 2 } } } },
        openrouter: {
          models: {
            "thinkingmachines/inkling": { id: "thinkingmachines/inkling", cost: { input: 0.1, output: 0.2 } },
            "meta/muse": { id: "meta/muse", cost: { input: 0.1, output: 0.2 } },
            "nvidia/nemotron": { id: "nvidia/nemotron", cost: { input: 0.1, output: 0.2 } },
          },
        },
      });
    }) as unknown as typeof fetch;

    const pm = new PricingManager({ cachePath, fetch: mockFetch });
    await pm.initialize();

    expect(pm.getPrice("inkling")).toMatchObject({ inputCostPerToken: 1 / 1_000_000, tier: "official-global", source: "thinkingmachines" });
    expect(pm.getPrice("muse")).toMatchObject({ inputCostPerToken: 1 / 1_000_000, tier: "official-global", source: "meta" });
    expect(pm.getPrice("nemotron")).toMatchObject({ inputCostPerToken: 1 / 1_000_000, tier: "official-global", source: "nvidia" });
  });
});
