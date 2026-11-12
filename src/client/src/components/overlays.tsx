import { createSignal, For, Show } from "solid-js";
import { EMPTY_FILTER, filterActive, navigate, setFilter, showToast, state, type FilterState } from "../state/store";
import { request } from "../state/ws";
import { agentLabel, findTab, Icon, paneLabel, Sheet } from "./ui";
import { t, type MessageId } from "../i18n";

// Sheets reached from more than one screen (mobile-ui-and-themes.md §2.1 swipe actions, §6.5 menu).
type Overlay =
  | { kind: "rename"; tabId: string }
  | { kind: "close"; tabId: string }
  | { kind: "filter" }
  | { kind: "image"; url: string; alt?: string }
  | null;

const [overlay, setOverlay] = createSignal<Overlay>(null);
export const openOverlay = setOverlay;

export function openImage(url: string, alt?: string): void {
  setOverlay({ kind: "image", url, alt });
}

function ImageViewer(props: { url: string; alt?: string }) {
  return (
    <div
      class="img-viewer-overlay"
      role="dialog"
      aria-modal="true"
      onClick={() => setOverlay(null)}
    >
      <button
        class="img-viewer-close"
        aria-label={t("common.close")}
        onClick={(e) => {
          e.stopPropagation();
          setOverlay(null);
        }}
      >
        <Icon name="x" />
      </button>
      <div class="img-viewer-content" onClick={(e) => e.stopPropagation()}>
        <img
          src={props.url}
          alt={props.alt || ""}
          onClick={() => setOverlay(null)}
        />
      </div>
    </div>
  );
}

function RenameSheet(props: { tabId: string }) {
  const found = findTab(props.tabId);
  const [name, setName] = createSignal(found?.tab.label ?? "");
  const [busy, setBusy] = createSignal(false);
  const save = () => {
    const v = name().trim();
    if (!v || busy()) return;
    setBusy(true);
    request({ type: "tab_rename", payload: { tabId: props.tabId, name: v } })
      .then(() => setOverlay(null))
      .catch((e) => showToast(e.message || t("rename.failed")))
      .finally(() => setBusy(false));
  };
  return (
    <Sheet title={t("common.rename")} onClose={() => setOverlay(null)}>
      <input
        class="inp"
        value={name()}
        maxLength={80}
        ref={(el) => setTimeout(() => el.focus(), 50)}
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.isComposing) save();
        }}
      />
      <p class="note">{t("rename.note")}</p>
      <button class="btn acc blk" style={{ "margin-top": "10px" }} disabled={!name().trim() || busy()} onClick={save}>
        {busy() ? t("common.saving") : t("common.save")}
      </button>
    </Sheet>
  );
}

/** §6.7: says what ends before anything is closed. */
function CloseSheet(props: { tabId: string }) {
  const found = findTab(props.tabId);
  const [busy, setBusy] = createSignal(false);
  const working = () => found?.tab.panes.some((p) => p.agent && p.agentStatus === "working");
  const confirm = () => {
    if (busy()) return;
    setBusy(true);
    request({ type: "close_tab", payload: { tabId: props.tabId } })
      .then(() => {
        setOverlay(null);
        // §6.7: back to where the session was opened from.
        if (state.activeTabId === props.tabId && state.route.name === "session") navigate({ name: state.route.from });
      })
      .catch((e) => showToast(e.message || t("close.failed")))
      .finally(() => setBusy(false));
  };
  return (
    <Sheet title={t("close.title")} sub={found?.tab.label} onClose={() => setOverlay(null)}>
      <p class="note" style={{ "font-size": "15px", color: "var(--fg)" }}>
        {t("close.lead")}
      </p>
      <div class="card" style={{ margin: "8px 0" }}>
        <For each={found?.tab.panes ?? []}>
          {(p) => (
            <div class="li">
              <Icon name={p.agent ? "spark" : "term"} />
              <div class="tx">
                {paneLabel(p)}
                <small>{p.agent ? (p.agentStatus === "working" ? t("close.paneWorking") : "Agent") : "Shell"}</small>
              </div>
            </div>
          )}
        </For>
      </div>
      <Show when={working()}>
        <div class="banner" style={{ margin: "8px 0" }}>
          <Icon name="alert" sm />
          <span>{t("close.workingWarn")}</span>
        </div>
      </Show>
      <p class="note">{t("close.keptNote")}</p>
      <div class="optbtns" style={{ "margin-top": "12px" }}>
        <button class="btn red blk" disabled={busy()} onClick={confirm}>
          {busy() ? t("close.closing") : t("common.close")}
        </button>
        <button class="btn blk" onClick={() => setOverlay(null)}>
          {t("common.cancel")}
        </button>
      </div>
    </Sheet>
  );
}

const STATUS_CHOICES: Array<[FilterState["statuses"][number], MessageId]> = [
  ["blocked", "status.blocked"],
  ["working", "status.working"],
  ["done", "status.done"],
  ["idle", "status.idle"],
  ["terminal", "agent.terminal"],
];

/** §2.3: stored in this browser only. */
function FilterSheet() {
  const toggle = <K extends "statuses" | "agents">(key: K, v: FilterState[K][number]) => {
    const list = state.filter[key] as string[];
    const next = list.includes(v as string) ? list.filter((x) => x !== v) : [...list, v as string];
    setFilter({ ...state.filter, [key]: next });
  };
  return (
    <Sheet
      title={t("filter.title")}
      onClose={() => setOverlay(null)}
      right={
        <Show when={filterActive()}>
          <button class="lnk" onClick={() => setFilter({ ...EMPTY_FILTER, groupBy: state.filter.groupBy })}>
            {t("filter.reset")}
          </button>
        </Show>
      }
    >
      <div class="sec">{t("filter.grouping")}</div>
      <div class="chipr">
        <button
          class={`chip${(state.filter.groupBy || "status") === "status" ? " hi" : ""}`}
          onClick={() => setFilter({ ...state.filter, groupBy: "status" })}
        >
          {t("agents.groupByStatus")}
        </button>
        <button
          class={`chip${state.filter.groupBy === "workspace" ? " hi" : ""}`}
          onClick={() => setFilter({ ...state.filter, groupBy: "workspace" })}
        >
          {t("agents.groupByWorkspace")}
        </button>
      </div>
      <div class="sec">{t("filter.status")}</div>
      <div class="chipr" style={{ "flex-wrap": "wrap" }}>
        <For each={STATUS_CHOICES}>
          {([v, label]) => (
            <button class={`chip${state.filter.statuses.includes(v) ? " hi" : ""}`} onClick={() => toggle("statuses", v)}>
              {t(label)}
            </button>
          )}
        </For>
      </div>
      <div class="sec">Agent</div>
      <div class="chipr" style={{ "flex-wrap": "wrap" }}>
        <For each={Object.keys(state.recipes)}>
          {(kind) => (
            <button class={`chip${state.filter.agents.includes(kind) ? " hi" : ""}`} onClick={() => toggle("agents", kind)}>
              {agentLabel(kind)}
            </button>
          )}
        </For>
      </div>
      <div class="sec">{t("filter.show")}</div>
      <div class="card">
        <button class="li" onClick={() => setFilter({ ...state.filter, showTerminals: !state.filter.showTerminals })}>
          <div class="tx">{t("filter.showTerminals")}</div>
          <span class={`tg${state.filter.showTerminals ? "" : " off"}`} />
        </button>
        <button class="li" onClick={() => setFilter({ ...state.filter, showIdle: !state.filter.showIdle })}>
          <div class="tx">{t("filter.showIdle")}</div>
          <span class={`tg${state.filter.showIdle ? "" : " off"}`} />
        </button>
      </div>
      <p class="note">{t("filter.note")}</p>
    </Sheet>
  );
}

export function Overlays() {
  return (
    <>
      <Show when={overlay()?.kind === "rename" && (overlay() as { tabId: string }).tabId} keyed>
        {(tabId) => <RenameSheet tabId={tabId} />}
      </Show>
      <Show when={overlay()?.kind === "close" && (overlay() as { tabId: string }).tabId} keyed>
        {(tabId) => <CloseSheet tabId={tabId} />}
      </Show>
      <Show when={overlay()?.kind === "filter"}>
        <FilterSheet />
      </Show>
      <Show when={overlay()?.kind === "image" ? (overlay() as { kind: "image"; url: string; alt?: string }) : null} keyed>
        {(img) => <ImageViewer url={img.url} alt={img.alt} />}
      </Show>
    </>
  );
}
