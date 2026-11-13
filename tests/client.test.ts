import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PALETTES } from "../src/client/src/themes";
import { renderMarkdown } from "../src/client/src/utils/markdown";
import { state, setState } from "../src/client/src/state/store";
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
  test("the manifest opens the app standalone at /", () => {
    const manifest = JSON.parse(readFileSync(join(rootDir, "public", "manifest.webmanifest"), "utf-8"));
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
  });

  test("the viewport resizes content for the on-screen keyboard (mobile-ui-and-themes.md §1.2)", () => {
    expect(readFileSync(join(rootDir, "index.html"), "utf-8")).toContain("interactive-widget=resizes-content");
  });

  test("a home-screen app keeps an opaque status bar (mobile-ui-and-themes.md §1.1)", () => {
    expect(readFileSync(join(rootDir, "index.html"), "utf-8")).not.toContain("apple-mobile-web-app-status-bar-style");
  });

  test("a double tap never zooms the page (mobile-ui-and-themes.md §1.1)", () => {
    const css = readFileSync(join(rootDir, "src", "client", "src", "styles.css"), "utf-8");
    expect(css).toMatch(/^\*, \*::before, \*::after \{ touch-action: manipulation; \}$/m);
  });

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

describe("mobile layout enhancements (mobile-ui-and-themes.md §1.2, §2.1)", () => {
  test("Home header renders the compact Logo mark instead of plain text Pigeon", () => {
    const homeSrc = readFileSync(join(rootDir, "src", "client", "src", "components", "Home.tsx"), "utf-8");
    expect(homeSrc).toMatch(/class="logo-mark"[^>]*>[\s\S]*?<Logo/);
    expect(homeSrc).not.toContain('<div class="lt">Pigeon</div>');
  });

  test("Composer stylesheet allows up to 280px max-height with vertical scrolling", () => {
    const css = readFileSync(join(rootDir, "src", "client", "src", "styles.css"), "utf-8");
    expect(css).toMatch(/\.comp textarea\s*\{[^}]*max-height:\s*280px/);
    expect(css).toMatch(/\.comp textarea\s*\{[^}]*overflow-y:\s*auto/);
    const composerSrc = readFileSync(join(rootDir, "src", "client", "src", "components", "Composer.tsx"), "utf-8");
    expect(composerSrc).toContain("Math.min(ta.scrollHeight, 280)");
  });

  test("master switch quotaUsageEnabled gates gauge buttons on Home and All Agents (mobile-ui-and-themes.md §11.1, §11.4)", () => {
    const homeSrc = readFileSync(join(rootDir, "src", "client", "src", "components", "Home.tsx"), "utf-8");
    // Verify both header gauge buttons check quotaButtonShown or quotaUsageEnabled
    const matches = [...homeSrc.matchAll(/<Show when=\{([^}]+)\}>\s*<button aria-label=\{t\("quota\.title"\)\}/g)];
    expect(matches.length).toBe(2);
    for (const m of matches) {
      expect(m[1]).toMatch(/quotaButtonShown|quotaUsageEnabled/);
    }

    const settingsSrc = readFileSync(join(rootDir, "src", "client", "src", "components", "Settings.tsx"), "utf-8");
    expect(settingsSrc).toContain("quotaUsageEnabled");

    const indexSrc = readFileSync(join(rootDir, "src", "client", "src", "index.tsx"), "utf-8");
    expect(indexSrc).toContain("quotaFeatureOn");
  });

  test("Quota and Usage pages render skeleton templates and loading animations before data arrives", () => {
    const css = readFileSync(join(rootDir, "src", "client", "src", "styles.css"), "utf-8");
    expect(css).toContain(".skel");
    expect(css).toContain("skel-pulse");

    const quotaSrc = readFileSync(join(rootDir, "src", "client", "src", "components", "QuotaPage.tsx"), "utf-8");
    expect(quotaSrc).toContain("showSkeleton");
    expect(quotaSrc).toContain("quota.loading");
    expect(quotaSrc).toMatch(/Show when=\{!showSkeleton\(\) && !hasAnyData\(\)\}/);

    const usageSrc = readFileSync(join(rootDir, "src", "client", "src", "components", "UsagePage.tsx"), "utf-8");
    expect(usageSrc).toContain("usage.loading");
    expect(usageSrc).toMatch(/Show when=\{isLoading\(\) && !usageReport\(\)\}/);
    expect(usageSrc).toMatch(/Show when=\{!isLoading\(\) && tableRows\(\)\.length === 0\}/);

    const wsSrc = readFileSync(join(rootDir, "src", "client", "src", "state", "ws.ts"), "utf-8");
    expect(wsSrc).toMatch(/res\.fetchedAt/);
  });

  test("client state transitions clear snapshots on toggle-off and restore on toggle-on (quota-and-usage.md §1.1)", () => {
    // Setup state as enabled with mock snapshots and updated timestamp
    setState("quotaUsageEnabled", true);
    setState("quotaSnapshots", [{ provider: "claude" as const, enabled: true, snapshot: null, error: null }]);
    setState("quotaUpdated", 1700000000000);

    // 1. applyClientConfigWithTransitions toggling off clears snapshots and updated timestamp
    applyClientConfigWithTransitions({ quotaUsageEnabled: false });
    expect(state.quotaUsageEnabled).toBe(false);
    expect(state.quotaSnapshots).toEqual([]);
    expect(state.quotaUpdated).toBeNull();

    // 2. sendConfigPatch on initiating phone also clears snapshots immediately on toggle-off
    setState("quotaUsageEnabled", true);
    setState("quotaSnapshots", [{ provider: "codex" as const, enabled: true, snapshot: null, error: null }]);
    setState("quotaUpdated", 1700000010000);

    // Calling sendConfigPatch with quotaUsageEnabled: false
    void sendConfigPatch({ quotaUsageEnabled: false });
    expect(state.quotaUsageEnabled).toBe(false);
    expect(state.quotaSnapshots).toEqual([]);
    expect(state.quotaUpdated).toBeNull();
  });

  test("sendConfigPatch turn-on waits for server ack then fetches quota on initiating phone (quota-and-usage.md §1.1)", async () => {
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
      setState("quotaUsageEnabled", false);
      setState("quotaSnapshots", []);
      sentFrames.length = 0;

      // 1. Turning on sends config_patch
      const patchPromise = sendConfigPatch({ quotaUsageEnabled: true });
      const patchFrame = sentFrames.find((f) => f.type === "config_patch");
      expect(patchFrame).toBeDefined();
      expect(patchFrame.payload.client.quotaUsageEnabled).toBe(true);

      // 2. Before server ack arrives, quota_get MUST NOT be sent yet
      expect(sentFrames.some((f) => f.type === "quota_get")).toBe(false);

      // 3. Server sends ack
      handleServerMessage({
        type: "ack",
        replyTo: patchFrame.id,
        payload: { status: "ok", version: 42 },
      });

      await patchPromise;

      // 4. After server ack, quota_get is sent to fetch fresh quota!
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
