import { render } from "solid-js/web";
import { onMount } from "solid-js";
import { Header } from "./components/Header";
import { Drawer } from "./components/Drawer";
import { CardFeed } from "./components/CardFeed";
import { MacroDock } from "./components/MacroDock";
import { TerminalSheet } from "./components/TerminalSheet";
import { AppearanceModal } from "./components/AppearanceModal";
import { MacrosModal } from "./components/MacrosModal";
import { NewTabModal } from "./components/NewTabModal";
import { PairingModal } from "./components/PairingModal";
import { ActiveAgentsModal } from "./components/ActiveAgentsModal";
import { SettingsModal } from "./components/SettingsModal";
import { state, setPaletteTheme } from "./state/store";
import { initWebSocket, checkPairingFromUrlHash } from "./state/ws";

function App() {
  onMount(async () => {
    // 1. Check for token exchange from URL hash (#code=...)
    await checkPairingFromUrlHash();

    // 2. Load stored theme or default (Tokyo Night with system auto light/dark)
    const savedThemeKey = localStorage.getItem("pigeon_theme_key") || "tokyo-night";
    const savedThemeMode = (localStorage.getItem("pigeon_theme_mode") as any) || "system";
    setPaletteTheme(savedThemeKey, savedThemeMode);

    // 3. Listen to system preference changes when in 'system' mode
    if (typeof window !== "undefined" && window.matchMedia) {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handleThemeChange = () => {
        if (state.themeMode === "system") {
          applyFullTheme(state.themeKey, "system");
        }
      };
      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener("change", handleThemeChange);
      } else if ((mediaQuery as any).addListener) {
        (mediaQuery as any).addListener(handleThemeChange);
      }
    }

    // 4. Connect WebSocket
    initWebSocket();
  });

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        width: "100%",
        overflow: "hidden",
        background: "var(--bg)",
        color: "var(--fg)",
        "font-family": "Inter, 'PingFang SC', 'Noto Sans SC', system-ui, sans-serif",
      }}
    >
      <Header />
      <Drawer />
      <CardFeed />
      <MacroDock />
      <TerminalSheet />
      <AppearanceModal />
      <MacrosModal />
      <NewTabModal />
      <PairingModal />
      <ActiveAgentsModal />
      <SettingsModal />
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
