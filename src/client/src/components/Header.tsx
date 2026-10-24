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
  openActiveAgentsModal,
  toggleDiffDrawer,
  openCloseTabConfirm,
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

  // Herdr pane names are often raw ids like "wJ:p1"; show something human instead.
  const paneLabel = (p: { id: string; name?: string; agent?: string | null }) => {
    const rawName = p.name?.trim();
    if (rawName && !/^[A-Za-z0-9]+:p\d+$/.test(rawName)) return rawName;
    return p.id.includes(":") ? p.id.split(":").pop()! : p.id;
  };

  const resolveTabLabel = (t: { id: string; label: string; panes?: any[] }, index?: () => number) => {
    const raw = (t.label || "").trim();
    if (raw && !/^\d+$/.test(raw) && !raw.startsWith("Tab ")) return raw;
    const p = t.panes?.[0];
    if (p) {
      if (p.agent === "opencode") return "OpenCode";
      if (p.agent === "agy") return "Antigravity";
      if (p.agent === "claude") return "Claude Code";
      if (p.name && !p.name.includes(":p")) return p.name;
    }
    const idx = index ? index() + 1 : 1;
    return `${idx}`;
  };

  return (
    <>
      <header
        style={{
          height: "52px",
          "flex-shrink": 0,
          display: "flex",
          "align-items": "center",
          gap: "2px",
          padding: "0 10px 0 2px",
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

        <div
          style={{
            flex: 1,
            "min-width": 0,
            display: "flex",
            "align-items": "baseline",
            gap: "8px",
            overflow: "hidden",
            "white-space": "nowrap",
          }}
        >
          <span
            style={{
              "font-size": "18px",
              "font-weight": 750,
              "letter-spacing": "-0.3px",
              color: "var(--fg)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
              "flex-shrink": 0,
            }}
          >
            {ws()?.label || "Pigeon"}
          </span>
          <div
            style={{
              "font-size": "11.5px",
              color: "var(--muted)",
              display: "flex",
              "align-items": "center",
              gap: "4px",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            <span
              style={{
                width: "6px",
                height: "6px",
                "border-radius": "3px",
                "flex-shrink": 0,
                background: state.connected ? "var(--accent)" : "var(--warn)",
              }}
            />
            <span style={{ overflow: "hidden", "text-overflow": "ellipsis" }}>
              {state.serverHost} · {state.connected ? "已连接" : "连接中..."}
            </span>
          </div>
        </div>

        {/* Quick Access to Active Agents and Session Diff */}
        <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
          <Show when={state.sessionStats && (state.sessionStats.filesModified > 0 || state.sessionStats.additions > 0 || state.sessionStats.deletions > 0)}>
            <button
              aria-label="查看代码变更 Diff"
              class="touch-target"
              onClick={toggleDiffDrawer}
              style={{
                height: "30px",
                padding: "0 8px",
                "border-radius": "15px",
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--fg)",
                "font-size": "11.5px",
                "font-weight": 600,
                display: "flex",
                "align-items": "center",
                gap: "4px",
                cursor: "pointer",
              }}
            >
              <span>📝</span>
              <span>{state.sessionStats!.filesModified}</span>
              <span style={{ color: "var(--addfg, #3fb950)" }}>+{state.sessionStats!.additions}</span>
              <span style={{ color: "var(--delfg, #f85149)" }}>-{state.sessionStats!.deletions}</span>
            </button>
          </Show>
          {/* Quick Access to Active Agents (Computer Icon + Working Count 0 - 99) */}
          {(() => {
            const blockedCount = () => getBlockedAgentsCount();
            const workingCount = () => state.workingAgents.filter((a) => a.status === "working").length;
            const hasBlocked = () => blockedCount() > 0;
            const count = () => (hasBlocked() ? blockedCount() : workingCount());
            const displayCount = () => (count() > 99 ? "99+" : `${count()}`);

            return (
              <button
                aria-label={`查看活动 Agent 列表 (${displayCount()} 运行中)`}
                title={`活动 Agent 列表: ${displayCount()} 运行中${hasBlocked() ? ` (${blockedCount()} 待确认)` : ""}`}
                class="touch-target"
                onClick={openActiveAgentsModal}
                style={{
                  height: "30px",
                  padding: "0 9px",
                  "border-radius": "15px",
                  border: hasBlocked()
                    ? "1px solid var(--warnb)"
                    : count() > 0
                    ? "1px solid var(--selb)"
                    : "1px solid var(--border)",
                  background: hasBlocked()
                    ? "var(--warnbg)"
                    : count() > 0
                    ? "var(--sel)"
                    : "var(--surface)",
                  color: hasBlocked()
                    ? "var(--warnt)"
                    : count() > 0
                    ? "var(--accent)"
                    : "var(--muted)",
                  "font-size": "12px",
                  "font-weight": 650,
                  "font-family": "'JetBrains Mono', monospace",
                  display: "flex",
                  "align-items": "center",
                  gap: "5px",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                  style={{ display: "block" }}
                >
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
                <span>{displayCount()}</span>
              </button>
            );
          })()}
        </div>
      </header>

      {/* Tabs bar */}
      <nav
        aria-label="当前工作区的 Tab"
        style={{
          height: "46px",
          "flex-shrink": 0,
          display: "flex",
          "align-items": "center",
          gap: "4px",
          padding: "0 10px",
          "border-bottom": "1px solid var(--line)",
          "overflow-x": "auto",
          "scrollbar-width": "none",
          "-webkit-overflow-scrolling": "touch",
        }}
      >
        <For each={ws()?.tabs || []}>
          {(t, i) => {
            const isTabActive = () => (state.activeTabId ? t.id === state.activeTabId : false);
            const hasBlocked = () => t.panes?.some((p) => p.agentStatus === "blocked");
            const hasWorking = () => t.panes?.some((p) => p.agentStatus === "working");

            const tabDotColor = () => {
              if (hasBlocked()) return "var(--warn)";
              if (hasWorking()) return "var(--accent)";
              return "var(--faint)";
            };

            return (
              <div style={{ display: "flex", "align-items": "center", gap: "4px", "flex-shrink": 0 }}>
                <Show when={i() > 0}>
                  <div style={{ width: "1px", height: "16px", background: "var(--line)", "flex-shrink": 0, margin: "0 2px" }} />
                </Show>
                <button
                  class="touch-target"
                  onClick={() => {
                    setState("activeTabId", t.id);
                    const targetPane =
                      t.panes?.find((p) => p.agentStatus === "working" || p.agentStatus === "blocked") ||
                      t.panes?.[0];
                    if (targetPane?.id) {
                      selectPane(targetPane.id, state.activeWorkspaceId || undefined, t.id);
                    }
                  }}
                  style={{
                    height: "34px",
                    padding: "0 11px",
                    "border-radius": "9px",
                    border: isTabActive()
                      ? hasBlocked()
                        ? "1.5px solid var(--warnb)"
                        : "1.5px solid var(--selb)"
                      : "1.5px solid transparent",
                    background: isTabActive()
                      ? hasBlocked()
                        ? "var(--warnbg)"
                        : "var(--sel)"
                      : "transparent",
                    color: isTabActive() ? "var(--fg)" : "var(--muted)",
                    "font-size": "12.5px",
                    "font-weight": isTabActive() ? 650 : 500,
                    display: "flex",
                    "align-items": "center",
                    gap: "5px",
                    "white-space": "nowrap",
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      width: "6px",
                      height: "6px",
                      "border-radius": "3px",
                      background: tabDotColor(),
                    }}
                  />
                  <span>{resolveTabLabel(t, i)}</span>
                  <Show when={isTabActive()}>
                    <span
                      role="button"
                      aria-label="关闭 Tab"
                      title="关闭 Tab"
                      onClick={(e) => {
                        e.stopPropagation();
                        openCloseTabConfirm(t.id, resolveTabLabel(t, i));
                      }}
                      style={{
                        display: "inline-flex",
                        "align-items": "center",
                        "justify-content": "center",
                        width: "16px",
                        height: "16px",
                        "border-radius": "50%",
                        "margin-left": "4px",
                        color: "var(--muted)",
                        "font-size": "11px",
                        "line-height": 1,
                      }}
                    >
                      ✕
                    </span>
                  </Show>
                </button>
              </div>
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
            "min-width": "36px",
            "min-height": "36px",
            "flex-shrink": 0,
            "border-radius": "9px",
            border: "1.5px solid var(--border)",
            background: "var(--surface)",
            color: "var(--fg)",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            cursor: "pointer",
            "box-shadow": "0 1px 3px rgba(0, 0, 0, 0.2)",
            "box-sizing": "border-box",
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

      {/* Sub-pane chips (Panel index row) if multiple panels in current tab */}
      <Show when={subPanes().length > 1}>
        <div
          style={{
            height: "40px",
            "flex-shrink": 0,
            display: "flex",
            "align-items": "center",
            gap: "4px",
            padding: "0 10px",
            background: "var(--bg)",
            "border-bottom": "1px solid var(--line)",
            "overflow-x": "auto",
            "scrollbar-width": "none",
            "-webkit-overflow-scrolling": "touch",
          }}
        >
          <For each={subPanes()}>
            {(p, i) => {
              const isSelected = () => state.activePaneId === p.id;
              return (
                <div style={{ display: "flex", "align-items": "center", gap: "4px", "flex-shrink": 0 }}>
                  <Show when={i() > 0}>
                    <div style={{ width: "1px", height: "16px", background: "var(--line)", "flex-shrink": 0, margin: "0 2px" }} />
                  </Show>
                  <button
                    class="touch-target"
                    onClick={() => selectPane(p.id)}
                    style={{
                      height: "28px",
                      padding: "0 11px",
                      "border-radius": "8px",
                      border: isSelected() ? "1.5px solid var(--accent)" : "1.5px solid var(--border)",
                      background: isSelected() ? "var(--sel)" : "var(--surface)",
                      color: isSelected() ? "var(--accent)" : "var(--muted)",
                      "font-size": "12px",
                      "font-weight": isSelected() ? 650 : 500,
                      display: "flex",
                      "align-items": "center",
                      gap: "5px",
                      cursor: "pointer",
                      "white-space": "nowrap",
                      "box-shadow": "0 1px 2px rgba(0, 0, 0, 0.12)",
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
                    {`Panel ${i() + 1}`}
                  </button>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </>
  );
};
