import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyTheme } from "../src/client/src/themes";

const rootDir = join(import.meta.dir, "..");

describe("dark mode anti-flash (mobile-ui-and-themes.md §9.1, issue #7)", () => {
  test("test_html_head_color_scheme_meta: <head> declares color-scheme meta tag with light dark support", () => {
    const html = readFileSync(join(rootDir, "index.html"), "utf-8");
    const head = html.split("</head>")[0] || "";
    expect(head).toMatch(/<meta\s+name=["']color-scheme["']\s+content=["']light dark["']\s*\/?>/i);
  });

  test("test_html_critical_inline_css: <head> has critical inline style setting dark/light background and color-scheme", () => {
    const html = readFileSync(join(rootDir, "index.html"), "utf-8");
    const head = html.split("</head>")[0] || "";
    expect(head).toContain("<style>");
    expect(head).toContain("color-scheme: light dark");
    expect(head).toContain("#111113");
  });

  test("test_theme_sets_color_scheme: applyTheme and inline script synchronize colorScheme on documentElement", () => {
    const html = readFileSync(join(rootDir, "index.html"), "utf-8");
    expect(html).toContain("root.style.colorScheme");

    const setProps: Record<string, string> = {};
    const setAttrs: Record<string, string> = {};
    const mockRoot = {
      setAttribute: (k: string, v: string) => (setAttrs[k] = v),
      style: {
        setProperty: (k: string, v: string) => (setProps[k] = v),
        colorScheme: "",
      },
    };
    (globalThis as any).document = {
      documentElement: mockRoot,
      querySelector: () => null,
    };
    try {
      applyTheme("dark", "blue");
      expect(mockRoot.style.colorScheme).toBe("dark");
      expect(setAttrs["data-theme"]).toBe("dark");

      applyTheme("light", "blue");
      expect(mockRoot.style.colorScheme).toBe("light");
      expect(setAttrs["data-theme"]).toBe("light");
    } finally {
      delete (globalThis as any).document;
    }
  });
});
