import { render } from "solid-js/web";
import { createEffect, createSignal, Match, on, onMount, Show, Switch } from "solid-js";
import "./styles.css";
import { goBack, navigate, quotaFeatureOn, setState, state, systemReducesTransparency } from "./state/store";
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

// mobile-ui-and-themes.md §1.1: the window never scrolls; only a page's scroll area does.
function resetWindowScroll() {
  if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
}

const isTextField = (el: Element | null) => Boolean(el?.matches?.("input, textarea, [contenteditable]"));

// §1.1 "Keyboard on iOS": iOS shrinks only the visual viewport for the keyboard, so while a text
// field has focus the page follows the visual viewport. Without focus the readings are ignored:
// iOS 26 can leave them stale after the keyboard closes.
let fullHeight = 0;
let fullWidth = 0;
function fitToVisualViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) return;
  if (vv.width !== fullWidth) {
    fullWidth = vv.width;
    fullHeight = 0;
  }
  if (!isTextField(document.activeElement)) {
    fullHeight = Math.max(fullHeight, vv.height);
    root.style.removeProperty("--vv-top");
    root.style.removeProperty("--vv-height");
    root.removeAttribute("data-keyboard");
    return;
  }
  root.style.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
  root.style.setProperty("--vv-height", `${Math.round(vv.height)}px`);
  if (fullHeight - vv.height > 120) root.setAttribute("data-keyboard", "open");
  else root.removeAttribute("data-keyboard");
}

if (typeof window !== "undefined") {
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as any).standalone);
  if (isStandalone) {
    document.documentElement.setAttribute("data-mode", "standalone");
  }

  window.addEventListener("focusin", fitToVisualViewport);
  window.addEventListener("focusout", () => {
    // Focus may be moving to another field; act on where it lands.
    requestAnimationFrame(() => {
      fitToVisualViewport();
      if (!isTextField(document.activeElement)) resetWindowScroll();
    });
  });
  window.addEventListener("scroll", () => {
    if (!isTextField(document.activeElement)) resetWindowScroll();
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest(".hdr, .bottombar")) {
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });

  window.visualViewport?.addEventListener("resize", fitToVisualViewport);
  window.visualViewport?.addEventListener("scroll", fitToVisualViewport);
  fitToVisualViewport();
}

let waitingWorker: ServiceWorker | null = null;
let updateRequested = false;

function isInsideHorizontalScroller(el: Element | null): boolean {
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.matches?.(".chipr, table, pre, code, .cb, .dfb")) return true;
    try {
      const style = window.getComputedStyle(el);
      if (style.overflowX === "auto" || style.overflowX === "scroll") return true;
    } catch {}
    el = el.parentElement;
  }
  return false;
}

let touchStartX = 0;
let touchStartY = 0;
let eligibleSwipe = false;

if (typeof window !== "undefined") {
  window.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) {
      eligibleSwipe = false;
      return;
    }
    if (state.route.name === "home") {
      eligibleSwipe = false;
      return;
    }
    const touch = e.touches[0];
    if (touch.clientX > 24) {
      eligibleSwipe = false;
      return;
    }
    if (isInsideHorizontalScroller(touch.target as Element | null)) {
      eligibleSwipe = false;
      return;
    }
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    eligibleSwipe = true;
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (!eligibleSwipe || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dy = Math.abs(touch.clientY - touchStartY);
    const dx = touch.clientX - touchStartX;
    if (dy > 30 && dy > dx) {
      eligibleSwipe = false;
    }
  }, { passive: true });

  window.addEventListener("touchend", (e) => {
    if (!eligibleSwipe) return;
    eligibleSwipe = false;
    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    if (dx >= 80 && dx > dy) {
      goBack();
    }
  }, { passive: true });

  window.addEventListener("touchcancel", () => {
    eligibleSwipe = false;
  }, { passive: true });
}

function applyUpdate() {
  // A waiting service worker takes over and `controllerchange` reloads once. Without one, the
  // daemon was rebuilt with an unchanged sw.js: reload, and the network-first shell is the new one.
  if (waitingWorker) {
    updateRequested = true;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  } else {
    window.location.reload();
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
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
    // Only reload when an explicit update was requested or an existing controller was replaced.
    // Avoids redundant reloads when a newly installed service worker claims clients on first visit.
    if (!updateRequested && !hadController) return;
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
    if (import.meta.env.DEV) {
      (window as any).__pigeon = { state, setState, navigate, applyTheme };
    }
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme(state.themeMode, state.accent));
    window.matchMedia("(prefers-reduced-transparency: reduce)").addEventListener?.("change", (e) => setSystemReduce(e.matches));
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      (window as any).__pigeonDeferredPrompt = e;
      setState("canInstallPWA", true);
    });
    await checkPairingFromUrlHash();
    const urlParams = new URLSearchParams(window.location.search);
    const targetPane = urlParams.get("pane");
    if (targetPane) {
      window.history.replaceState(null, "", window.location.pathname || "/");
      await selectPane(targetPane);
      navigate({ name: "session", from: "home" });
    } else if (state.activePaneId) {
      await selectPane(state.activePaneId);
    }
    await initWebSocket();
    registerServiceWorker();
  });
  createEffect(on(() => state.route.name, () => {
    reportPresence();
    resetWindowScroll();
  }, { defer: true }));
  createEffect(() => {
    if (state.configReady && state.quotaUsageEnabled === false) {
      if (state.route.name === "quota" || state.route.name === "usage") {
        navigate({ name: "home" });
      }
    }
  });
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
        <Match when={quotaFeatureOn() && state.route.name === "quota"}>
          <QuotaPage />
        </Match>
        <Match when={quotaFeatureOn() && state.route.name === "usage"}>
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
