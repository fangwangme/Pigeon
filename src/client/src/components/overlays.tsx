import { createSignal, For, Show } from "solid-js";
import { EMPTY_FILTER, filterActive, navigate, setFilter, showToast, state, type FilterState } from "../state/store";
import { request } from "../state/ws";
import { agentLabel, findTab, Icon, paneLabel, Sheet } from "./ui";

// Sheets reached from more than one screen (mobile-ui-and-themes.md §2.1 swipe actions, §6.5 menu).
type Overlay = { kind: "rename"; tabId: string } | { kind: "close"; tabId: string } | { kind: "filter" } | null;

const [overlay, setOverlay] = createSignal<Overlay>(null);
export const openOverlay = setOverlay;

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
      .catch((e) => showToast(e.message || "重命名失败"))
      .finally(() => setBusy(false));
  };
  return (
    <Sheet title="重命名" onClose={() => setOverlay(null)}>
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
      <p class="note">改的是电脑上 Herdr 的标签名。</p>
      <button class="btn acc blk" style={{ "margin-top": "10px" }} disabled={!name().trim() || busy()} onClick={save}>
        {busy() ? "保存中…" : "保存"}
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
        if (state.activeTabId === props.tabId && state.route.name === "session") navigate({ name: "home" });
      })
      .catch((e) => showToast(e.message || "关闭失败"))
      .finally(() => setBusy(false));
  };
  return (
    <Sheet title="关闭会话" sub={found?.tab.label} onClose={() => setOverlay(null)}>
      <p class="note" style={{ "font-size": "15px", color: "var(--fg)" }}>
        电脑上的这个标签页会关闭，其中的程序随之结束：
      </p>
      <div class="card" style={{ margin: "8px 0" }}>
        <For each={found?.tab.panes ?? []}>
          {(p) => (
            <div class="li">
              <Icon name={p.agent ? "spark" : "term"} />
              <div class="tx">
                {paneLabel(p)}
                <small>{p.agent ? (p.agentStatus === "working" ? "正在工作" : "Agent") : "Shell"}</small>
              </div>
            </div>
          )}
        </For>
      </div>
      <Show when={working()}>
        <div class="banner" style={{ margin: "8px 0" }}>
          <Icon name="alert" sm />
          <span>有 Agent 还在工作，关闭会打断它。</span>
        </div>
      </Show>
      <p class="note">Agent 的会话记录会保留，之后可以从历史会话恢复。</p>
      <div class="optbtns" style={{ "margin-top": "12px" }}>
        <button class="btn red blk" disabled={busy()} onClick={confirm}>
          {busy() ? "关闭中…" : "关闭"}
        </button>
        <button class="btn blk" onClick={() => setOverlay(null)}>
          取消
        </button>
      </div>
    </Sheet>
  );
}

const STATUS_CHOICES: Array<[FilterState["statuses"][number], string]> = [
  ["blocked", "等待你"],
  ["working", "工作中"],
  ["done", "已完成"],
  ["idle", "空闲"],
  ["terminal", "终端"],
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
      title="筛选"
      onClose={() => setOverlay(null)}
      right={
        <Show when={filterActive()}>
          <button class="lnk" onClick={() => setFilter(EMPTY_FILTER)}>
            重置
          </button>
        </Show>
      }
    >
      <div class="sec">状态</div>
      <div class="chipr" style={{ "flex-wrap": "wrap" }}>
        <For each={STATUS_CHOICES}>
          {([v, label]) => (
            <button class={`chip${state.filter.statuses.includes(v) ? " hi" : ""}`} onClick={() => toggle("statuses", v)}>
              {label}
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
      <div class="sec">显示</div>
      <div class="card">
        <button class="li" onClick={() => setFilter({ ...state.filter, showTerminals: !state.filter.showTerminals })}>
          <div class="tx">显示普通终端</div>
          <span class={`tg${state.filter.showTerminals ? "" : " off"}`} />
        </button>
        <button class="li" onClick={() => setFilter({ ...state.filter, showIdle: !state.filter.showIdle })}>
          <div class="tx">显示空闲的会话</div>
          <span class={`tg${state.filter.showIdle ? "" : " off"}`} />
        </button>
      </div>
      <p class="note">筛选只保存在这台手机上。</p>
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
    </>
  );
}
