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
import { state, setPaletteTheme } from "./state/store";
import { initWebSocket, checkPairingFromUrlHash } from "./state/ws";

function App() {
  onMount(async () => {
    // 1. Check for token exchange from URL hash (#code=...)
    await checkPairingFromUrlHash();

    // 2. Load stored theme or default
    const savedThemeKey = localStorage.getItem("pigeon_theme_key") || "pigeon";
    const savedThemeMode = (localStorage.getItem("pigeon_theme_mode") as any) || "dark";
    setPaletteTheme(savedThemeKey, savedThemeMode);

    // 3. Connect WebSocket
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
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
