import type { AccentName, ThemeMode } from "../../types/protocol";
import type { MessageId } from "./i18n";

// mobile-ui-and-themes.md §9.1: two palettes, one accent. Components use the CSS tokens only.

export interface Palette {
  bg: string;
  surface: string;
  elev: string;
  fg: string;
  muted: string;
  faint: string;
  line: string;
  line2: string;
  warn: string;
  warnbg: string;
  danger: string;
  dangerbg: string;
  addbg: string;
  addfg: string;
  delbg: string;
  delfg: string;
  code: string;
  bubble: string;
  unread: string;
  /** Liquid Glass fills and edges (§9.2). */
  lgFill: string;
  lgFillStrong: string;
  lgEdge: string;
  lgHi: string;
  lgLo: string;
  lgShadow: string;
  lgSpec: string;
  scrim: string;
}

export const PALETTES: Record<"light" | "dark", Palette> = {
  dark: {
    bg: "#111113",
    surface: "#1c1c1f",
    elev: "#232327",
    fg: "#F2F2F3",
    muted: "#A3A3AB",
    faint: "#86868F",
    line: "rgba(255,255,255,.08)",
    line2: "rgba(255,255,255,.14)",
    warn: "#F2B45C",
    warnbg: "rgba(242,180,92,.14)",
    danger: "#FF6B6B",
    dangerbg: "rgba(255,107,107,.13)",
    addbg: "rgba(92,203,117,.15)",
    addfg: "#5CCB75",
    delbg: "rgba(255,125,125,.14)",
    delfg: "#FF7D7D",
    code: "#18181B",
    bubble: "#2B2B30",
    unread: "#4C8DFF",
    lgFill: "rgba(46,46,54,.36)",
    lgFillStrong: "rgba(32,32,38,.66)",
    lgEdge: "rgba(255,255,255,.15)",
    lgHi: "rgba(255,255,255,.24)",
    lgLo: "rgba(255,255,255,.05)",
    lgShadow: "0 10px 30px rgba(0,0,0,.38)",
    lgSpec: "rgba(255,255,255,.16)",
    scrim: "rgba(0,0,0,.42)",
  },
  light: {
    bg: "#F8F8F6",
    surface: "#FFFFFF",
    elev: "#FFFFFF",
    fg: "#18181A",
    muted: "#55555C",
    faint: "#6A6A72",
    line: "rgba(0,0,0,.08)",
    line2: "rgba(0,0,0,.13)",
    warn: "#9A5B00",
    warnbg: "rgba(166,98,0,.1)",
    danger: "#C62F2F",
    dangerbg: "rgba(207,52,52,.09)",
    addbg: "rgba(30,138,58,.1)",
    addfg: "#1E7A34",
    delbg: "rgba(199,50,50,.09)",
    delfg: "#B82E2E",
    code: "#F1F1EE",
    bubble: "#EBEBE8",
    unread: "#2F6FE4",
    lgFill: "rgba(255,255,255,.46)",
    lgFillStrong: "rgba(255,255,255,.76)",
    lgEdge: "rgba(255,255,255,.75)",
    lgHi: "rgba(255,255,255,.95)",
    lgLo: "rgba(0,0,0,.05)",
    lgShadow: "0 10px 30px rgba(0,0,0,.13)",
    lgSpec: "rgba(255,255,255,.55)",
    scrim: "rgba(0,0,0,.28)",
  },
};

export const ACCENTS: Record<AccentName, { light: string; dark: string; label: MessageId }> = {
  blue: { light: "#1F6FEB", dark: "#5B9CFF", label: "accent.blue" },
  purple: { light: "#7445D6", dark: "#A98BFF", label: "accent.purple" },
  green: { light: "#0F7F6C", dark: "#5FC7B2", label: "accent.green" },
  orange: { light: "#B85400", dark: "#F0A050", label: "accent.orange" },
  pink: { light: "#C0306B", dark: "#F07AA8", label: "accent.pink" },
};

const KEBAB: Record<keyof Palette, string> = {
  bg: "bg",
  surface: "surface",
  elev: "elev",
  fg: "fg",
  muted: "muted",
  faint: "faint",
  line: "line",
  line2: "line2",
  warn: "warn",
  warnbg: "warnbg",
  danger: "danger",
  dangerbg: "dangerbg",
  addbg: "addbg",
  addfg: "addfg",
  delbg: "delbg",
  delfg: "delfg",
  code: "code",
  bubble: "bubble",
  unread: "unread",
  lgFill: "lg-fill",
  lgFillStrong: "lg-fill-strong",
  lgEdge: "lg-edge",
  lgHi: "lg-hi",
  lgLo: "lg-lo",
  lgShadow: "lg-shadow",
  lgSpec: "lg-spec",
  scrim: "scrim",
};

export function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Sets the palette and accent tokens on the document root. */
export function applyTheme(mode: ThemeMode, accent: AccentName): void {
  if (typeof document === "undefined") return;
  const resolved = resolveMode(mode);
  const root = document.documentElement;
  root.setAttribute("data-theme", resolved);
  root.style.colorScheme = resolved;
  const p = PALETTES[resolved];
  for (const key of Object.keys(KEBAB) as Array<keyof Palette>) root.style.setProperty(`--${KEBAB[key]}`, p[key]);
  const a = ACCENTS[accent][resolved];
  const [r, g, b] = hexToRgb(a);
  root.style.setProperty("--accent", a);
  root.style.setProperty("--accentbg", `rgba(${r},${g},${b},${resolved === "dark" ? 0.16 : 0.1})`);
  root.style.setProperty("--onaccent", resolved === "dark" ? "#0B0B0C" : "#FFFFFF");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", p.bg);
}
