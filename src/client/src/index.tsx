import { render } from "solid-js/web";
import { onMount } from "solid-js";
import { Header } from "./components/Header";
import { Drawer } from "./components/Drawer";
import { CardFeed } from "./components/CardFeed";
import { MacroDock } from "./components/MacroDock";
import { TerminalSheet } from "./components/TerminalSheet";
import { state, setTheme } from "./state/store";
import { initWebSocket, checkPairingFromUrlHash } from "./state/ws";
import { THEMES, applyTheme } from "./themes";

function App() {
  onMount(async () => {
    // 1. Check for token exchange from URL hash (#code=...)
    await checkPairingFromUrlHash();

    // 2. Load stored theme or default
    const savedTheme = localStorage.getItem("pigeon_theme") || "pigeon-dark";
    if (THEMES[savedTheme]) {
      setTheme(savedTheme);
    } else {
      applyTheme(THEMES["pigeon-dark"]);
    }

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
        background: "var(--color-bg)",
        color: "var(--color-fg)",
      }}
    >
      <Header />
      <Drawer />
      <CardFeed />
      <MacroDock />
      <TerminalSheet />
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
