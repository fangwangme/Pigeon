import { Component, For, Show } from "solid-js";
import {
  state,
  setState,
  toggleDrawer,
  getActiveWorkspace,
  getActiveTab,
  getSubPanes,
  getBlockedAgentsCount,
  openNewTabModal,
} from "../state/store";
import { selectPane } from "../state/ws";

export const Header: Component = () => {
  const ws = getActiveWorkspace;
  const tab = getActiveTab;
  const subPanes = getSubPanes;

  const jumpToBlockedAgent = () => {
    const blockedAgent = state.workingAgents.find((a) => a.status === "blocked");
    if (blockedAgent) {
      setState("activeWorkspaceId", blockedAgent.workspaceId);
      setState("activeTabId", blockedAgent.tabId);
      selectPane(blockedAgent.paneId);
    }
  };

  const getStatusDotColor = (status?: string) => {
    if (status === "blocked") return "var(--warn)";
    if (status === "working") return "var(--accent)";
    return "var(--faint)";
  };

  return (
    <>
      <header
        style={{
          height: "56px",
          "flex-shrink": 0,
          display: "flex",
          "align-items": "center",
          gap: "4px",
          padding: "0 12px 0 4px",
          "border-bottom": "1px solid var(--line)",
          background: "var(--bg)",
          color: "var(--fg)",
        }}
      >
        <button
          aria-label="打开抽屉"
          class="touch-target"
          onClick={toggleDrawer}
          style={{
            width: "44px",
            height: "44px",
            border: 0,
            background: "transparent",
            color: "var(--fg)",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "border-radius": "10px",
            cursor: "pointer",
          }}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>

        <div style={{ flex: 1, "min-width": 0, display: "flex", "flex-direction": "column", gap: "2px" }}>
          <div style={{ "font-size": "16px", "font-weight": 600 }}>{ws()?.label || "Pigeon"}</div>
          <div
            style={{
              "font-size": "12px",
              color: "var(--muted)",
              display: "flex",
              "align-items": "center",
              gap: "6px",
            }}
          >
            <span
              style={{
                width: "6px",
                height: "6px",
                "border-radius": "3px",
                background: state.connected ? "var(--accent)" : "var(--warn)",
              }}
            />
            {state.serverHost} · {state.connected ? "已连接" : "连接中..."}
          </div>
        </div>

        <Show when={getBlockedAgentsCount() > 0}>
          <button
            aria-label={`${getBlockedAgentsCount()} 个 Agent 等待确认，点击跳转`}
            class="touch-target"
            onClick={jumpToBlockedAgent}
            style={{
              height: "32px",
              padding: "0 12px",
              "border-radius": "16px",
              border: "1px solid var(--warnb)",
              background: "var(--warnbg)",
              color: "var(--warnt)",
              "font-size": "12px",
              "font-weight": 600,
              display: "flex",
              "align-items": "center",
              gap: "6px",
              cursor: "pointer",
            }}
          >
            <span
              style={{
                width: "6px",
                height: "6px",
                "border-radius": "3px",
                background: "var(--warn)",
              }}
            />
            {getBlockedAgentsCount()} 待确认
          </button>
        </Show>
      </header>

      {/* Tabs bar */}
      <nav
        aria-label="当前工作区的 Tab"
        style={{
          height: "52px",
          "flex-shrink": 0,
          display: "flex",
          "align-items": "center",
          gap: "8px",
          padding: "0 12px",
          "border-bottom": "1px solid var(--line)",
          "overflow-x": "auto",
          "scrollbar-width": "none",
        }}
      >
        <For each={ws()?.tabs || []}>
          {(t) => {
            const isTabActive = () => (state.activeTabId ? t.id === state.activeTabId : false);
            const hasBlocked = () => t.panes?.some((p) => p.agentStatus === "blocked");
            const hasWorking = () => t.panes?.some((p) => p.agentStatus === "working");

            const tabDotColor = () => {
              if (hasBlocked()) return "var(--warn)";
              if (hasWorking()) return "var(--accent)";
              return "var(--faint)";
            };

            return (
              <button
                class="touch-target"
                onClick={() => {
                  setState("activeTabId", t.id);
                  if (t.panes?.[0]?.id) {
                    selectPane(t.panes[0].id);
                  }
                }}
                style={{
                  height: "36px",
                  padding: "0 12px",
                  "border-radius": "8px",
                  border: isTabActive()
                    ? hasBlocked()
                      ? "1px solid var(--warnb)"
                      : "1px solid var(--selb)"
                    : "1px solid transparent",
                  background: isTabActive()
                    ? hasBlocked()
                      ? "var(--warnbg)"
                      : "var(--sel)"
                    : "transparent",
                  color: isTabActive() ? "var(--fg)" : "var(--muted)",
                  "font-size": "13px",
                  "font-weight": isTabActive() ? 600 : 500,
                  display: "flex",
                  "align-items": "center",
                  gap: "6px",
                  "white-space": "nowrap",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    width: "7px",
                    height: "7px",
                    "border-radius": "4px",
                    background: tabDotColor(),
                  }}
                />
                {t.label}
              </button>
            );
          }}
        </For>

        <button
          aria-label="新建 Tab"
          class="touch-target"
          onClick={openNewTabModal}
          style={{
            width: "36px",
            height: "36px",
            "flex-shrink": 0,
            "border-radius": "8px",
            border: "1px dashed var(--border2)",
            background: "transparent",
            color: "var(--muted)",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            cursor: "pointer",
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </nav>

      {/* Sub-pane chips if split panes in current tab */}
      <Show when={subPanes().length > 1}>
        <div
          style={{
            height: "40px",
            "flex-shrink": 0,
            display: "flex",
            "align-items": "center",
            gap: "6px",
            padding: "0 12px",
            background: "var(--inset)",
            "border-bottom": "1px solid var(--line)",
            "overflow-x": "auto",
          }}
        >
          <For each={subPanes()}>
            {(p) => {
              const isSelected = () => state.activePaneId === p.id;
              return (
                <button
                  class="touch-target"
                  onClick={() => selectPane(p.id)}
                  style={{
                    height: "28px",
                    padding: "0 10px",
                    "border-radius": "14px",
                    border: isSelected() ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: isSelected() ? "var(--accentbg)" : "var(--surface)",
                    color: isSelected() ? "var(--accent)" : "var(--muted)",
                    "font-size": "12px",
                    "font-weight": isSelected() ? 600 : 500,
                    display: "flex",
                    "align-items": "center",
                    gap: "5px",
                    cursor: "pointer",
                    "white-space": "nowrap",
                  }}
                >
                  <span
                    style={{
                      width: "6px",
                      height: "6px",
                      "border-radius": "3px",
                      background: getStatusDotColor(p.agentStatus),
                    }}
                  />
                  {p.name || p.id}
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </>
  );
};
