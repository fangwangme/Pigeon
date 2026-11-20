import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PricingManager } from "../src/server/usage/pricing";
import { tempDir } from "./helpers/fixtures";

// Issue #39. quota-and-usage.md §3.3 Sources, Identity, Selection.

const M = 1_000_000;

function catalogFetch(modelsDev: unknown, litellm: unknown = null, state: { modelsDevOk: boolean } = { modelsDevOk: true }) {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes("models.dev")) {
      return state.modelsDevOk ? Response.json(modelsDev) : new Response("err", { status: 500 });
    }
    if (url.includes("litellm") && litellm) return Response.json(litellm);
    return new Response("Not Found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function managerFor(name: string, modelsDev: unknown, litellm: unknown = null): Promise<PricingManager> {
  const pm = new PricingManager({ cachePath: join(tempDir(name), "pricing.json"), fetch: catalogFetch(modelsDev, litellm) });
  await pm.initialize();
  return pm;
}

describe("official-first price selection (quota-and-usage.md §3.3)", () => {
  test("global official beats regional official and resellers, whatever the catalog order", async () => {
    const pm = await managerFor("policy-glm", {
      jzstoken: { models: { "glm-5.3": { id: "glm-5.3", cost: { input: 0.5, output: 1 } }, "glm-7": { id: "glm-7", cost: { input: 0.5, output: 1 } } } },
      zhipuai: {
        models: {
          "glm-5.3": { id: "glm-5.3", cost: { input: 1.19516, output: 4.18306, cache_read: 0.29879, cache_write: 0 } },
          "glm-6": { id: "glm-6", cost: { input: 2, output: 8 } },
        },
      },
      zai: { models: { "glm-5.3": { id: "glm-5.3", cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 } } } },
    });

    expect(pm.getPrice("glm-5.3")).toMatchObject({
      inputCostPerToken: 1.4 / M,
      outputCostPerToken: 4.4 / M,
      cacheReadCostPerToken: 0.26 / M,
      cacheWriteCostPerToken: 0,
      tier: "official-global",
      source: "zai",
    });
    expect(pm.getPrice("glm-6")).toMatchObject({ inputCostPerToken: 2 / M, tier: "official-regional", source: "zhipuai" });
    // A reseller is neither official nor one of the three fallback providers.
    expect(pm.getPrice("glm-7")).toBeNull();
  });

  test("Google beats Vertex, Vertex covers what Google lacks, and LiteLLM adds only allowlisted official entries", async () => {
    const pm = await managerFor(
      "policy-google",
      {
        "google-vertex": {
          models: {
            "gemini-4-x": { id: "gemini-4-x", cost: { input: 3, output: 12 } },
            "gemini-4-y": { id: "gemini-4-y", cost: { input: 1, output: 5, cache_read: 0.1 } },
          },
        },
        google: { models: { "gemini-4-x": { id: "gemini-4-x", cost: { input: 2, output: 10, cache_read: 0.2 } } } },
      },
      {
        "vertex_ai/gemini-3-pro-preview": {
          litellm_provider: "vertex_ai",
          input_cost_per_token: 2e-6,
          output_cost_per_token: 1.2e-5,
          cache_read_input_token_cost: 2e-7,
        },
        "coralbricks/gemini-4-z": { litellm_provider: "coralbricks", input_cost_per_token: 1e-8, output_cost_per_token: 1e-8 },
        "vertex_ai/claude-x-9": { litellm_provider: "vertex_ai-anthropic_models", input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
      }
    );

    expect(pm.getPrice("gemini-4-x")).toMatchObject({ inputCostPerToken: 2 / M, tier: "official-global", source: "google" });
    expect(pm.getPrice("gemini-4-y")).toMatchObject({ inputCostPerToken: 1 / M, tier: "official-global", source: "google-vertex" });
    expect(pm.getPrice("gemini-3-pro")).toMatchObject({
      inputCostPerToken: 2e-6,
      outputCostPerToken: 1.2e-5,
      cacheReadCostPerToken: 2e-7,
      tier: "official-global",
    });
    expect(pm.getPrice("gemini-4-z")).toBeNull();
    expect(pm.getPrice("claude-x-9")).toBeNull();
  });

  test("without an official entry, OpenRouter > Vercel > Cloudflare; hosted $0 entries and -MMDD variants never stand in", async () => {
    const pm = await managerFor("policy-fallback", {
      "cloudflare-workers-ai": {
        models: {
          "@cf/nvidia/nemotron-3": { id: "@cf/nvidia/nemotron-3", cost: { input: 0.1, output: 0.5 } },
          "@cf/acme/acme-1": { id: "@cf/acme/acme-1", cost: { input: 0.2, output: 0.4 } },
        },
      },
      vercel: {
        models: {
          "thinkingmachines/inkling-2-small": { id: "thinkingmachines/inkling-2-small", cost: { input: 0.3, output: 1 } },
          "nvidia/nemotron-3": { id: "nvidia/nemotron-3", cost: { input: 0.15, output: 0.65 } },
        },
      },
      nvidia: { models: { "deepseek-ai/deepseek-v4.1-flash": { id: "deepseek-ai/deepseek-v4.1-flash", cost: { input: 0, output: 0 } } } },
      deepseek: { models: { "deepseek-flash": { id: "deepseek-flash", cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
      openrouter: {
        models: {
          "deepseek/deepseek-v4.1-flash-1017": { id: "deepseek/deepseek-v4.1-flash-1017", cost: { input: 0.036, output: 0.5, cache_read: 0.01 } },
          "deepseek/deepseek-v4.1-flash": { id: "deepseek/deepseek-v4.1-flash", cost: { input: 0.3, output: 1.2, cache_read: 0.006 } },
          "thinkingmachines/inkling-2-small": { id: "thinkingmachines/inkling-2-small", cost: { input: 0.5, output: 2 } },
        },
      },
    });

    expect(pm.getPrice("deepseek-v4.1-flash")).toMatchObject({
      inputCostPerToken: 0.3 / M,
      outputCostPerToken: 1.2 / M,
      cacheReadCostPerToken: 0.006 / M,
      tier: "fallback-openrouter",
      source: "openrouter",
    });
    expect(pm.getPrice("deepseek-v4.1-flash-free")).toMatchObject({ inputCostPerToken: 0.3 / M, tier: "fallback-openrouter" });
    expect(pm.getPrice("deepseek-v4.1-flash-1017")).toMatchObject({ inputCostPerToken: 0.036 / M, tier: "fallback-openrouter" });
    expect(pm.getPrice("inkling-2-small")).toMatchObject({ inputCostPerToken: 0.5 / M, tier: "fallback-openrouter" });
    expect(pm.getPrice("nemotron-3")).toMatchObject({ inputCostPerToken: 0.15 / M, tier: "fallback-vercel", source: "vercel" });
    expect(pm.getPrice("acme-1")).toMatchObject({ inputCostPerToken: 0.2 / M, tier: "fallback-cloudflare" });
  });

  test("a same-source collision takes the exact ID, or skips that provider when no entry is exact and prices disagree", async () => {
    const pm = await managerFor("policy-collision", {
      anthropic: {
        models: {
          "claude-opus-4-5-20251101": { id: "claude-opus-4-5-20251101", cost: { input: 5, output: 25 } },
          "claude-opus-4-5": { id: "claude-opus-4-5", cost: { input: 6, output: 30 } },
        },
      },
      openrouter: {
        models: {
          "acme/widget-2-thinking": { id: "acme/widget-2-thinking", cost: { input: 1, output: 2 } },
          "acme/widget-2-high": { id: "acme/widget-2-high", cost: { input: 3, output: 4 } },
        },
      },
      vercel: { models: { "acme/widget-2": { id: "acme/widget-2", cost: { input: 5, output: 6 } } } },
    });

    expect(pm.getPrice("claude-opus-4-5")).toMatchObject({ inputCostPerToken: 6 / M, tier: "official-global" });
    expect(pm.getPrice("widget-2")).toMatchObject({ inputCostPerToken: 5 / M, tier: "fallback-vercel" });
  });

  test("a models.dev failure keeps the loaded prices and leaves the disk cache untouched", async () => {
    const cachePath = join(tempDir("policy-failure"), "pricing.json");
    let clock = Date.parse("2026-11-20T10:00:00Z");
    const state = { modelsDevOk: true };
    const fetchFn = catalogFetch(
      { anthropic: { models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6", cost: { input: 3, output: 15 } } } } },
      { "claude-sonnet-4-6": { litellm_provider: "anthropic", input_cost_per_token: 9e-6, output_cost_per_token: 9e-5 } },
      state
    );
    const pm = new PricingManager({ cachePath, now: () => clock, fetch: fetchFn });
    await pm.initialize();
    expect(pm.getPrice("claude-sonnet-4-6")).toMatchObject({ inputCostPerToken: 3 / M, source: "anthropic" });
    const cached = readFileSync(cachePath, "utf-8");

    state.modelsDevOk = false;
    clock += 25 * 3600_000;
    await pm.initialize();

    expect(readFileSync(cachePath, "utf-8")).toBe(cached);
    expect(pm.getPrice("claude-sonnet-4-6")).toMatchObject({ inputCostPerToken: 3 / M, source: "anthropic" });
  });
});
