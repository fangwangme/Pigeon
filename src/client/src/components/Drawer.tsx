import { Component, For, Show } from "solid-js";
import {
  state,
  setState,
  closeDrawer,
  openAppearanceModal,
  openMacrosModal,
  openPairingModal,
} from "../state/store";
import { selectPane } from "../state/ws";

export const Drawer: Component = () => {
  const blockedAgents = () => state.workingAgents.filter((a) => a.status === "blocked");
  const workingAgents = () => state.workingAgents.filter((a) => a.status === "working");

  const groupedWorkspaces = () => {
    const map = new Map<string, { workspaceId: string; workspaceLabel: string; hasBlocked: boolean; hasWorking: boolean; agents: typeof state.workingAgents }>();
    const statusPriority = (status: string) => {
      if (status === "blocked") return 0;
      if (status === "working") return 1;
      return 2;
    };
    for (const a of state.workingAgents) {
      let group = map.get(a.workspaceId);
      if (!group) {
        group = {
          workspaceId: a.workspaceId,
          workspaceLabel: a.workspaceLabel || a.workspaceId,
          hasBlocked: false,
          hasWorking: false,
          agents: [],
        };
        map.set(a.workspaceId, group);
      }
      if (a.status === "blocked") group.hasBlocked = true;
      if (a.status === "working") group.hasWorking = true;
      group.agents.push(a);
    }
    for (const group of map.values()) {
      group.agents.sort((a, b) => statusPriority(a.status) - statusPriority(b.status));
    }
    const groups = Array.from(map.values());
    groups.sort((a, b) => {
      const scoreA = (a.hasBlocked ? 20 : 0) + (a.hasWorking ? 10 : 0);
      const scoreB = (b.hasBlocked ? 20 : 0) + (b.hasWorking ? 10 : 0);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.workspaceLabel.localeCompare(b.workspaceLabel);
    });
    return groups;
  };

  return (
    <Show when={state.drawerOpen}>
      {/* Scrim backdrop */}
      <div
        aria-hidden="true"
        onClick={closeDrawer}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--scrim)",
          "z-index": 40,
        }}
      />

      <aside
        aria-label="导航抽屉"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width: "320px",
          "box-sizing": "border-box",
          background: "var(--sheet)",
          "border-right": "1px solid var(--border)",
          display: "flex",
          "flex-direction": "column",
          "z-index": 50,
          color: "var(--fg)",
        }}
      >
        {/* Drawer Header */}
        <div
          style={{
            height: "72px",
            "flex-shrink": 0,
            display: "flex",
            "align-items": "center",
            gap: "12px",
            padding: "0 16px",
            "border-bottom": "1px solid var(--line)",
          }}
        >
          <div
            style={{
              width: "36px",
              height: "36px",
              "border-radius": "10px",
              background: "var(--sel)",
              border: "1px solid var(--selb)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              color: "var(--accent)",
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 11l18-7-7 18-2.5-8z" />
              <path d="M11.5 14L21 4" />
            </svg>
          </div>
          <div style={{ flex: 1, "min-width": 0 }}>
            <div style={{ "font-size": "16px", "font-weight": 700 }}>Pigeon</div>
            <div style={{ "font-size": "12px", color: "var(--muted)" }}>
              {state.serverHost} · Tailscale
            </div>
          </div>
          <button
            aria-label="关闭抽屉"
            class="touch-target"
            onClick={closeDrawer}
            style={{
              width: "44px",
              height: "44px",
              border: 0,
              background: "transparent",
              color: "var(--muted)",
              "border-radius": "10px",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              cursor: "pointer",
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* Scrollable Drawer Body */}
        <div
          style={{
            flex: 1,
            "min-height": 0,
            "overflow-y": "auto",
            "-webkit-overflow-scrolling": "touch",
            "touch-action": "pan-y",
            display: "flex",
            "flex-direction": "column",
          }}
        >
          {/* Workspaces list */}
          <div style={{ padding: "16px 8px 8px", "flex-shrink": 0 }}>
            <div
              style={{
                display: "flex",
                "align-items": "baseline",
                "justify-content": "space-between",
                padding: "0 8px 8px",
              }}
            >
              <span
                style={{
                  "font-size": "12px",
                  "font-weight": 600,
                  "letter-spacing": "0.04em",
                  color: "var(--muted)",
                }}
              >
                工作区
              </span>
              <span style={{ "font-size": "11px", color: "var(--faint)" }}>
                只读，在电脑上创建
              </span>
            </div>

            <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
              <For each={state.workspaces}>
                {(w) => {
                  const isSelected = () => state.activeWorkspaceId === w.id;
                  return (
                    <button
                      class="touch-target"
                      onClick={() => {
                        setState("activeWorkspaceId", w.id);
                        const targetTab =
                          w.tabs?.find((t) =>
                            t.panes?.some(
                              (p) => p.agentStatus === "working" || p.agentStatus === "blocked"
                            )
                          ) ||
                          w.tabs?.find((t) => t.id === w.activeTabId) ||
                          w.tabs?.[0];

                        if (targetTab?.id) {
                          setState("activeTabId", targetTab.id);
                          const targetPane =
                            targetTab.panes?.find(
                              (p) => p.agentStatus === "working" || p.agentStatus === "blocked"
                            ) || targetTab.panes?.[0];
                          if (targetPane?.id) {
                            selectPane(targetPane.id, w.id, targetTab.id);
                          }
                        }
                        closeDrawer();
                      }}
                      style={{
                        height: "48px",
                        display: "flex",
                        "align-items": "center",
                        gap: "10px",
                        padding: "0 12px",
                        border: 0,
                        "border-radius": "10px",
                        background: isSelected() ? "var(--sel)" : "transparent",
                        color: "var(--fg)",
                        "font-size": "14px",
                        "font-weight": isSelected() ? 600 : 500,
                        "text-align": "left",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ flex: 1 }}>{w.label}</span>
                      <span style={{ display: "flex", "align-items": "center", gap: "4px" }}>
                        <Show when={w.hasWarn}>
                          <span
                            style={{
                              width: "6px",
                              height: "6px",
                              "border-radius": "3px",
                              background: "var(--warn)",
                            }}
                          />
                        </Show>
                        <Show when={w.hasWorking}>
                          <span
                            style={{
                              width: "6px",
                              height: "6px",
                              "border-radius": "3px",
                              background: "var(--accent)",
                            }}
                          />
                        </Show>
                      </span>
                      <span
                        style={{
                          "font-size": "12px",
                          "font-weight": isSelected() ? 500 : 400,
                          color: "var(--muted)",
                          "min-width": "40px",
                          "text-align": "right",
                        }}
                      >
                        {w.tabCount || w.tabs?.length || 1} Tab
                      </span>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>

          <div style={{ height: "1px", margin: "8px 16px", background: "var(--line)", "flex-shrink": 0 }} />

          {/* Running Agents list */}
          <div
            style={{
              padding: "8px 8px 16px",
              display: "flex",
              "flex-direction": "column",
            }}
          >
            <div
              style={{
                display: "flex",
                "align-items": "baseline",
                "justify-content": "space-between",
                padding: "0 8px 8px",
              }}
            >
              <span
                style={{
                  "font-size": "12px",
                  "font-weight": 600,
                  "letter-spacing": "0.04em",
                  color: "var(--muted)",
                }}
              >
                运行中的 Agent
              </span>
              <span style={{ "font-size": "11px", color: "var(--faint)" }}>
                {blockedAgents().length} 待确认 · {workingAgents().length} 工作中
              </span>
            </div>

            <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
              <For each={groupedWorkspaces()}>
                {(group) => (
                  <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                    <div
                      style={{
                        padding: "2px 8px",
                        "font-size": "11px",
                        "font-weight": 700,
                        color: "var(--muted)",
                      }}
                    >
                      {group.workspaceLabel}
                    </div>
                    <For each={group.agents}>
                      {(a) => {
                        const isBlocked = a.status === "blocked";
                        return (
                          <button
                            class="touch-target"
                            onClick={() => {
                              setState("activeWorkspaceId", a.workspaceId);
                              setState("activeTabId", a.tabId);
                              selectPane(a.paneId, a.workspaceId, a.tabId);
                              closeDrawer();
                            }}
                            style={{
                              display: "flex",
                              "flex-direction": "column",
                              gap: "4px",
                              padding: "10px 12px",
                              border: isBlocked ? "1px solid var(--warnb)" : "1px solid transparent",
                              "border-radius": "10px",
                              background: isBlocked ? "var(--warns)" : "transparent",
                              color: "var(--fg)",
                              "text-align": "left",
                              cursor: "pointer",
                            }}
                          >
                            <span style={{ display: "flex", "align-items": "center", gap: "8px", width: "100%" }}>
                              <span
                                style={{
                                  width: "8px",
                                  height: "8px",
                                  "border-radius": "4px",
                                  background: isBlocked ? "var(--warn)" : a.status === "working" ? "var(--accent)" : "var(--faint)",
                                }}
                              />
                              <span style={{ flex: 1, "font-size": "14px", "font-weight": 600 }}>
                                {a.name}
                              </span>
                              <span
                                style={{
                                  "font-size": "11px",
                                  "font-weight": isBlocked ? 600 : 400,
                                  color: isBlocked ? "var(--warnt)" : a.status === "working" ? "var(--accentt)" : "var(--muted)",
                                }}
                              >
                                {isBlocked ? "待确认" : a.status === "working" ? "工作中" : "就绪"}
                              </span>
                            </span>
                            <span
                              style={{
                                "font-size": "12px",
                                color: "var(--muted)",
                                "padding-left": "16px",
                                "white-space": "nowrap",
                                overflow: "hidden",
                                "text-overflow": "ellipsis",
                                width: "100%",
                                "box-sizing": "border-box",
                              }}
                            >
                              {a.summary || (isBlocked ? "等待确认授权" : a.status === "working" ? "正在执行任务" : "就绪")}
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>

        {/* Bottom Drawer Actions */}
        <div
          style={{
            "flex-shrink": 0,
            "border-top": "1px solid var(--line)",
            padding: "8px 8px 16px",
          }}
        >
          <button
            class="touch-target"
            onClick={openMacrosModal}
            style={{
              width: "100%",
              height: "48px",
              display: "flex",
              "align-items": "center",
              gap: "12px",
              padding: "0 12px",
              border: 0,
              "border-radius": "10px",
              background: "transparent",
              color: "var(--fg)",
              "font-size": "14px",
              "text-align": "left",
              cursor: "pointer",
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
              <circle cx="15" cy="6" r="2" />
              <circle cx="9" cy="12" r="2" />
              <circle cx="17" cy="18" r="2" />
            </svg>
            快捷操作栏
          </button>

          <button
            class="touch-target"
            onClick={openAppearanceModal}
            style={{
              width: "100%",
              height: "48px",
              display: "flex",
              "align-items": "center",
              gap: "12px",
              padding: "0 12px",
              border: 0,
              "border-radius": "10px",
              background: "transparent",
              color: "var(--fg)",
              "font-size": "14px",
              "text-align": "left",
              cursor: "pointer",
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
            外观
          </button>

          <button
            class="touch-target"
            onClick={openPairingModal}
            style={{
              width: "100%",
              height: "48px",
              display: "flex",
              "align-items": "center",
              gap: "12px",
              padding: "0 12px",
              border: 0,
              "border-radius": "10px",
              background: "transparent",
              color: "var(--fg)",
              "font-size": "14px",
              "text-align": "left",
              cursor: "pointer",
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
            </svg>
            连接与配对
          </button>
        </div>
      </aside>
    </Show>
  );
};
