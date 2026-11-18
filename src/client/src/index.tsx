import { render } from "solid-js/web";
import { batch, createEffect, createSignal, Match, on, onMount, Show, Switch } from "solid-js";
import "./styles.css";
import { backRoute, goBack, navigate, quotaFeatureOn, setState, state, systemReducesTransparency, usageFeatureOn, type Route } from "./state/store";
import { applyTheme } from "./themes";
import { checkPairingFromUrlHash, initWebSocket, reportPresence, selectPane } from "./state/ws";
import { dropCachedShell } from "./state/shell";
import { AgentsPage, Home } from "./components/Home";
import { NewSession } from "./components/NewSession";
import { Overlays } from "./components/overlays";
import { SessionPage } from "./components/SessionPage";
import { Pairing, Settings } from "./components/Settings";
import { QuotaPage } from "./components/QuotaPage";
import { UsagePage } from "./components/UsagePage";
import { canScrollRightward } from "./components/ui";
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

const [swipeTarget, setSwipeTarget] = createSignal<Route | null>(null);
const [swipeDx, setSwipeDx] = createSignal(0);
const [swipeSettling, setSwipeSettling] = createSignal(false);

let touchStartX = 0;
let touchStartY = 0;
let lastTouchX = 0;
let lastTouchT = 0;
let touchVx = 0;
let swipeMode: "none" | "pending" | "horiz" = "none";

function finishSwipe(commit: boolean) {
  swipeMode = "none";
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduced) {
    batch(() => {
      if (commit) goBack();
      setSwipeSettling(false);
      setSwipeDx(0);
      setSwipeTarget(null);
    });
    return;
  }
  const width = window.innerWidth || 390;
  setSwipeSettling(true);
  setSwipeDx(commit ? width : 0);
  setTimeout(() => {
    batch(() => {
      if (commit) goBack();
      setSwipeSettling(false);
      setSwipeDx(0);
      setSwipeTarget(null);
    });
  }, 200);
}

if (typeof window !== "undefined") {
  window.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || !state.paired || swipeSettling()) {
      swipeMode = "none";
      return;
    }
    if (!backRoute(state.route)) {
      swipeMode = "none";
      return;
    }
    if (document.querySelector(".overlay, .img-viewer-overlay, .alert-dialog-overlay, .menuwrap, [data-overlay]")) {
      swipeMode = "none";
      return;
    }
    const touch = e.touches[0];
    if (touch.clientX > 44 || canScrollRightward(touch.target)) {
      swipeMode = "none";
      return;
    }
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    lastTouchX = touch.clientX;
    lastTouchT = performance.now();
    touchVx = 0;
    swipeMode = "pending";
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (swipeMode === "none" || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    if (swipeMode === "pending") {
      if (dy > 12 && dy > dx) {
        swipeMode = "none";
        return;
      }
      if (dx > 10 && dx > dy * 1.15) {
        const next = backRoute(state.route);
        if (!next) {
          swipeMode = "none";
          return;
        }
        swipeMode = "horiz";
        setSwipeSettling(false);
        setSwipeTarget(next);
      } else {
        return;
      }
    }
    if (e.cancelable) e.preventDefault();
    const now = performance.now();
    const dt = now - lastTouchT;
    if (dt > 0) touchVx = 0.6 * ((touch.clientX - lastTouchX) / dt) + 0.4 * touchVx;
    lastTouchX = touch.clientX;
    lastTouchT = now;
    setSwipeDx(Math.max(0, dx));
  }, { passive: false });

  window.addEventListener("touchend", (e) => {
    if (swipeMode !== "horiz") {
      swipeMode = "none";
      return;
    }
    const touch = e.changedTouches[0];
    const dx = touch ? touch.clientX - touchStartX : swipeDx();
    const width = window.innerWidth || 390;
    const shouldNavigate = dx >= Math.min(120, width * 0.32) || (touchVx >= 0.5 && dx > 32);
    finishSwipe(shouldNavigate);
  }, { passive: true });

  window.addEventListener("touchcancel", () => {
    if (swipeMode === "horiz") finishSwipe(false);
    else swipeMode = "none";
  }, { passive: true });
}

function applyUpdate() {
  // A waiting service worker takes over and `controllerchange` reloads once. Without one, the
  // daemon was rebuilt with an unchanged sw.js: drop the cached shell so the reload fetches the new one.
  if (waitingWorker) {
    updateRequested = true;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  } else {
    void dropCachedShell().then(() => window.location.reload());
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
    if (state.configReady && !quotaFeatureOn() && !usageFeatureOn()) {
      if (state.route.name === "quota" || state.route.name === "usage") {
        navigate({ name: "home" });
      }
    }
  });
  const solid = () => state.reduceTransparency ?? systemReduce();
  const swipeActive = () => swipeTarget() !== null;
  const swipeProgress = () => {
    const w = typeof window !== "undefined" ? window.innerWidth || 390 : 390;
    return Math.min(1, Math.max(0, swipeDx() / w));
  };

  const renderRouteView = (route: () => Route) => (
    <Switch>
      <Match when={!state.paired}>
        <Pairing />
      </Match>
      <Match when={route().name === "home"}>
        <Home />
      </Match>
      <Match when={route().name === "agents"}>
        <AgentsPage />
      </Match>
      <Match when={route().name === "session"}>
        <SessionPage />
      </Match>
      <Match when={route().name === "new" && route()} keyed>
        {(r) => <NewSession workspaceId={(r as { workspaceId: string | null }).workspaceId} mode={(r as { mode: "new" | "resume" }).mode} />}
      </Match>
      <Match when={route().name === "settings"}>
        <Settings />
      </Match>
      <Match when={(quotaFeatureOn() || usageFeatureOn()) && route().name === "quota"}>
        <QuotaPage />
      </Match>
      <Match when={(quotaFeatureOn() || usageFeatureOn()) && route().name === "usage"}>
        <UsagePage />
      </Match>
    </Switch>
  );

  return (
    <div class={solid() ? "solid" : ""} style={{ height: "100%" }}>
      <Show when={swipeTarget()}>
        {(target) => (
          <div
            class={`swipe-under${swipeSettling() ? " settling" : ""}`}
            inert
            style={{ transform: `translate3d(${(-28 * (1 - swipeProgress())).toFixed(2)}%, 0, 0)` }}
          >
            {renderRouteView(target)}
            <div class="swipe-dim" style={{ opacity: (0.28 * (1 - swipeProgress())).toFixed(3) }} />
          </div>
        )}
      </Show>
      <div
        class={`swipe-over${swipeActive() ? " dragging" : ""}${swipeSettling() ? " settling" : ""}`}
        style={swipeActive() ? { transform: `translate3d(${Math.round(swipeDx())}px, 0, 0)` } : undefined}
      >
        {renderRouteView(() => state.route)}
      </div>
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
