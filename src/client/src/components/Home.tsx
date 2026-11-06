import { createMemo, createSignal, For, Show } from "solid-js";
import { filterActive, navigate, state, toggleCollapsed, type FilterState } from "../state/store";
import { selectPane } from "../state/ws";
import type { PaneSummary, TabSummary, WorkspaceSummary } from "../../../types/protocol";
import { openOverlay } from "./overlays";
import { agentLabel, Icon, paneStatus, primaryPane, StatusIcon, tabStatus, type RowStatus } from "./ui";

function passes(status: RowStatus, agent: string | null | undefined, f: FilterState): boolean {
  if (status === "terminal" && !f.showTerminals) return false;
  if (status === "idle" && !f.showIdle) return false;
  if (f.statuses.length && !f.statuses.includes(status)) return false;
  if (f.agents.length && (!agent || !f.agents.includes(agent))) return false;
  return true;
}

function openPane(paneId: string, from: "home" | "agents"): void {
  selectPane(paneId);
  navigate({ name: "session", from });
}

/** §8.3 connection banner, shown above lists and the session. */
export function ConnectionBanner() {
  return (
    <Show when={!state.connected || !state.herdrConnected}>
      <div class="banner" role="status">
        <Icon name="wifioff" sm />
        <span>
          <b>{!state.connected ? "电脑未连接" : "Herdr 没有响应"}</b> · 每 3 秒重试
        </span>
      </div>
    </Show>
  );
}

function TabRow(props: { ws: WorkspaceSummary; tab: TabSummary }) {
  const [open, setOpen] = createSignal(false);
  let startX = 0;
  let startY = 0;
  let swiping = false;
  const pane = () => primaryPane(props.tab);
  const status = () => tabStatus(props.tab);
  const sub = () => {
    const p = pane();
    const parts = [p?.agent ? agentLabel(p.agent) : p?.program || "终端"];
    if (props.tab.panes.length > 1) parts.push(`${props.tab.panes.length} 个 pane`);
    return parts.join(" · ");
  };
  return (
    <div class="rowwrap">
      <div class="rowacts" aria-hidden={!open()} style={{ visibility: open() ? "visible" : "hidden" }}>
        <button
          class="ren"
          onClick={() => {
            setOpen(false);
            openOverlay({ kind: "rename", tabId: props.tab.id });
          }}
        >
          重命名
        </button>
        <button
          class="cls"
          onClick={() => {
            setOpen(false);
            openOverlay({ kind: "close", tabId: props.tab.id });
          }}
        >
          关闭
        </button>
      </div>
      <button
        class="srow"
        style={{ transform: open() ? "translateX(-152px)" : "none" }}
        onTouchStart={(e) => {
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
          swiping = false;
        }}
        onTouchMove={(e) => {
          const dx = e.touches[0].clientX - startX;
          const dy = e.touches[0].clientY - startY;
          if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            swiping = true;
            setOpen(dx < 0);
          }
        }}
        onClick={() => {
          if (swiping) return;
          if (open()) return setOpen(false);
          const p = pane();
          if (p) openPane(p.id, "home");
        }}
      >
        <StatusIcon status={status()} />
        <div class="tx">
          <div class="t">{props.tab.label}</div>
          <div class="s">{sub()}</div>
          <Show when={status() === "blocked" && pane()?.summary}>
            <div class="p">{pane()!.summary}</div>
          </Show>
        </div>
        <Show when={pane() && state.unread[pane()!.id]}>
          <span class="udot" aria-label="有新结果" />
        </Show>
      </button>
    </div>
  );
}

function agentPanes(): Array<{ ws: WorkspaceSummary; tab: TabSummary; pane: PaneSummary }> {
  const out: Array<{ ws: WorkspaceSummary; tab: TabSummary; pane: PaneSummary }> = [];
  for (const ws of state.workspaces) for (const tab of ws.tabs) for (const pane of tab.panes) if (pane.agent) out.push({ ws, tab, pane });
  return out;
}

function FilterButton() {
  return (
    <div class="cap">
      <button aria-label="筛选" onClick={() => openOverlay({ kind: "filter" })}>
        <Icon name="sliders" />
        <Show when={filterActive()}>
          <span class="dot" />
        </Show>
      </button>
      <button aria-label="设置" onClick={() => navigate({ name: "settings" })}>
        <Icon name="gear" />
      </button>
    </div>
  );
}

/** §2.1 */
export function Home() {
  const [query, setQuery] = createSignal<string | null>(null);
  const agents = createMemo(agentPanes);
  const waiting = () => agents().filter((a) => a.pane.agentStatus === "blocked").length;
  const working = () => agents().filter((a) => a.pane.agentStatus === "working").length;
  const visibleTabs = (ws: WorkspaceSummary) => {
    const q = query()?.trim().toLowerCase();
    return ws.tabs.filter((t) => {
      if (q && !t.label.toLowerCase().includes(q) && !ws.label.toLowerCase().includes(q)) return false;
      return passes(tabStatus(t), primaryPane(t)?.agent, state.filter);
    });
  };
  const focusedWs = () => (state.workspaces.find((w) => w.isFocused) ?? state.workspaces[0])?.id ?? null;
  return (
    <div class="page">
      <div class="hdr">
        <div class="lt">Pigeon</div>
        <FilterButton />
      </div>
      <ConnectionBanner />
      <div class="scroll">
        <div class="home">
          <Show when={query() !== null}>
            <div class="searchbar">
              <Icon name="search" sm />
              <input
                placeholder="搜索标签页或工作区"
                value={query() ?? ""}
                ref={(el) => setTimeout(() => el.focus(), 30)}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              <button aria-label="关闭搜索" class="cbtn" style={{ width: "32px", height: "32px", background: "none", border: "0", "box-shadow": "none" }} onClick={() => setQuery(null)}>
                <Icon name="x" sm />
              </button>
            </div>
          </Show>
          <button class="agsum" onClick={() => navigate({ name: "agents" })}>
            <div class="tx">
              <div class="t1">所有 Agent</div>
              <div class="t2">
                <span>{agents().length} 个</span>
                <Show when={waiting()}>
                  <span>
                    <span class="wd" />
                    {waiting()} 个等你
                  </span>
                </Show>
                <Show when={working()}>
                  <span>
                    <span class="spin" />
                    {working()} 个工作中
                  </span>
                </Show>
              </div>
            </div>
            <Icon name="chevR" />
          </button>

          <Show when={state.workspaces.length === 0 && state.connected}>
            <div class="emptyh">
              <Icon name="folder" />
              <div class="big">还没有工作区</div>
              在电脑上的 Herdr 里打开一个工作区，它会出现在这里。
            </div>
          </Show>

          <For each={state.workspaces}>
            {(ws) => {
              const shut = () => !!state.collapsed[ws.id];
              const tabs = () => visibleTabs(ws);
              return (
                <Show when={!query()?.trim() || tabs().length > 0}>
                  <div class="wsh">
                    <button class="tg2" onClick={() => toggleCollapsed(ws.id)} aria-expanded={!shut()}>
                      <span class={`chev${shut() ? " shut" : ""}`}>
                        <Icon name="chevD" sm />
                      </span>
                      <span class="n">{ws.label}</span>
                      <Show when={ws.branch}>
                        <span class="m">
                          <Icon name="branch" sm />
                          {ws.branch}
                        </span>
                      </Show>
                      <span class="m">{ws.tabs.length}</span>
                    </button>
                    <button class="mini" aria-label={`在 ${ws.label} 新建会话`} onClick={() => navigate({ name: "new", workspaceId: ws.id, mode: "new" })}>
                      <Icon name="plus" sm />
                    </button>
                  </div>
                  <Show when={!shut()}>
                    <For each={tabs()}>{(tab) => <TabRow ws={ws} tab={tab} />}</For>
                  </Show>
                </Show>
              );
            }}
          </For>
        </div>
      </div>
      <div class="bottombar">
        <button class="cbtn lg" aria-label="搜索" onClick={() => setQuery(query() === null ? "" : null)}>
          <Icon name="search" />
        </button>
        <button class="fab" onClick={() => navigate({ name: "new", workspaceId: focusedWs(), mode: "new" })}>
          <Icon name="plus" />
          新会话
        </button>
      </div>
    </div>
  );
}

const GROUPS: Array<[RowStatus, string]> = [
  ["blocked", "等待你"],
  ["working", "工作中"],
  ["done", "已完成"],
  ["idle", "空闲"],
];

/** §2.2 */
export function AgentsPage() {
  const [shut, setShut] = createSignal<Record<string, boolean>>({ idle: true });
  const rows = createMemo(() => agentPanes().filter((a) => passes(paneStatus(a.pane), a.pane.agent, state.filter)));
  return (
    <div class="page">
      <div class="hdr">
        <button class="cbtn" aria-label="返回" onClick={() => navigate({ name: "home" })}>
          <Icon name="chevL" />
        </button>
        <div class="ht">
          <div class="t">所有 Agent</div>
        </div>
        <div class="cap">
          <button aria-label="筛选" onClick={() => openOverlay({ kind: "filter" })}>
            <Icon name="sliders" />
            <Show when={filterActive()}>
              <span class="dot" />
            </Show>
          </button>
        </div>
      </div>
      <ConnectionBanner />
      <div class="scroll">
        <div class="home">
          <Show when={rows().length === 0}>
            <div class="emptyh">
              <div class="big">没有 Agent</div>
              {filterActive() ? "当前筛选下没有结果。" : "在新会话里启动一个 Agent。"}
            </div>
          </Show>
          <For each={GROUPS}>
            {([status, label]) => {
              const items = () => rows().filter((r) => paneStatus(r.pane) === status);
              return (
                <Show when={items().length}>
                  <button class="gh" onClick={() => setShut({ ...shut(), [status]: !shut()[status] })} aria-expanded={!shut()[status]}>
                    <span class={`chev${shut()[status] ? " shut" : ""}`} style={{ color: "var(--faint)" }}>
                      <Icon name="chevD" sm />
                    </span>
                    {label}
                    <span class="c">{items().length}</span>
                  </button>
                  <Show when={!shut()[status]}>
                    <For each={items()}>
                      {(r) => (
                        <button class="srow" onClick={() => openPane(r.pane.id, "agents")}>
                          <StatusIcon status={status} />
                          <div class="tx">
                            <div class="t">{r.tab.label}</div>
                            <div class="s">
                              {r.ws.label} · {agentLabel(r.pane.agent)}
                            </div>
                            <Show when={status === "blocked" && r.pane.summary}>
                              <div class="p">{r.pane.summary}</div>
                            </Show>
                          </div>
                          <Show when={state.unread[r.pane.id]}>
                            <span class="udot" />
                          </Show>
                        </button>
                      )}
                    </For>
                  </Show>
                </Show>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
