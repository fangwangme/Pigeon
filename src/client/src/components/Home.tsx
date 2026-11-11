import { createMemo, createSignal, For, Show } from "solid-js";
import { filterActive, navigate, quotaButtonShown, state, toggleCollapsed, type FilterState } from "../state/store";
import { selectPane } from "../state/ws";
import type { PaneSummary, TabSummary, WorkspaceSummary } from "../../../types/protocol";
import { openOverlay } from "./overlays";
import { agentLabel, Icon, Logo, modelLabel, paneStatus, paneSummary, primaryPane, StatusIcon, tabStatus, type RowStatus } from "./ui";
import { AgentIcon } from "./AgentIcon";
import { t, type MessageId } from "../i18n";
import { quotaDot } from "../../../shared/quota";

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
          <b>{!state.connected ? t("conn.computerDown") : t("conn.herdrDown")}</b> · {t("conn.retrying")}
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
    const parts = [p?.agent ? (modelLabel(p.model, p.agent) || agentLabel(p.agent)) : p?.program || t("agent.terminal")];
    if (props.tab.panes.length > 1) parts.push(t("home.paneCount", { count: props.tab.panes.length }));
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
          {t("common.rename")}
        </button>
        <button
          class="cls"
          onClick={() => {
            setOpen(false);
            openOverlay({ kind: "close", tabId: props.tab.id });
          }}
        >
          {t("common.close")}
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
        <AgentIcon kind={pane()?.agent} />
        <div class="tx">
          <div class="t">{props.tab.label}</div>
          <div class="s">{sub()}</div>
          <Show when={status() === "blocked" && paneSummary(pane())}>
            <div class="p">{paneSummary(pane())}</div>
          </Show>
        </div>
        <div class="srow-end">
          <StatusIcon status={status()} />
        </div>
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
  const dot = () => quotaDot(state.quotaSnapshots);
  return (
    <div class="cap">
      <Show when={quotaButtonShown()}>
        <button aria-label={t("quota.title")} onClick={() => navigate({ name: "quota", from: "home" })}>
          <Icon name="gauge" />
          <Show when={dot()}>
            <span class={`dot ${dot() === "danger" ? "red" : "amber"}`} />
          </Show>
        </button>
      </Show>
      <button aria-label={t("filter.title")} onClick={() => openOverlay({ kind: "filter" })}>
        <Icon name="sliders" />
        <Show when={filterActive()}>
          <span class="dot" />
        </Show>
      </button>
      <button aria-label={t("settings.title")} onClick={() => navigate({ name: "settings" })}>
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
        <div class="logo-mark" aria-label="Pigeon">
          <Logo />
        </div>
        <div class="sp" />
        <FilterButton />
      </div>
      <ConnectionBanner />
      <div class="scroll">
        <div class="home">
          <Show when={query() !== null}>
            <div class="searchbar">
              <Icon name="search" sm />
              <input
                placeholder={t("home.searchPlaceholder")}
                value={query() ?? ""}
                ref={(el) => setTimeout(() => el.focus(), 30)}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              <button aria-label={t("home.closeSearch")} class="cbtn" style={{ width: "32px", height: "32px", background: "none", border: "0", "box-shadow": "none" }} onClick={() => setQuery(null)}>
                <Icon name="x" sm />
              </button>
            </div>
          </Show>
          <button class="agsum" onClick={() => navigate({ name: "agents" })}>
            <div class="tx">
              <div class="t1">{t("agents.title")}</div>
              <div class="t2">
                <span>{t("home.agentCount", { count: agents().length })}</span>
                <Show when={waiting()}>
                  <span>
                    <span class="wd" />
                    {t("home.waitingCount", { count: waiting() })}
                  </span>
                </Show>
                <Show when={working()}>
                  <span>
                    <span class="spin" />
                    {t("home.workingCount", { count: working() })}
                  </span>
                </Show>
              </div>
            </div>
            <Icon name="chevR" />
          </button>

          <Show when={state.workspaces.length === 0 && state.connected}>
            <div class="emptyh">
              <Icon name="folder" />
              <div class="big">{t("home.noWorkspaces")}</div>
              {t("home.noWorkspacesHint")}
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
                    <button class="mini" aria-label={t("home.newIn", { name: ws.label })} onClick={() => navigate({ name: "new", workspaceId: ws.id, mode: "new" })}>
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
        <button class="cbtn lg" aria-label={t("home.search")} onClick={() => setQuery(query() === null ? "" : null)}>
          <Icon name="search" />
        </button>
        <button class="fab" onClick={() => navigate({ name: "new", workspaceId: focusedWs(), mode: "new" })}>
          <Icon name="plus" />
          {t("new.title")}
        </button>
      </div>
    </div>
  );
}

const GROUPS: Array<[RowStatus, MessageId]> = [
  ["blocked", "status.blocked"],
  ["working", "status.working"],
  ["done", "status.done"],
  ["idle", "status.idle"],
];

const STATUS_ORDER: Record<string, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  terminal: 4,
};

function statusRank(st: RowStatus): number {
  return STATUS_ORDER[st] ?? 99;
}

/** §2.2 */
export function AgentsPage() {
  // §2.2: every group starts expanded each time the page opens.
  const [shut, setShut] = createSignal<Record<string, boolean>>({});
  const [groupBy, setGroupBy] = createSignal<"status" | "workspace">("status");
  const rows = createMemo(() => agentPanes().filter((a) => passes(paneStatus(a.pane), a.pane.agent, state.filter)));

  const wsGroups = createMemo(() => {
    const map = new Map<string, { ws: WorkspaceSummary; items: Array<{ ws: WorkspaceSummary; tab: TabSummary; pane: PaneSummary }> }>();
    for (const r of rows()) {
      let g = map.get(r.ws.id);
      if (!g) {
        g = { ws: r.ws, items: [] };
        map.set(r.ws.id, g);
      }
      g.items.push(r);
    }
    const list = Array.from(map.values()).map((g) => ({
      ...g,
      items: g.items.slice().sort((a, b) => statusRank(paneStatus(a.pane)) - statusRank(paneStatus(b.pane))),
    }));
    return list.sort((a, b) => {
      const rankA = a.items.reduce((m, item) => Math.min(m, statusRank(paneStatus(item.pane))), 99);
      const rankB = b.items.reduce((m, item) => Math.min(m, statusRank(paneStatus(item.pane))), 99);
      return rankA - rankB;
    });
  });

  return (
    <div class="page">
      <div class="hdr">
        <button class="cbtn" aria-label={t("common.back")} onClick={() => navigate({ name: "home" })}>
          <Icon name="chevL" />
        </button>
        <div class="ht">
          <div class="t">{t("agents.title")}</div>
        </div>
        <div class="cap">
          <Show when={quotaButtonShown()}>
            <button aria-label={t("quota.title")} onClick={() => navigate({ name: "quota", from: "agents" })}>
              <Icon name="gauge" />
              <Show when={quotaDot(state.quotaSnapshots)}>
                <span class={`dot ${quotaDot(state.quotaSnapshots) === "danger" ? "red" : "amber"}`} />
              </Show>
            </button>
          </Show>
          <button aria-label={t("filter.title")} onClick={() => openOverlay({ kind: "filter" })}>
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
          <div class="seg" style={{ margin: "4px 0 14px" }}>
            <button class={groupBy() === "status" ? "on" : ""} onClick={() => setGroupBy("status")}>
              {t("agents.groupByStatus")}
            </button>
            <button class={groupBy() === "workspace" ? "on" : ""} onClick={() => setGroupBy("workspace")}>
              {t("agents.groupByWorkspace")}
            </button>
          </div>
          <Show when={rows().length === 0}>
            <div class="emptyh">
              <div class="big">{t("agents.empty")}</div>
              {filterActive() ? t("agents.emptyFiltered") : t("agents.emptyHint")}
            </div>
          </Show>
          <Show when={groupBy() === "status"}>
            <For each={GROUPS}>
              {([status, label]) => {
                const items = () => rows().filter((r) => paneStatus(r.pane) === status);
                return (
                  <Show when={items().length}>
                    <button class="gh" onClick={() => setShut({ ...shut(), [status]: !shut()[status] })} aria-expanded={!shut()[status]}>
                      <span class={`chev${shut()[status] ? " shut" : ""}`}>
                        <Icon name="chevD" sm />
                      </span>
                      {t(label)}
                      <span class="c">{items().length}</span>
                    </button>
                    <Show when={!shut()[status]}>
                      <For each={items()}>
                        {(r) => (
                          <button class="srow" onClick={() => openPane(r.pane.id, "agents")}>
                            <AgentIcon kind={r.pane.agent} />
                            <div class="tx">
                              <div class="t">{r.tab.label}</div>
                              <div class="s who">
                                <span class="wsn">
                                  <Icon name="folder" sm />
                                  {r.ws.label}
                                </span>
                                <span class="ag">{modelLabel(r.pane.model, r.pane.agent) || agentLabel(r.pane.agent)}</span>
                              </div>
                              <Show when={status === "blocked" && paneSummary(r.pane)}>
                                <div class="p">{paneSummary(r.pane)}</div>
                              </Show>
                            </div>
                            <div class="srow-end">
                              <StatusIcon status={status} />
                            </div>
                          </button>
                        )}
                      </For>
                    </Show>
                  </Show>
                );
              }}
            </For>
          </Show>
          <Show when={groupBy() === "workspace"}>
            <For each={wsGroups()}>
              {(g) => {
                const wsId = g.ws.id;
                return (
                  <Show when={g.items.length}>
                    <button class="gh" onClick={() => setShut({ ...shut(), [wsId]: !shut()[wsId] })} aria-expanded={!shut()[wsId]}>
                      <span class={`chev${shut()[wsId] ? " shut" : ""}`}>
                        <Icon name="chevD" sm />
                      </span>
                      <Icon name="folder" sm />
                      {g.ws.label}
                      <span class="c">{g.items.length}</span>
                    </button>
                    <Show when={!shut()[wsId]}>
                      <For each={g.items}>
                        {(r) => {
                          const st = () => paneStatus(r.pane);
                          return (
                            <button class="srow" onClick={() => openPane(r.pane.id, "agents")}>
                              <AgentIcon kind={r.pane.agent} />
                              <div class="tx">
                                <div class="t">{r.tab.label}</div>
                                <div class="s who">
                                  <span class="ag">{modelLabel(r.pane.model, r.pane.agent) || agentLabel(r.pane.agent)}</span>
                                </div>
                                <Show when={st() === "blocked" && paneSummary(r.pane)}>
                                  <div class="p">{paneSummary(r.pane)}</div>
                                </Show>
                              </div>
                              <div class="srow-end">
                                <StatusIcon status={st()} />
                              </div>
                            </button>
                          );
                        }}
                      </For>
                    </Show>
                  </Show>
                );
              }}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
