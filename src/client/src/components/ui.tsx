import { Show, type JSX } from "solid-js";
import { ICONS, type IconName } from "../icons";
import { state } from "../state/store";
import type { AgentStatus, PaneSummary, TabSummary, WorkspaceSummary } from "../../../types/protocol";
import { t } from "../i18n";

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
          <feDropShadow dx="0" dy="10" stdDeviation="11" flood-color="#1D2021" flood-opacity="0.24" />
        </filter>
      </defs>
      <rect x="6" y="6" width="500" height="500" rx="110" fill="url(#pigeon-logo-bg)" stroke="url(#pigeon-logo-bd)" stroke-width="12" />
      <g filter="url(#pigeon-logo-drop)">
        <path class="w-back-1" d="M 208 220 L 292 82 L 304 214 L 236 206 Z" />
        <path class="w-back-2" d="M 268 210 L 292 82 L 304 214 Z" />
        <path class="flank" d="M 56 306 L 122 284 L 170 252 L 236 202 L 304 214 L 358 150 L 396 170 L 444 184 L 380 198 L 344 256 L 326 330 L 232 382 L 142 338 L 78 354 Z" />
        <path class="tail-1" d="M 56 306 L 142 338 L 78 354 Z" />
        <path class="tail-2" d="M 56 306 L 122 284 L 142 338 Z" />
        <path class="belly" d="M 122 284 L 142 338 L 232 382 Z" />
        <path class="flank" d="M 122 284 L 232 382 L 344 256 L 304 214 L 236 202 L 170 252 Z" />
        <path class="breast" d="M 232 382 L 326 330 L 344 256 Z" />
        <path class="throat" d="M 304 214 L 396 170 L 380 198 L 344 256 Z" />
        <path class="crown" d="M 304 214 L 358 150 L 396 170 Z" />
        <path class="beak-1" d="M 396 170 L 444 184 L 380 198 Z" />
        <path class="beak-2" d="M 388 184 L 444 184 L 380 198 Z" />
        <path class="w-front-1" d="M 170 252 L 246 88 L 230 296 Z" />
        <path class="w-front-2" d="M 202 275 L 246 88 L 230 296 Z" />
        <circle cx="362" cy="180" r="10.5" fill="#282828" />
        <circle cx="364" cy="178" r="4.2" fill="#FE8019" />
        <circle cx="360" cy="176" r="1.8" fill="#FBF1C7" />
        <g transform="rotate(-6 416 228)">
          <rect class="env-base" x="378" y="202" width="78" height="52" rx="6" />
          <path class="env-fold" d="M 380 252 L 417 224 L 454 252 Z" />
          <path class="env-flap" d="M 379 204 L 417 232 L 455 204 Z" />
          <path d="M 380 204 L 417 232 L 454 204" fill="none" stroke="#282828" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
          <circle cx="417" cy="232" r="4.2" fill="#FE8019" stroke="#282828" stroke-width="2" />
        </g>
      </g>
    </svg>
  );
}

export type RowStatus = "blocked" | "working" | "done" | "idle" | "terminal";

/** mobile-ui-and-themes.md §2.1: the row icon for a status. */
export function StatusIcon(props: { status: RowStatus }) {
  return (
    <>
      <Show when={props.status === "working"}>
        <span class="si">
          <span class="spin" />
        </span>
      </Show>
      <Show when={props.status === "blocked"}>
        <span class="si wait" />
      </Show>
      <Show when={props.status === "done"}>
        <span class="si done">
          <Icon name="check" sm />
        </span>
      </Show>
      <Show when={props.status === "idle"}>
        <span class="si idle" />
      </Show>
      <Show when={props.status === "terminal"}>
        <span class="si">
          <Icon name="term" sm />
        </span>
      </Show>
    </>
  );
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

/** A bottom sheet over a scrim; a tap on the scrim closes it. */
export function Sheet(props: {
  title?: JSX.Element;
  sub?: string;
  onClose: () => void;
  onBack?: () => void;
  right?: JSX.Element;
  full?: boolean;
  children: JSX.Element;
  noHeader?: boolean;
}) {
  return (
    <div class="overlay" role="dialog" aria-modal="true">
      <div class="scrim" onClick={() => props.onClose()} />
      <div class={`sheet${props.full ? " full" : ""}`}>
        <div class="grab" />
        <Show when={!props.noHeader}>
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
        </Show>
        <div class="body">{props.children}</div>
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
