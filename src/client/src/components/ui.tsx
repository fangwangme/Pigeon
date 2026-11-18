import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { ICONS, type IconName } from "../icons";
import { navigate, state } from "../state/store";
import type { AgentStatus, PaneSummary, TabSummary, WorkspaceSummary } from "../../../types/protocol";
import { t } from "../i18n";
import { formatModelNameWithRecipes } from "../../../shared/model-name";

export function Icon(props: { name: IconName; sm?: boolean; class?: string }) {
  return <svg class={`i${props.sm ? " sm" : ""}${props.class ? ` ${props.class}` : ""}`} viewBox="0 0 24 24" innerHTML={ICONS[props.name]} aria-hidden="true" />;
}

export function Logo() {
  return (
    <svg class="logo" viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <linearGradient id="pigeon-logo-bg" x1="0" y1="0" x2="0" y2="1">
          <stop class="bg-0" offset="0%" />
          <stop class="bg-1" offset="100%" />
        </linearGradient>
        <linearGradient id="pigeon-logo-bd" x1="0" y1="0" x2="1" y2="1">
          <stop class="bd-0" offset="0%" />
          <stop class="bd-1" offset="100%" />
        </linearGradient>
        <filter id="pigeon-logo-drop" x="-10%" y="-10%" width="125%" height="125%">
          <feDropShadow dx="0" dy="10" stdDeviation="11" flood-color="#16181A" flood-opacity="0.26" />
        </filter>
      </defs>
      <rect x="6" y="6" width="500" height="500" rx="110" fill="url(#pigeon-logo-bg)" stroke="url(#pigeon-logo-bd)" stroke-width="12" />
      <g filter="url(#pigeon-logo-drop)">
        <path class="w-back-1" d="M 208 220 L 292 80 L 304 214 L 236 202 Z" />
        <path class="w-back-2" d="M 268 208 L 292 80 L 304 214 Z" />
        <path class="flank-mid" d="M 54 306 L 122 284 L 170 252 L 236 202 L 304 214 L 358 148 L 398 170 L 446 184 L 380 198 L 344 256 L 326 330 L 232 382 L 142 338 L 76 354 Z" />
        <path class="tail-1" d="M 54 306 L 142 338 L 76 354 Z" />
        <path class="tail-2" d="M 54 306 L 122 284 L 142 338 Z" />
        <path class="belly" d="M 122 284 L 142 338 L 232 382 Z" />
        <path class="flank-rear" d="M 122 284 L 170 252 L 230 296 L 232 382 Z" />
        <path class="dorsal" d="M 170 252 L 236 202 L 304 214 L 344 256 L 230 296 Z" />
        <path class="flank-mid" d="M 230 296 L 344 256 L 232 382 Z" />
        <path class="breast" d="M 232 382 L 326 330 L 344 256 Z" />
        <path class="throat" d="M 304 214 L 398 170 L 380 198 L 344 256 Z" />
        <path class="crown" d="M 304 214 L 358 148 L 398 170 Z" />
        <path class="seam" d="M 122 284 L 142 338 M 304 214 L 344 256" fill="none" stroke-width="2.2" stroke-linecap="round" opacity="0.5" />
        <path class="beak-1" d="M 398 170 L 446 184 L 380 198 Z" />
        <path class="beak-2" d="M 388 184 L 446 184 L 380 198 Z" />
        <path class="w-front-1" d="M 170 252 L 246 86 L 230 296 Z" />
        <path class="w-front-2" d="M 202 275 L 246 86 L 230 296 Z" />
        <path d="M 202 275 L 220 198 L 229 186 L 236 140" fill="none" stroke="#FFF3D1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.92" />
        <circle cx="236" cy="140" r="3.8" fill="#FFF3D1" />
        <circle cx="202" cy="275" r="3.6" fill="#FFF3D1" />
        <g transform="rotate(-14 363 178)">
          <polygon points="350,178 356,168 370,168 376,178 370,188 356,188" fill="#181A1C" />
          <polygon points="355,178 359,172 367,172 371,178 367,184 359,184" fill="#FE8019" />
          <rect x="358" y="176.5" width="10" height="3" rx="1.5" fill="#FFF8E7" />
        </g>
        <g transform="rotate(-6 416 232)">
          <rect class="env-base" x="372" y="200" width="88" height="60" rx="8" />
          <path class="env-fold" d="M 374 258 L 416 234 L 458 258 Z" />
          <path class="env-flap" d="M 373 202 L 416 219 L 459 202 Z" />
          <path d="M 374 202 L 416 219 L 458 202" fill="none" stroke="#1D2021" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.8" />
          <path d="M 393 226 L 406 235 L 393 244" fill="none" stroke="#1D2021" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M 414 244 L 433 244" fill="none" stroke="#1D2021" stroke-width="5" stroke-linecap="round" />
        </g>
      </g>
    </svg>
  );
}

export type RowStatus = "blocked" | "working" | "done" | "idle" | "terminal";

/** mobile-ui-and-themes.md §2.1: status indicator dot styled and colored by state. */
export function StatusIcon(props: { status: RowStatus; class?: string }) {
  return <span class={`sdot ${props.status}${props.class ? ` ${props.class}` : ""}`} aria-label={props.status} />;
}

/** mobile-ui-and-themes.md §6.4 "Model names": the one rule for every place a model is shown. */
export function formatModelName(
  agent: string | ReadonlyArray<string | null | undefined> | null | undefined,
  model: string | null | undefined
): string {
  return formatModelNameWithRecipes(state.recipes, agent, model);
}

/** The pane the session page opens by default: the tab's first pane with an agent (§6.8). */
export function primaryPane(tab: TabSummary): PaneSummary | undefined {
  return tab.panes.find((p) => p.agent) ?? tab.panes.find((p) => p.isPrimary) ?? tab.panes[0];
}

export function paneStatus(p: PaneSummary | undefined): RowStatus {
  if (!p || !p.agent) return "terminal";
  return statusOf(p.agentStatus);
}

function statusOf(s: AgentStatus): RowStatus {
  return s === "unknown" ? "idle" : s;
}

export function tabStatus(tab: TabSummary): RowStatus {
  return paneStatus(primaryPane(tab));
}

export function agentLabel(kind: string | null | undefined): string {
  if (!kind || kind === "terminal") return t("agent.terminal");
  return state.recipes[kind]?.label ?? kind;
}

/** `protocol.md` §5.3: the pane's summary in the current language. */
export function paneSummary(p: PaneSummary | undefined): string {
  if (!p?.summaryKind) return "";
  if (p.summaryKind === "run") return t("summary.run", { command: p.summary ?? "" });
  if (p.summaryKind === "thinking") return p.summary || t("summary.thinking");
  return p.summary ?? "";
}

export function paneLabel(p: PaneSummary): string {
  return p.agent ? agentLabel(p.agent) : p.program || "Shell";
}

export function findTab(tabId: string | null): { ws: WorkspaceSummary; tab: TabSummary } | null {
  if (!tabId) return null;
  for (const ws of state.workspaces) {
    const tab = ws.tabs.find((t) => t.id === tabId);
    if (tab) return { ws, tab };
  }
  return null;
}

export function findPane(paneId: string | null): { ws: WorkspaceSummary; tab: TabSummary; pane: PaneSummary } | null {
  if (!paneId) return null;
  for (const ws of state.workspaces) {
    for (const tab of ws.tabs) {
      const pane = tab.panes.find((p) => p.id === paneId);
      if (pane) return { ws, tab, pane };
    }
  }
  return null;
}

export { ago } from "../i18n";

/** Whether `target` sits inside a horizontal scroller that can still scroll rightward (reveal content on its left). */
export function canScrollRightward(target: EventTarget | null, stopAt?: Element | null): boolean {
  let el = target as HTMLElement | null;
  while (el && el !== stopAt && el !== document.body && el !== document.documentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      try {
        const style = window.getComputedStyle(el);
        if (style.overflowX === "auto" || style.overflowX === "scroll") {
          if (style.flexDirection.includes("reverse") || el.scrollLeft > 0) return true;
        }
      } catch {}
    }
    el = el.parentElement;
  }
  return false;
}

/** A bottom sheet over a scrim; a tap on the scrim closes it. */
export function Sheet(props: {
  title?: JSX.Element;
  sub?: string;
  onClose: () => void;
  onBack?: () => void;
  right?: JSX.Element;
  full?: boolean;
  children: JSX.Element;
  /** The body does not scroll; the children hold their own scroller below a fixed part. */
  flush?: boolean;
}) {
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastT = 0;
  let vx = 0;
  let downEligible = false;
  let edgeMode: "none" | "pending" | "horiz" = "none";
  let sheetEl: HTMLDivElement | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(settleTimer));
  const [edgeDx, setEdgeDx] = createSignal(0);
  const [edgeSettling, setEdgeSettling] = createSignal(false);
  const canSwipeDown = (target: EventTarget | null, sheetEl: HTMLElement): boolean => {
    let el = target as HTMLElement | null;
    while (el && el !== sheetEl) {
      if (el.scrollTop > 0) return false;
      el = el.parentElement;
    }
    return true;
  };
  const handleTouchMove = (e: TouchEvent) => {
    if (edgeMode === "none" || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - startX;
    const dy = Math.abs(touch.clientY - startY);
    if (edgeMode === "pending") {
      if (dy > 12 && dy > dx) {
        edgeMode = "none";
        return;
      }
      if (dx > 10 && dx > dy * 1.15) {
        edgeMode = "horiz";
        downEligible = false;
        setEdgeSettling(false);
      } else {
        return;
      }
    }
    if (e.cancelable) e.preventDefault();
    const now = performance.now();
    const dt = now - lastT;
    if (dt > 0) vx = 0.6 * ((touch.clientX - lastX) / dt) + 0.4 * vx;
    lastX = touch.clientX;
    lastT = now;
    setEdgeDx(Math.max(0, dx));
  };
  onMount(() => {
    if (!sheetEl) return;
    const el = sheetEl;
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    onCleanup(() => el.removeEventListener("touchmove", handleTouchMove));
  });
  return (
    <div class="overlay" role="dialog" aria-modal="true">
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        ref={sheetEl}
        class={`sheet${props.full ? " full" : ""}`}
        style={
          edgeDx() > 0 || edgeSettling()
            ? {
                transform: `translate3d(${Math.round(edgeDx())}px, 0, 0)`,
                transition: edgeSettling() ? "transform 200ms cubic-bezier(.2,.85,.3,1)" : "none",
              }
            : undefined
        }
        onTouchStart={(e) => {
          if (e.touches.length !== 1 || edgeSettling()) {
            downEligible = false;
            edgeMode = "none";
            return;
          }
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
          lastX = startX;
          lastT = performance.now();
          vx = 0;
          downEligible = canSwipeDown(e.target, e.currentTarget);
          edgeMode = props.full && startX <= 44 && !canScrollRightward(e.target, e.currentTarget) ? "pending" : "none";
        }}
        onTouchEnd={(e) => {
          const t0 = e.changedTouches[0];
          if (edgeMode === "horiz") {
            edgeMode = "none";
            const dx = t0 ? t0.clientX - startX : edgeDx();
            const width = window.innerWidth || 390;
            const done = dx >= Math.min(120, width * 0.32) || (vx >= 0.5 && dx > 32);
            const act = () => (props.onBack ? props.onBack() : props.onClose());
            if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
              setEdgeDx(0);
              if (done) act();
              return;
            }
            setEdgeSettling(true);
            setEdgeDx(done ? width : 0);
            clearTimeout(settleTimer);
            settleTimer = setTimeout(() => {
              settleTimer = undefined;
              setEdgeSettling(false);
              setEdgeDx(0);
              if (done) act();
            }, 200);
            return;
          }
          edgeMode = "none";
          if (!downEligible || !t0) return;
          downEligible = false;
          const dy = t0.clientY - startY;
          const dx = Math.abs(t0.clientX - startX);
          if (dy > 70 && dy > dx * 1.5) props.onClose();
        }}
        onTouchCancel={() => {
          if (edgeMode === "horiz") {
            edgeMode = "none";
            setEdgeSettling(true);
            setEdgeDx(0);
            clearTimeout(settleTimer);
            settleTimer = setTimeout(() => {
              settleTimer = undefined;
              setEdgeSettling(false);
            }, 200);
          } else {
            edgeMode = "none";
          }
          downEligible = false;
        }}
      >
        <div class="grab" />
        <div class="sh">
          <Show
            when={props.onBack}
            fallback={
              <button class="cbtn" aria-label={t("common.close")} onClick={() => props.onClose()}>
                <Icon name="x" />
              </button>
            }
          >
            <button class="cbtn" aria-label={t("common.back")} onClick={() => props.onBack!()}>
              <Icon name="chevL" />
            </button>
          </Show>
          <div class="t">
            {props.title}
            <Show when={props.sub}>
              <small>{props.sub}</small>
            </Show>
          </div>
          <div>{props.right}</div>
        </div>
        <div class={`body${props.flush ? " flush" : ""}`}>{props.children}</div>
      </div>
    </div>
  );
}

export function DiffBadge(props: { add: number; del: number }) {
  return (
    <Show when={props.add || props.del}>
      <span class="dfb">
        <span class="a">+{props.add}</span>
        <span class="d">−{props.del}</span>
      </span>
    </Show>
  );
}

/** mobile-ui-and-themes.md §11: segmented Quota | Usage tab switcher shown whenever either feature is enabled. */
export function QuotaUsageTabs(props: { active: "quota" | "usage"; from: "home" | "settings" | "agents" }) {
  return (
    <Show when={state.quotaEnabled || state.usageEnabled}>
      <div style={{ "margin-top": "6px" }}>
        <div class="seg" style={{ display: "grid", "grid-template-columns": "repeat(2, minmax(0, 1fr))", padding: "3px" }}>
          <button
            class={props.active === "quota" ? "on" : undefined}
            style={{ height: "38px", "font-size": "14.5px" }}
            onClick={() => { if (props.active !== "quota") navigate({ name: "quota", from: props.from }); }}
          >
            {t("quota.tabQuota")}
          </button>
          <button
            class={props.active === "usage" ? "on" : undefined}
            style={{ height: "38px", "font-size": "14.5px" }}
            onClick={() => { if (props.active !== "usage") navigate({ name: "usage", from: props.from }); }}
          >
            {t("quota.tabUsage")}
          </button>
        </div>
      </div>
    </Show>
  );
}

/** mobile-ui-and-themes.md §11: amber notice shown on a disabled feature tab with a shortcut to Settings. */
export function FeatureDisabledNotice(props: { message: string }) {
  return (
    <div
      style={{
        margin: "14px 0 0",
        background: "var(--warnbg)",
        border: "1px solid var(--warn)",
        "border-radius": "18px",
        padding: "18px",
        display: "flex",
        "flex-direction": "column",
        gap: "14px",
        color: "var(--warn)",
      }}
    >
      <div style={{ display: "flex", "align-items": "flex-start", gap: "10px", "font-size": "14px", "font-weight": 550, "line-height": "1.5" }}>
        <span style={{ flex: "none", "margin-top": "2px" }}>
          <Icon name="alert" sm />
        </span>
        <span>{props.message}</span>
      </div>
      <button
        onClick={() => navigate({ name: "settings" })}
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          gap: "6px",
          width: "100%",
          "min-height": "42px",
          "border-radius": "12px",
          background: "var(--surface)",
          border: "1px solid var(--warn)",
          color: "var(--warn)",
          "font-size": "14px",
          "font-weight": 600,
        }}
      >
        <Icon name="gear" sm />
        {t("quota.openSettings")}
      </button>
    </div>
  );
}
