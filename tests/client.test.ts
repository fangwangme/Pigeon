import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PALETTES } from "../src/client/src/themes";
import { formatModelNameWithRecipes } from "../src/client/src/utils/model-name";
import { renderMarkdown } from "../src/client/src/utils/markdown";
import { callCommand, callInputText } from "../src/client/src/utils/tool-call";
import type { NormalizedToolCall } from "../src/types/protocol";
import { state, setState, quotaButtonShown, quotaUsageTarget } from "../src/client/src/state/store";
import { applyClientConfigWithTransitions, sendConfigPatch, handleServerMessage, initWebSocket } from "../src/client/src/state/ws";

const rootDir = join(import.meta.dir, "..");

function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("themes (mobile-ui-and-themes.md §9.1)", () => {
  test.each(["light", "dark"] as const)("%s: text tokens meet WCAG AA against the background", (mode) => {
    const p = PALETTES[mode];
    for (const token of [p.fg, p.muted, p.faint]) expect(contrast(p.bg, token)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(["light", "dark"] as const)("%s: the selected segment stands apart from its track", (mode) => {
    const p = PALETTES[mode];
    expect(contrast(p.segTrack, p.segOn)).toBeGreaterThanOrEqual(1.15);
  });
});

describe("tool details (mobile-ui-and-themes.md §3.3)", () => {
  test("a lightweight call without input shows its target and an empty input instead of throwing", () => {
    const light = { id: "c1", name: "exec", verb: "run", target: "bun test", status: "completed" } as unknown as NormalizedToolCall;
    expect(callCommand(light)).toBe("bun test");
    expect(callInputText(light)).toBe("");
  });

  test("a loaded call shows its own command and input", () => {
    const arr = { id: "c2", name: "shell", verb: "run", target: "x", input: { command: ["bash", "-lc", "ls"] }, status: "completed" } as unknown as NormalizedToolCall;
    expect(callCommand(arr)).toBe("bash -lc ls");
    expect(callInputText(arr)).toBe(JSON.stringify({ command: ["bash", "-lc", "ls"] }, null, 2));
  });
});

describe("Markdown rendering (mobile-ui-and-themes.md §3.1)", () => {
  test("tables, lists and code render as HTML", () => {
    const html = renderMarkdown("- a\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```");
    expect(html).toContain("<ul>");
    expect(html).toContain("<table>");
    expect(html).toContain("<code");
  });

  test("links open outside the app with noopener (architecture.md §5)", () => {
    const html = renderMarkdown("[docs](https://example.com)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="https://example.com"');
  });

  test.each([
    ['<img src="x" onerror="alert(1)">', "onerror"],
    ["<script>window.pwned = true;</script>", "<script"],
    ["[click](javascript:alert(1))", "javascript:"],
    ["[click](data:text/html,<script>alert(1)</script>)", "data:"],
    ["[click](blob:https://example.com/123)", "blob:"],
    ["[click](file:///etc/passwd)", "file:"],
  ])("agent output cannot inject script or disallowed URI schemes: %s", (input, forbidden) => {
    expect(renderMarkdown(input)).not.toContain(forbidden);
  });
});

describe("installable app (architecture.md §2)", () => {
  /** Runs public/sw.js against a stand-in service-worker global and returns its listeners. */
  function loadServiceWorker() {
    const listeners: Record<string, (event: any) => void> = {};
    let skipped = 0;
    const self = {
      addEventListener: (type: string, fn: (event: any) => void) => (listeners[type] = fn),
      skipWaiting: () => skipped++,
      clients: { claim: () => Promise.resolve() },
    };
    new Function("self", "caches", "fetch", readFileSync(join(rootDir, "public", "sw.js"), "utf-8"))(self, {}, () => undefined);
    return { listeners, skipped: () => skipped };
  }

  test("a new service worker waits until the page asks it to take over", () => {
    const sw = loadServiceWorker();
    sw.listeners.install?.({ waitUntil: () => undefined });
    expect(sw.skipped()).toBe(0);
    sw.listeners.message({ data: { type: "SKIP_WAITING" } });
    expect(sw.skipped()).toBe(1);
  });
});

describe("quota and usage switches (mobile-ui-and-themes.md §11.1, §11.4)", () => {
  test("quotaEnabled and usageEnabled share one entry button", () => {
    const prev = {
      quotaEnabled: state.quotaEnabled,
      usageEnabled: state.usageEnabled,
      quotaButton: state.quotaButton,
    };
    try {
      setState("quotaButton", true);
      setState("quotaEnabled", false);
      setState("usageEnabled", true);
      expect(quotaButtonShown()).toBe(true);
      expect(quotaUsageTarget()).toBe("usage");

      setState("quotaEnabled", true);
      setState("usageEnabled", false);
      expect(quotaButtonShown()).toBe(true);
      expect(quotaUsageTarget()).toBe("quota");

      setState("quotaEnabled", true);
      setState("usageEnabled", true);
      expect(quotaButtonShown()).toBe(true);
      expect(quotaUsageTarget()).toBe("quota");

      setState("quotaEnabled", false);
      setState("usageEnabled", false);
      expect(quotaButtonShown()).toBe(false);

      setState("quotaEnabled", true);
      setState("usageEnabled", true);
      setState("quotaButton", false);
      expect(quotaButtonShown()).toBe(false);
    } finally {
      setState(prev);
    }
  });

  test("client state transitions clear only the disabled feature and apply push updates (quota-and-usage.md §1.1, protocol.md §5.11–§5.12)", () => {
    // 1. Turning off quotaEnabled clears quotaSnapshots/quotaUpdated without clearing usageScannedAt
    setState("quotaEnabled", true);
    setState("usageEnabled", true);
    setState("quotaSnapshots", [{ provider: "claude" as const, enabled: true, snapshot: null, error: null }]);
    setState("quotaUpdated", 1700000000000);
    setState("usageScannedAt", 1700000005000);

    applyClientConfigWithTransitions({ quotaEnabled: false });
    expect(state.quotaEnabled).toBe(false);
    expect(state.quotaSnapshots).toEqual([]);
    expect(state.quotaUpdated).toBeNull();
    expect(state.usageEnabled).toBe(true);
    expect(state.usageScannedAt).toBe(1700000005000);

    // 2. Push events update store silently when enabled
    applyClientConfigWithTransitions({ quotaEnabled: true });
    handleServerMessage({
      type: "quota_updated",
      payload: {
        providers: [{ provider: "claude", enabled: true, snapshot: { provider: "claude", windows: [], credits: [], fetchedAt: 1700000020000 }, error: null }],
        fetchedAt: 1700000020000,
      },
    });
    expect(state.quotaUpdated).toBe(1700000020000);
    expect(state.quotaSnapshots[0]?.snapshot?.fetchedAt).toBe(1700000020000);

    handleServerMessage({
      type: "usage_updated",
      payload: { scannedAt: 1700000030000 },
    });
    expect(state.usageScannedAt).toBe(1700000030000);

    // 3. sendConfigPatch turning off quotaEnabled clears snapshots immediately; usageEnabled off clears usageScannedAt
    void sendConfigPatch({ quotaEnabled: false });
    expect(state.quotaEnabled).toBe(false);
    expect(state.quotaSnapshots).toEqual([]);
    expect(state.quotaUpdated).toBeNull();
    expect(state.usageScannedAt).toBe(1700000030000);

    void sendConfigPatch({ usageEnabled: false });
    expect(state.usageEnabled).toBe(false);
    expect(state.usageScannedAt).toBeNull();
  });

  test("sendConfigPatch turn-on waits for server ack then reads cached quota on initiating phone (quota-and-usage.md §1.1)", async () => {
    const sentFrames: any[] = [];
    let fakeWsInstance: any = null;
    const origWs = globalThis.WebSocket;
    const origFetch = globalThis.fetch;
    const origWindow = globalThis.window;

    try {
      globalThis.window = {
        location: { protocol: "http:", host: "localhost", hash: "" },
      } as any;

      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ authenticated: true }),
      })) as any;

      class FakeClientWs {
        static OPEN = 1;
        readyState = 1;
        _onopen: any = null;
        onmessage: any = null;
        onclose: any = null;
        constructor() {
          fakeWsInstance = this;
        }
        set onopen(fn: any) {
          this._onopen = fn;
          queueMicrotask(() => fn?.());
        }
        get onopen() {
          return this._onopen;
        }
        send(data: string) {
          sentFrames.push(JSON.parse(data));
        }
        close() {
          this.readyState = 3;
          this.onclose?.({ code: 4409 });
        }
      }
      globalThis.WebSocket = FakeClientWs as any;

      await initWebSocket();
      await new Promise((r) => setTimeout(r, 10));
      expect(state.connected).toBe(true);

      // Start in disabled state with empty snapshots
      setState("quotaEnabled", false);
      setState("quotaSnapshots", []);
      sentFrames.length = 0;

      // 1. Turning on sends config_patch
      const patchPromise = sendConfigPatch({ quotaEnabled: true });
      const patchFrame = sentFrames.find((f) => f.type === "config_patch");
      expect(patchFrame).toBeDefined();
      expect(patchFrame.payload.client.quotaEnabled).toBe(true);

      // 2. Before server ack arrives, quota_get MUST NOT be sent yet
      expect(sentFrames.some((f) => f.type === "quota_get")).toBe(false);

      // 3. Server sends ack
      handleServerMessage({
        type: "ack",
        replyTo: patchFrame.id,
        payload: { status: "ok", version: 42 },
      });

      await patchPromise;

      // 4. After server ack, quota_get is sent
      expect(sentFrames.some((f) => f.type === "quota_get")).toBe(true);
    } finally {
      if (fakeWsInstance) {
        fakeWsInstance.close();
      }
      globalThis.WebSocket = origWs;
      globalThis.fetch = origFetch;
      globalThis.window = origWindow;
    }
  });
});

describe("model names (mobile-ui-and-themes.md §6.4)", () => {
  test("searches multiple agents in order and skips unresolved label === id entries", () => {
    const recipes = {
      codex: { models: [{ id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" }] },
      claude: { models: [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }] },
    };
    expect(formatModelNameWithRecipes(recipes, ["codex", "claude"], "claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
  });

  test("matches Antigravity models across tier suffixes and strips bracketed tiers", () => {
    const recipes = {
      agy: {
        models: [
          { id: "MODEL_CLAUDE_4_5_SONNET_HIGH", label: "Claude Sonnet 4.5 (High)" },
          { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
        ],
      },
    };
    expect(formatModelNameWithRecipes(recipes, "agy", "claude-sonnet-4-5-low")).toBe("Claude Sonnet 4.5");
    expect(formatModelNameWithRecipes(recipes, ["codex", "agy"], "gemini-3.1-pro-low")).toBe("Gemini 3.1 Pro");
    expect(formatModelNameWithRecipes(recipes, "agy", "google/gemini-3-flash (Minimal)")).toBe("gemini-3-flash");
  });
});

describe("code blocks and heatmap scales (mobile-ui-and-themes.md §3.2, §9.1)", () => {
  test("a code block gets a header bar with its language", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toMatch(/class="cb-hdr"[^]*ts/);
  });

  test("both themes share one heatmap scale, light to dark, so more reads darker in either", () => {
    const keys = Object.keys(PALETTES.light).filter((k) => /^heat(Tokens|Cost)\d$/.test(k)) as Array<keyof typeof PALETTES.light>;
    expect(keys).toHaveLength(10);
    for (const k of keys) expect(PALETTES.dark[k]).toBe(PALETTES.light[k]);
    expect(luminance(PALETTES.light.heatTokens1)).toBeGreaterThan(luminance(PALETTES.light.heatTokens5));
    expect(luminance(PALETTES.light.heatCost1)).toBeGreaterThan(luminance(PALETTES.light.heatCost5));
  });
});
