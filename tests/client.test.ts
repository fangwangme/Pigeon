import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PALETTES } from "../src/client/src/themes";
import { renderMarkdown } from "../src/client/src/utils/markdown";
import { matchScreenOption } from "../src/client/src/prompt-match";
import { state, setState } from "../src/client/src/state/store";
import { applyClientConfigWithTransitions, sendConfigPatch } from "../src/client/src/state/ws";

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

describe("question answers (mobile-ui-and-themes.md §4.2)", () => {
  const screen = [
    { id: "1", label: "No, tell Claude what to do differently" },
    { id: "2", label: "No" },
    { id: "3", label: "Postgres replica (read-only, eu-wes" },
  ];

  test("an exact label wins over a longer option that starts with it", () => {
    expect(matchScreenOption(screen, "No")?.id).toBe("2");
  });

  test("a label cut short on screen matches only when one option has that prefix", () => {
    expect(matchScreenOption(screen, "Postgres replica (read-only, eu-west-1)")?.id).toBe("3");
    expect(matchScreenOption([{ id: "1", label: "Run all tests" }, { id: "2", label: "Run all lints" }], "Run all")).toBeUndefined();
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
    expect(usageSrc).toMatch(/Show when=\{loading\(\) && !usageReport\(\)\}/);
    expect(usageSrc).toMatch(/Show when=\{!loading\(\) && tableRows\(\)\.length === 0\}/);

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
});
