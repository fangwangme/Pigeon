import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PALETTES } from "../src/client/src/themes";
import { renderMarkdown } from "../src/client/src/utils/markdown";

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

describe("themes (mobile-ui-and-themes.md §4)", () => {
  test("every preset pack named by the spec has a light and a dark variant", () => {
    for (const key of ["tokyo-night", "claude", "github", "gruvbox", "catppuccin", "pigeon"]) {
      expect(PALETTES[key]?.light.bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(PALETTES[key]?.dark.bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  test("Pigeon Light's faint text meets WCAG AA against its background (§4.2)", () => {
    const light = PALETTES.pigeon.light;
    expect(contrast(light.bg, light.faint)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light.bg, light.fg)).toBeGreaterThanOrEqual(4.5);
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
  ])("agent output cannot inject script: %s", (input, forbidden) => {
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
