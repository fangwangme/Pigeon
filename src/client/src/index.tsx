import { render } from "solid-js/web";
import { createEffect, createSignal, Match, on, onMount, Show, Switch } from "solid-js";
import "./styles.css";
import { navigate, setState, state, systemReducesTransparency } from "./state/store";
import { applyTheme } from "./themes";
import { checkPairingFromUrlHash, initWebSocket, reportPresence, selectPane } from "./state/ws";
import { AgentsPage, Home } from "./components/Home";
import { NewSession } from "./components/NewSession";
import { Overlays } from "./components/overlays";
import { SessionPage } from "./components/SessionPage";
import { Pairing, Settings } from "./components/Settings";
import { QuotaPage } from "./components/QuotaPage";
import { UsagePage } from "./components/UsagePage";
import { t } from "./i18n";

applyTheme(state.themeMode, state.accent);

let waitingWorker: ServiceWorker | null = null;

function applyUpdate() {
  // A waiting service worker takes over and `controllerchange` reloads once. Without one, the
  // daemon was rebuilt with an unchanged sw.js: reload, and the network-first shell is the new one.
  if (waitingWorker) waitingWorker.postMessage({ type: "SKIP_WAITING" });
  else window.location.reload();
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

/** §8.3: one toast line for notices and failed commands. */
function Toast() {
  const [text, setText] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (t: string) => {
    setText(t);
    clearTimeout(timer);
    timer = setTimeout(() => setText(null), 3200);
  };
  createEffect(on(() => state.toast, (t) => t && show(t.message), { defer: true }));
  createEffect(on(() => state.lastError, (e) => e && show(e.message), { defer: true }));
  return (
    <Show when={text()}>
      <div class="toast" role="status" onClick={() => setText(null)}>
        {text()}
      </div>
    </Show>
  );
}

function App() {
  const [systemReduce, setSystemReduce] = createSignal(systemReducesTransparency());
  onMount(async () => {
    (window as any).__pigeon = { state, setState, navigate, applyTheme };
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme(state.themeMode, state.accent));
    window.matchMedia("(prefers-reduced-transparency: reduce)").addEventListener?.("change", (e) => setSystemReduce(e.matches));
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      (window as any).__pigeonDeferredPrompt = e;
      setState("canInstallPWA", true);
    });
    await checkPairingFromUrlHash();
    if (state.activePaneId) {
      void selectPane(state.activePaneId);
    }
    await initWebSocket();
    registerServiceWorker();
  });
  createEffect(on(() => state.route.name, () => reportPresence(), { defer: true }));
  const solid = () => state.reduceTransparency ?? systemReduce();

  return (
    <div class={solid() ? "solid" : ""} style={{ height: "100%" }}>
      <Switch>
        <Match when={!state.paired}>
          <Pairing />
        </Match>
        <Match when={state.route.name === "home"}>
          <Home />
        </Match>
        <Match when={state.route.name === "agents"}>
          <AgentsPage />
        </Match>
        <Match when={state.route.name === "session"}>
          <SessionPage />
        </Match>
        <Match when={state.route.name === "new" && state.route} keyed>
          {(r) => <NewSession workspaceId={(r as { workspaceId: string | null }).workspaceId} mode={(r as { mode: "new" | "resume" }).mode} />}
        </Match>
        <Match when={state.route.name === "settings"}>
          <Settings />
        </Match>
        <Match when={state.route.name === "quota"}>
          <QuotaPage />
        </Match>
        <Match when={state.route.name === "usage"}>
          <UsagePage />
        </Match>
      </Switch>
      <Overlays />
      <Show when={state.updateAvailable}>
        <button class="toast update" onClick={applyUpdate}>
          {t("app.updateAvailable")} · <b>{t("app.reload")}</b>
        </button>
      </Show>
      <Toast />
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(() => <App />, root);
