import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { THEMES } from "../src/client/src/themes";
import { state, setTheme, getSubPanes } from "../src/client/src/state/store";

function hexToRgb(hex: string): [number, number, number] {
  const cleanHex = hex.replace("#", "");
  const num = parseInt(cleanHex, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(hex1: string, hex2: string): number {
  const lum1 = relativeLuminance(hexToRgb(hex1));
  const lum2 = relativeLuminance(hexToRgb(hex2));
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

describe("Pigeon Mobile Client UI & Contract Suite", () => {
  const rootDir = join(import.meta.dir, "..");

  test("HTML entry point declares interactive-widget=resizes-content for modern Chromium", () => {
    const htmlPath = join(rootDir, "index.html");
    expect(existsSync(htmlPath)).toBe(true);
    const content = readFileSync(htmlPath, "utf-8");

    expect(content).toContain("interactive-widget=resizes-content");
    expect(content).toContain(".touch-target");
    expect(content).toContain("min-height: 44px");
    expect(content).toContain("min-width: 44px");
  });

  test("All 6 theme presets exist and Pigeon Light passes WCAG AA contrast (>= 4.5:1)", () => {
    const expectedThemes = [
      "pigeon-dark",
      "pigeon-light",
      "terminal-amber",
      "cyber-cyan",
      "tokyo-night",
      "monokai-pro",
    ];

    for (const themeId of expectedThemes) {
      expect(THEMES[themeId]).toBeDefined();
      expect(THEMES[themeId].bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(THEMES[themeId].fg).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }

    const light = THEMES["pigeon-light"];
    const fgContrast = contrastRatio(light.bg, light.fg);
    expect(fgContrast).toBeGreaterThanOrEqual(4.5);

    const faintContrast = contrastRatio(light.bg, light.faint);
    expect(faintContrast).toBeGreaterThanOrEqual(4.5);
  });

  test("Client state store initializes and handles sub-pane projections", () => {
    expect(state.connected).toBe(false);
    expect(state.themeId).toBeDefined();

    // Verify sub-pane calculation
    const panes = getSubPanes();
    expect(Array.isArray(panes)).toBe(true);
  });

  test("MacroDock and UI components enforce safeguards: 44px touch targets and IME guards", () => {
    const macroDockPath = join(rootDir, "src", "client", "src", "components", "MacroDock.tsx");
    expect(existsSync(macroDockPath)).toBe(true);
    const code = readFileSync(macroDockPath, "utf-8");

    // Double-tap Ctrl+C safeguard with 800ms confirmation window
    expect(code).toContain("800");
    expect(code).toContain("Confirm Ctrl+C");
    expect(code).toContain("ctrl+c");

    // Chinese/Japanese IME composition check
    expect(code.toLowerCase()).toContain("compositionstart");
    expect(code.toLowerCase()).toContain("compositionend");
    expect(code).toContain("isComposing");

    // Touch target enforcement
    expect(code).toContain('class="touch-target"');
  });

  test("Single-file production bundle dist/index.html is built and inlines assets", () => {
    const distHtmlPath = join(rootDir, "dist", "index.html");
    expect(existsSync(distHtmlPath)).toBe(true);
    const content = readFileSync(distHtmlPath, "utf-8");

    // Must inline JS script and CSS without external link stylesheets or script src
    expect(content).toContain("<script");
    expect(content).not.toContain('<script type="module" src="/src/client');
    expect(content.length).toBeGreaterThan(10000);
  });

});
