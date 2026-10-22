export interface ThemeTokens {
  id: string;
  name: string;
  mode: "dark" | "light";
  bg: string;
  surface: string;
  border: string;
  fg: string;
  faint: string;
  accent: string;
  danger: string;
  warning: string;
  success: string;
}

export const THEMES: Record<string, ThemeTokens> = {
  "pigeon-dark": {
    id: "pigeon-dark",
    name: "Pigeon Dark",
    mode: "dark",
    bg: "#0B0F14",
    surface: "#151B23",
    border: "#30363D",
    fg: "#F0F6FC",
    faint: "#8B949E",
    accent: "#388BFD",
    danger: "#F85149",
    warning: "#D29922",
    success: "#3FB950",
  },
  "pigeon-light": {
    id: "pigeon-light",
    name: "Pigeon Light",
    mode: "light",
    bg: "#F6F7F9",
    surface: "#FFFFFF",
    border: "#D0D7DE",
    fg: "#161A1F",
    faint: "#5C6675", // Calibrated to pass WCAG AA >= 4.5:1
    accent: "#0969DA",
    danger: "#CF222E",
    warning: "#9A6700",
    success: "#1A7F37",
  },
  "terminal-amber": {
    id: "terminal-amber",
    name: "Terminal Amber",
    mode: "dark",
    bg: "#0D0B00",
    surface: "#1A1600",
    border: "#3D3300",
    fg: "#FFB000",
    faint: "#A67300",
    accent: "#FFA000",
    danger: "#FF4D4D",
    warning: "#FFD000",
    success: "#00FF66",
  },
  "cyber-cyan": {
    id: "cyber-cyan",
    name: "Cyber Cyan",
    mode: "dark",
    bg: "#040D14",
    surface: "#081926",
    border: "#133854",
    fg: "#00E5FF",
    faint: "#008299",
    accent: "#00FFFF",
    danger: "#FF2A6D",
    warning: "#FFB800",
    success: "#05FFA1",
  },
  "tokyo-night": {
    id: "tokyo-night",
    name: "Tokyo Night",
    mode: "dark",
    bg: "#1A1B26",
    surface: "#24283B",
    border: "#414868",
    fg: "#C0CAF5",
    faint: "#7AA2F7",
    accent: "#7AA2F7",
    danger: "#F7768E",
    warning: "#E0AF68",
    success: "#9ECE6A",
  },
  "monokai-pro": {
    id: "monokai-pro",
    name: "Monokai Pro",
    mode: "dark",
    bg: "#2D2A2E",
    surface: "#3A3539",
    border: "#565055",
    fg: "#FCFCFA",
    faint: "#939293",
    accent: "#FFD866",
    danger: "#FF6188",
    warning: "#FC9867",
    success: "#A9DC76",
  },
};

export function applyTheme(tokens: ThemeTokens) {
  const root = document.documentElement;
  root.style.setProperty("--color-bg", tokens.bg);
  root.style.setProperty("--color-surface", tokens.surface);
  root.style.setProperty("--color-border", tokens.border);
  root.style.setProperty("--color-fg", tokens.fg);
  root.style.setProperty("--color-faint", tokens.faint);
  root.style.setProperty("--color-accent", tokens.accent);
  root.style.setProperty("--color-danger", tokens.danger);
  root.style.setProperty("--color-warning", tokens.warning);
  root.style.setProperty("--color-success", tokens.success);
}
