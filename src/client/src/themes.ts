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

export interface FullPalette {
  bg: string;
  surface: string;
  sheet: string;
  inset: string;
  line: string;
  border: string;
  border2: string;
  fg: string;
  muted: string;
  faint: string;
  sel: string;
  selb: string;
  accent: string;
  onaccent: string;
  accentt: string;
  accentbg: string;
  accents: string;
  accentl: string;
  code: string;
  codeb: string;
  codefg: string;
  warn: string;
  onwarn: string;
  warnt: string;
  warnbg: string;
  warnb: string;
  warns: string;
  warnl: string;
  warnk: string;
  addbg: string;
  addfg: string;
  delbg: string;
  delfg: string;
  scrim: string;
  badge: string;
}

export const PALETTES: Record<string, { light: FullPalette; dark: FullPalette; name: string; subtitle: string }> = {
  pigeon: {
    name: "Pigeon",
    subtitle: "默认",
    light: {
      bg: "#F6F7F9",
      surface: "#FFFFFF",
      sheet: "#FFFFFF",
      inset: "#EDF0F3",
      line: "#E2E6EB",
      border: "#D2D8DF",
      border2: "#AEB8C4",
      fg: "#161A1F",
      muted: "#4F5966",
      faint: "#5C6675", // Calibrated for WCAG AA >= 4.5:1
      sel: "#E5EDF7",
      selb: "#A7C0DF",
      accent: "#1D6CD0",
      onaccent: "#FFFFFF",
      accentt: "#175BB0",
      accentbg: "#E7F0FB",
      accents: "#F3F7FC",
      accentl: "#C3D5EC",
      code: "#F2F4F7",
      codeb: "#DCE1E7",
      codefg: "#2A313A",
      warn: "#B7800A",
      onwarn: "#1F1600",
      warnt: "#875800",
      warnbg: "#FFF3D1",
      warnb: "#E2BC5E",
      warns: "#FFFAEE",
      warnl: "#E9D7A6",
      warnk: "#FFFFFF",
      addbg: "#E3EEFF",
      addfg: "#0A4E9E",
      delbg: "#FCE9E2",
      delfg: "#9C3610",
      scrim: "rgba(22, 27, 34, 0.42)",
      badge: "#EDF0F3",
    },
    dark: {
      bg: "#101317",
      surface: "#181D23",
      sheet: "#151A20",
      inset: "#0F1318",
      line: "#20262E",
      border: "#2A323C",
      border2: "#3A4552",
      fg: "#E7EAEE",
      muted: "#A0A9B4",
      faint: "#7F8995",
      sel: "#1E2833",
      selb: "#36475A",
      accent: "#6CB2FF",
      onaccent: "#0B1220",
      accentt: "#9CCBFF",
      accentbg: "#16263A",
      accents: "#121C28",
      accentl: "#2A3A4C",
      code: "#0B0E11",
      codeb: "#232A33",
      codefg: "#C9D1D9",
      warn: "#F2B544",
      onwarn: "#1A1404",
      warnt: "#F2B544",
      warnbg: "#2A2212",
      warnb: "#5A4718",
      warns: "#1C1810",
      warnl: "#4A3F22",
      warnk: "#14120C",
      addbg: "#12233A",
      addfg: "#A8D1FF",
      delbg: "#2A1A12",
      delfg: "#F0B8A0",
      scrim: "rgba(4, 6, 8, 0.68)",
      badge: "#24292F",
    },
  },
  github: {
    name: "GitHub",
    subtitle: "Light / Dark",
    light: {
      bg: "#FFFFFF",
      surface: "#F6F8FA",
      sheet: "#FFFFFF",
      inset: "#F6F8FA",
      line: "#D0D7DE",
      border: "#D0D7DE",
      border2: "#AFB8C1",
      fg: "#1F2328",
      muted: "#57606A",
      faint: "#57606A",
      sel: "#DDF4FF",
      selb: "#54AEFF",
      accent: "#0969DA",
      onaccent: "#FFFFFF",
      accentt: "#0969DA",
      accentbg: "#DDF4FF",
      accents: "#F0F8FF",
      accentl: "#80CCFF",
      code: "#F6F8FA",
      codeb: "#D0D7DE",
      codefg: "#24292F",
      warn: "#9A6700",
      onwarn: "#FFFFFF",
      warnt: "#9A6700",
      warnbg: "#FFF8C5",
      warnb: "#D4A72C",
      warns: "#FFFBE6",
      warnl: "#E3B341",
      warnk: "#FFFFFF",
      addbg: "#DAFBE1",
      addfg: "#1A7F37",
      delbg: "#FFEBE9",
      delfg: "#CF222E",
      scrim: "rgba(31, 35, 40, 0.4)",
      badge: "#AFB8C1",
    },
    dark: {
      bg: "#0D1117",
      surface: "#161B22",
      sheet: "#161B22",
      inset: "#010409",
      line: "#21262D",
      border: "#30363D",
      border2: "#484F58",
      fg: "#E6EDF3",
      muted: "#8B949E",
      faint: "#6E7681",
      sel: "#1F2937",
      selb: "#388BFD",
      accent: "#4493F8",
      onaccent: "#0D1117",
      accentt: "#58A6FF",
      accentbg: "#10233D",
      accents: "#0B1626",
      accentl: "#1F4273",
      code: "#03060A",
      codeb: "#21262D",
      codefg: "#C9D1D9",
      warn: "#D29922",
      onwarn: "#0D1117",
      warnt: "#E3B341",
      warnbg: "#271E0B",
      warnb: "#533F03",
      warns: "#1B1506",
      warnl: "#3D2E05",
      warnk: "#130F04",
      addbg: "#0D2817",
      addfg: "#3FB950",
      delbg: "#321214",
      delfg: "#F85149",
      scrim: "rgba(1, 4, 9, 0.7)",
      badge: "#21262D",
    },
  },
  "tokyo-night": {
    name: "Tokyo Night",
    subtitle: "Day / Night",
    light: {
      bg: "#E1E2E7",
      surface: "#E9E9ED",
      sheet: "#E9E9ED",
      inset: "#D5D6DB",
      line: "#C4C8DA",
      border: "#B4B8CA",
      border2: "#9699A3",
      fg: "#3760BF",
      muted: "#6172B0",
      faint: "#556499",
      sel: "#D0D5E6",
      selb: "#2E7DE9",
      accent: "#2E7DE9",
      onaccent: "#FFFFFF",
      accentt: "#185FC4",
      accentbg: "#D5E2F8",
      accents: "#E4EDFC",
      accentl: "#9BBDF3",
      code: "#D5D6DB",
      codeb: "#C4C8DA",
      codefg: "#3760BF",
      warn: "#8C6C3E",
      onwarn: "#FFFFFF",
      warnt: "#8C6C3E",
      warnbg: "#F2E8DC",
      warnb: "#D1B28A",
      warns: "#FAF5EE",
      warnl: "#DFC19B",
      warnk: "#FFFFFF",
      addbg: "#D7E8DC",
      addfg: "#387068",
      delbg: "#F4D9DC",
      delfg: "#8C4351",
      scrim: "rgba(46, 54, 78, 0.45)",
      badge: "#B4B8CA",
    },
    dark: {
      bg: "#1A1B26",
      surface: "#24283B",
      sheet: "#1F2335",
      inset: "#16161E",
      line: "#292E42",
      border: "#414868",
      border2: "#565F89",
      fg: "#C0CAF5",
      muted: "#9AA5CE",
      faint: "#7AA2F7",
      sel: "#283457",
      selb: "#7AA2F7",
      accent: "#7AA2F7",
      onaccent: "#15161E",
      accentt: "#89DDFF",
      accentbg: "#1E2745",
      accents: "#161D33",
      accentl: "#344B7E",
      code: "#13141C",
      codeb: "#292E42",
      codefg: "#A9B1D6",
      warn: "#E0AF68",
      onwarn: "#1A1B26",
      warnt: "#E0AF68",
      warnbg: "#2B2418",
      warnb: "#5C461F",
      warns: "#1E1A12",
      warnl: "#4D3B1B",
      warnk: "#15120D",
      addbg: "#1B2E28",
      addfg: "#73DACA",
      delbg: "#341B23",
      delfg: "#F7768E",
      scrim: "rgba(15, 15, 23, 0.72)",
      badge: "#292E42",
    },
  },
  catppuccin: {
    name: "Catppuccin",
    subtitle: "Latte / Mocha",
    light: {
      bg: "#EFF1F5",
      surface: "#E6E9EF",
      sheet: "#FFFFFF",
      inset: "#DCE0E8",
      line: "#CCD0DA",
      border: "#BCC0CC",
      border2: "#9CA0B0",
      fg: "#4C4F69",
      muted: "#6C6F85",
      faint: "#5C5F77",
      sel: "#CCD0DA",
      selb: "#1E66F5",
      accent: "#1E66F5",
      onaccent: "#FFFFFF",
      accentt: "#1E66F5",
      accentbg: "#DCE5FA",
      accents: "#EDF2FD",
      accentl: "#8FB2FB",
      code: "#DCE0E8",
      codeb: "#CCD0DA",
      codefg: "#4C4F69",
      warn: "#DF8E1D",
      onwarn: "#FFFFFF",
      warnt: "#DF8E1D",
      warnbg: "#FAEEDB",
      warnb: "#EBBF7E",
      warns: "#FCF6ED",
      warnl: "#F2CE97",
      warnk: "#FFFFFF",
      addbg: "#DCF0E2",
      addfg: "#40A02B",
      delbg: "#F9DEE2",
      delfg: "#D20F39",
      scrim: "rgba(76, 79, 105, 0.4)",
      badge: "#BCC0CC",
    },
    dark: {
      bg: "#1E1E2E",
      surface: "#252538",
      sheet: "#181825",
      inset: "#11111B",
      line: "#313244",
      border: "#45475A",
      border2: "#585B70",
      fg: "#CDD6F4",
      muted: "#A6ADC8",
      faint: "#7F849C",
      sel: "#313244",
      selb: "#89B4FA",
      accent: "#89B4FA",
      onaccent: "#11111B",
      accentt: "#B4BEFE",
      accentbg: "#1E2745",
      accents: "#151C33",
      accentl: "#33456E",
      code: "#11111B",
      codeb: "#313244",
      codefg: "#BAC2DE",
      warn: "#F9E2AF",
      onwarn: "#11111B",
      warnt: "#F9E2AF",
      warnbg: "#2E2718",
      warnb: "#5E4D1D",
      warns: "#201B11",
      warnl: "#4A3D18",
      warnk: "#15120B",
      addbg: "#182C22",
      addfg: "#A6E3A1",
      delbg: "#331924",
      delfg: "#F38BA8",
      scrim: "rgba(17, 17, 27, 0.72)",
      badge: "#313244",
    },
  },
  claude: {
    name: "Claude",
    subtitle: "Ivory / Slate",
    light: {
      bg: "#FAF9F5",
      surface: "#F0EFEA",
      sheet: "#FFFFFF",
      inset: "#E8E6DF",
      line: "#DFDCD3",
      border: "#D1CDC2",
      border2: "#B0ABA0",
      fg: "#141413",
      muted: "#5E5D59",
      faint: "#555450",
      sel: "#E5E1D5",
      selb: "#D97757",
      accent: "#D97757",
      onaccent: "#FFFFFF",
      accentt: "#B95637",
      accentbg: "#FAEDE8",
      accents: "#FDF6F4",
      accentl: "#EEC0B0",
      code: "#EFECE4",
      codeb: "#DFDCD3",
      codefg: "#262524",
      warn: "#B7800A",
      onwarn: "#FFFFFF",
      warnt: "#875800",
      warnbg: "#FFF3D1",
      warnb: "#E2BC5E",
      warns: "#FFFAEE",
      warnl: "#E9D7A6",
      warnk: "#FFFFFF",
      addbg: "#E3EEFF",
      addfg: "#0A4E9E",
      delbg: "#FCE9E2",
      delfg: "#9C3610",
      scrim: "rgba(20, 20, 19, 0.42)",
      badge: "#D1CDC2",
    },
    dark: {
      bg: "#141413",
      surface: "#1F1E1D",
      sheet: "#1A1918",
      inset: "#0E0E0D",
      line: "#2B2A28",
      border: "#3B3A37",
      border2: "#4F4E4A",
      fg: "#FAF9F5",
      muted: "#ABA8A1",
      faint: "#7E7B75",
      sel: "#2B2824",
      selb: "#D97757",
      accent: "#D97757",
      onaccent: "#141413",
      accentt: "#F09A7D",
      accentbg: "#2E1C16",
      accents: "#201410",
      accentl: "#543024",
      code: "#0B0B0A",
      codeb: "#252422",
      codefg: "#DBD8D0",
      warn: "#E3B341",
      onwarn: "#141413",
      warnt: "#E3B341",
      warnbg: "#2A2312",
      warnb: "#574416",
      warns: "#1C180E",
      warnl: "#443614",
      warnk: "#13100A",
      addbg: "#12233A",
      addfg: "#A8D1FF",
      delbg: "#2E1618",
      delfg: "#F08C94",
      scrim: "rgba(6, 6, 6, 0.72)",
      badge: "#252422",
    },
  },
  solarized: {
    name: "Solarized",
    subtitle: "Light / Dark",
    light: {
      bg: "#FDF6E3",
      surface: "#EEE8D5",
      sheet: "#FFFFFF",
      inset: "#E4DCBF",
      line: "#D3CAAE",
      border: "#C5BA99",
      border2: "#93A1A1",
      fg: "#586E75",
      muted: "#657B83",
      faint: "#586E75",
      sel: "#E4DCBF",
      selb: "#268BD2",
      accent: "#268BD2",
      onaccent: "#FFFFFF",
      accentt: "#1B6CA7",
      accentbg: "#D9ECF8",
      accents: "#EDF5FC",
      accentl: "#8BC4EB",
      code: "#EEE8D5",
      codeb: "#D3CAAE",
      codefg: "#073642",
      warn: "#B58900",
      onwarn: "#FFFFFF",
      warnt: "#8E6B00",
      warnbg: "#FBF3D4",
      warnb: "#D9BF66",
      warns: "#FDF9EB",
      warnl: "#E3CF88",
      warnk: "#FFFFFF",
      addbg: "#E0F0DF",
      addfg: "#859900",
      delbg: "#FBE3DF",
      delfg: "#DC322F",
      scrim: "rgba(7, 54, 66, 0.4)",
      badge: "#C5BA99",
    },
    dark: {
      bg: "#002B36",
      surface: "#073642",
      sheet: "#052630",
      inset: "#001F27",
      line: "#0A4656",
      border: "#125668",
      border2: "#586E75",
      fg: "#93A1A1",
      muted: "#839496",
      faint: "#657B83",
      sel: "#073E4D",
      selb: "#268BD2",
      accent: "#268BD2",
      onaccent: "#002B36",
      accentt: "#58A6FF",
      accentbg: "#08374D",
      accents: "#052737",
      accentl: "#115473",
      code: "#001B22",
      codeb: "#0A4656",
      codefg: "#EEE8D5",
      warn: "#B58900",
      onwarn: "#002B36",
      warnt: "#D8A300",
      warnbg: "#262206",
      warnb: "#4E420C",
      warns: "#1B1704",
      warnl: "#3F350B",
      warnk: "#131003",
      addbg: "#0E2B14",
      addfg: "#859900",
      delbg: "#321316",
      delfg: "#DC322F",
      scrim: "rgba(0, 19, 24, 0.75)",
      badge: "#0A4656",
    },
  },
};

export const THEMES: Record<string, ThemeTokens> = {
  "pigeon-dark": {
    id: "pigeon-dark",
    name: "Pigeon Dark",
    mode: "dark",
    bg: PALETTES.pigeon.dark.bg,
    surface: PALETTES.pigeon.dark.surface,
    border: PALETTES.pigeon.dark.border,
    fg: PALETTES.pigeon.dark.fg,
    faint: PALETTES.pigeon.dark.faint,
    accent: PALETTES.pigeon.dark.accent,
    danger: PALETTES.pigeon.dark.delbg,
    warning: PALETTES.pigeon.dark.warn,
    success: "#3FB950",
  },
  "pigeon-light": {
    id: "pigeon-light",
    name: "Pigeon Light",
    mode: "light",
    bg: PALETTES.pigeon.light.bg,
    surface: PALETTES.pigeon.light.surface,
    border: PALETTES.pigeon.light.border,
    fg: PALETTES.pigeon.light.fg,
    faint: PALETTES.pigeon.light.faint, // #5C6675 >= 4.5:1
    accent: PALETTES.pigeon.light.accent,
    danger: PALETTES.pigeon.light.delfg,
    warning: PALETTES.pigeon.light.warn,
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
    bg: PALETTES["tokyo-night"].dark.bg,
    surface: PALETTES["tokyo-night"].dark.surface,
    border: PALETTES["tokyo-night"].dark.border,
    fg: PALETTES["tokyo-night"].dark.fg,
    faint: PALETTES["tokyo-night"].dark.faint,
    accent: PALETTES["tokyo-night"].dark.accent,
    danger: "#F7768E",
    warning: PALETTES["tokyo-night"].dark.warn,
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

export function getEffectiveMode(modePreference: "system" | "light" | "dark"): "light" | "dark" {
  if (modePreference === "system") {
    if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      return "light";
    }
    return "dark";
  }
  return modePreference;
}

export function applyFullTheme(themeKey: string, modePreference: "system" | "light" | "dark" = "dark") {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const key = themeKey.replace(/-dark|-light/, "");
  const paletteGroup = PALETTES[key] || PALETTES.pigeon;
  const effMode = getEffectiveMode(modePreference);
  const p = paletteGroup[effMode];

  for (const [k, v] of Object.entries(p)) {
    root.style.setProperty(`--${k}`, v as string);
  }

  // Set backward compatibility aliases
  root.style.setProperty("--color-bg", p.bg);
  root.style.setProperty("--color-surface", p.surface);
  root.style.setProperty("--color-border", p.border);
  root.style.setProperty("--color-fg", p.fg);
  root.style.setProperty("--color-faint", p.faint);
  root.style.setProperty("--color-accent", p.accent);
  root.style.setProperty("--color-danger", p.delfg || "#F85149");
  root.style.setProperty("--color-warning", p.warn);
  root.style.setProperty("--color-success", "#3FB950");
}

export function applyTheme(tokens: ThemeTokens) {
  if (typeof document === "undefined") return;
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

  // If matching known theme key, also apply full vars
  const cleanId = tokens.id.replace(/-dark|-light/, "");
  if (PALETTES[cleanId]) {
    applyFullTheme(cleanId, tokens.mode);
  }
}
