import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("Pigeon Specifications & Contract Tests", () => {
  const specsDir = join(import.meta.dir, "..", "docs", "specs");

  test("Pigeon Light theme contrast calibration satisfies WCAG AA (>= 4.5:1)", () => {
    const bgLight = "#F6F7F9";
    const fgLight = "#161A1F";
    const faintLightCalibrated = "#5C6675"; // Calibrated from #697381 to exceed 4.5:1

    const fgContrast = contrastRatio(bgLight, fgLight);
    expect(fgContrast).toBeGreaterThanOrEqual(4.5);

    const faintContrast = contrastRatio(bgLight, faintLightCalibrated);
    expect(faintContrast).toBeGreaterThanOrEqual(4.5);
  });

  test("Protocol spec defines safe interaction answering and heartbeats", () => {
    const protocolPath = join(specsDir, "protocol.md");
    expect(existsSync(protocolPath)).toBe(true);
    const content = readFileSync(protocolPath, "utf-8");

    // Must define interaction_respond with fingerprint validation to fix P0-1
    expect(content).toContain("interaction_respond");
    expect(content).toContain("interactionId");
    expect(content).toContain("fingerprint");
    expect(content).toContain("ERR_INTERACTION_STALE");

    // Must define application heartbeats and reconnection state to fix P0-2
    expect(content).toContain('"type": "ping"');
    expect(content).toContain('"type": "pong"');
    expect(content).toContain("pane_state");
    expect(content).toContain("4401");
  });

  test("Herdr adapter spec aligns with Herdr 0.9.5 socket events and state machine", () => {
    const adapterPath = join(specsDir, "herdr-adapter.md");
    expect(existsSync(adapterPath)).toBe(true);
    const content = readFileSync(adapterPath, "utf-8");

    // Must use events.subscribe rather than polling
    expect(content).toContain("events.subscribe");
    expect(content).toContain("pane_output_changed");
    expect(content).toContain("revision");

    // Must declare complete 5-state lifecycle
    expect(content).toContain("idle");
    expect(content).toContain("done");
    expect(content).toContain("working");
    expect(content).toContain("blocked");
    expect(content).toContain("unknown");

    // Must specify two-phase tab & agent start with name regex
    expect(content).toContain("tab.create");
    expect(content).toContain("agent.start");
    expect(content).toContain("[a-z][a-z0-9_-]{0,31}");
  });

  test("Security spec mandates QR-code-only pairing, fragment tokens, and admin socket", () => {
    const securityPath = join(specsDir, "security-and-pairing.md");
    expect(existsSync(securityPath)).toBe(true);
    const content = readFileSync(securityPath, "utf-8");

    expect(content).toContain("#code=");
    expect(content).toContain("Base32");
    expect(content).toContain("QR code");
    expect(content).toContain("__Host-pigeon_session");
    expect(content).toContain("pigeon.sock");
  });

  test("Mobile UI spec enforces Chromium target, 44px hit areas, and contextual safeguards", () => {
    const uiPath = join(specsDir, "mobile-ui-and-themes.md");
    expect(existsSync(uiPath)).toBe(true);
    const content = readFileSync(uiPath, "utf-8");

    expect(content).toContain("interactive-widget=resizes-content");
    expect(content).toContain("44px");
    expect(content).toContain("compositionstart");
    expect(content).toContain("Double-tap");
  });

  test("Web push spec defines subscription and presence suppression", () => {
    const pushPath = join(specsDir, "push.md");
    expect(existsSync(pushPath)).toBe(true);
    const content = readFileSync(pushPath, "utf-8");

    expect(content).toContain("VAPID");
    expect(content).toContain("push_subscribe");
    expect(content).toContain("Presence Suppression");
  });

  test("README indexes all 6 specification files", () => {
    const readmePath = join(specsDir, "README.md");
    expect(existsSync(readmePath)).toBe(true);
    const content = readFileSync(readmePath, "utf-8");

    const expectedSpecs = [
      "architecture.md",
      "protocol.md",
      "herdr-adapter.md",
      "security-and-pairing.md",
      "mobile-ui-and-themes.md",
      "push.md",
    ];

    for (const spec of expectedSpecs) {
      expect(content).toContain(spec);
    }
  });
});
