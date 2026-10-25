import { render } from "solid-js/web";
import { onMount, Show, createEffect, createSignal } from "solid-js";
import { Header } from "./components/Header";
import { Drawer } from "./components/Drawer";
import { CardFeed } from "./components/CardFeed";
import { MacroDock } from "./components/MacroDock";
import { TerminalSheet } from "./components/TerminalSheet";
import { NewTabModal } from "./components/NewTabModal";
import { ActiveAgentsModal } from "./components/ActiveAgentsModal";
import { SettingsModal } from "./components/SettingsModal";
import { DiffDrawer } from "./components/DiffDrawer";
import { CloseTabModal } from "./components/CloseTabModal";
import { state, setState, setPaletteTheme, readPref } from "./state/store";
import { applyFullTheme } from "./themes";
import { initWebSocket, checkPairingFromUrlHash } from "./state/ws";

let waitingWorker: ServiceWorker | null = null;

function applyUpdate() {
  // The new service worker takes over; `controllerchange` then reloads once.
  waitingWorker?.postMessage({ type: "SKIP_WAITING" });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").then((registration) => {
    const offerUpdate = (worker: ServiceWorker | null) => {
      if (worker && navigator.serviceWorker.controller) {
        waitingWorker = worker;
        setState("updateAvailable", true);
      }
    };
    offerUpdate(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed") offerUpdate(installing);
      });
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") registration.update();
    });
  });
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

function ErrorToast() {
  const [visible, setVisible] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (!state.lastError) return;
    setVisible(true);
    clearTimeout(timer);
    timer = setTimeout(() => setVisible(false), 4000);
  });
  return (
    <Show when={visible() && state.lastError}>
      <div
        role="alert"
        onClick={() => setVisible(false)}
        style={{
          position: "fixed",
          left: "12px",
          right: "12px",
          bottom: "calc(80px + env(safe-area-inset-bottom))",
          "z-index": 80,
          padding: "10px 12px",
          "border-radius": "10px",
          background: "var(--delbg)",
          color: "#fff",
          "font-size": "13px",
          "box-shadow": "0 6px 20px rgba(0,0,0,0.3)",
        }}
      >
        {state.lastError!.message}
      </div>
    </Show>
  );
}

function UpdateBanner() {
  return (
    <Show when={state.updateAvailable}>
      <button
        onClick={applyUpdate}
        style={{
          border: 0,
          padding: "8px 12px",
          background: "var(--accentbg)",
          color: "var(--accent)",
          "font-size": "13px",
          "font-weight": 600,
          "text-align": "left",
          cursor: "pointer",
        }}
      >
        有新版本可用 · 点击刷新
      </button>
    </Show>
  );
}

function App() {
  onMount(async () => {
    await checkPairingFromUrlHash();

    setPaletteTheme(readPref("pigeon_theme_key") || "gruvbox", (readPref("pigeon_theme_mode") as "system" | "light" | "dark") || "system");
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (state.themeMode === "system") applyFullTheme(state.themeKey, "system");
    });

    await initWebSocket();
    registerServiceWorker();

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      (window as any).__pigeonDeferredPrompt = e;
      setState("canInstallPWA", true);
    });
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
      <UpdateBanner />
      <Header />
      <Drawer />
      <CardFeed />
      <MacroDock />
      <TerminalSheet />
      <NewTabModal />
      <ActiveAgentsModal />
      <SettingsModal />
      <DiffDrawer />
      <CloseTabModal />
      <ErrorToast />
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(() => <App />, root);
