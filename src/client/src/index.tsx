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
import { DiffDrawer } from "./components/DiffDrawer";
import { state, setState, setPaletteTheme } from "./state/store";
import { initWebSocket, checkPairingFromUrlHash } from "./state/ws";

if (typeof window !== "undefined") {
  (window as any).__pigeonStore = { state, setState };
}

function App() {
  onMount(async () => {
    // 1. Check for token exchange from URL hash (#code=...)
    await checkPairingFromUrlHash();

    // 2. Load stored theme or default (Gruvbox with system auto light/dark)
    const savedThemeKey = localStorage.getItem("pigeon_theme_key") || "gruvbox";
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

    // Foreground wake-up: auto reconnect WebSocket instantly when app returns to view
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          if (!state.connected) {
            initWebSocket();
          }
        }
      });
    }

    // 5. Register PWA Service Worker with auto-update detection
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          // Whenever user brings PWA back to foreground, check for server updates
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
              registration.update().catch(() => {});
            }
          });

          // Check if a new version is installed
          registration.addEventListener("updatefound", () => {
            const installing = registration.installing;
            if (installing) {
              installing.addEventListener("statechange", () => {
                if (installing.state === "installed" && navigator.serviceWorker.controller) {
                  console.log("[PWA] New version installed, refreshing...");
                  window.location.reload();
                }
              });
            }
          });
        })
        .catch((err) => {
          console.warn("[PWA] Service worker registration error:", err);
        });

      // Reload when the controller changes
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });
    }

    // 6. Capture beforeinstallprompt for one-tap home screen install
    if (typeof window !== "undefined") {
      window.addEventListener("beforeinstallprompt", (e) => {
        e.preventDefault();
        (window as any).__pigeonDeferredPrompt = e;
        setState("canInstallPWA", true);
      });
    }
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
      <DiffDrawer />
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
