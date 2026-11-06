import { Show, type JSX } from "solid-js";
import { ICONS, type IconName } from "../icons";
import { state } from "../state/store";
import type { AgentStatus, PaneSummary, TabSummary, WorkspaceSummary } from "../../../types/protocol";
import { t } from "../i18n";

export function Icon(props: { name: IconName; sm?: boolean; class?: string }) {
  return <svg class={`i${props.sm ? " sm" : ""}${props.class ? ` ${props.class}` : ""}`} viewBox="0 0 24 24" innerHTML={ICONS[props.name]} aria-hidden="true" />;
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
