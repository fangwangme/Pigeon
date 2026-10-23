import { Component, For, Show } from "solid-js";
import {
  state,
  setState,
  closeActiveAgentsModal,
  openNewTabModal,
} from "../state/store";
import { selectPane } from "../state/ws";

export const ActiveAgentsModal: Component = () => {
  const blockedAgents = () => state.workingAgents.filter((a) => a.status === "blocked");
  const workingAgents = () => state.workingAgents.filter((a) => a.status === "working");

  const handleSelectAgent = (agent: { workspaceId: string; tabId: string; paneId: string }) => {
    setState("activeWorkspaceId", agent.workspaceId);
    setState("activeTabId", agent.tabId);
    selectPane(agent.paneId, agent.workspaceId, agent.tabId);
    closeActiveAgentsModal();
  };

  return (
    <Show when={state.activeAgentsModalOpen}>
      <div
        aria-hidden="true"
        onClick={closeActiveAgentsModal}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--scrim)",
          "z-index": 55,
        }}
      />

      <section
        aria-label="活动中的 Agent"
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          "max-height": "75vh",
          "box-sizing": "border-box",
          background: "var(--sheet)",
          "border-top": "1px solid var(--border)",
          "border-radius": "20px 20px 0 0",
          display: "flex",
          "flex-direction": "column",
          "z-index": 60,
          color: "var(--fg)",
        }}
      >
        {/* Handle bar */}
        <div style={{ display: "flex", "justify-content": "center", "padding-top": "8px" }}>
          <div style={{ width: "40px", height: "4px", "border-radius": "2px", background: "var(--border2)" }} />
        </div>

        {/* Title row */}
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "8px",
            padding: "8px 12px 8px 20px",
            "border-bottom": "1px solid var(--line)",
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ "font-size": "18px", "font-weight": 700 }}>活动中的 Agent</div>
            <div style={{ "font-size": "12px", color: "var(--muted)", "margin-top": "2px" }}>
              {blockedAgents().length} 待确认 · {workingAgents().length} 工作中
            </div>
          </div>
          <button
            aria-label="关闭"
            class="touch-target"
            onClick={closeActiveAgentsModal}
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

        {/* Agent list */}
        <div
          style={{
            flex: 1,
            "min-height": 0,
            "overflow-y": "auto",
            padding: "12px 16px 24px",
            display: "flex",
            "flex-direction": "column",
            gap: "8px",
          }}
        >
          <Show
            when={state.workingAgents.length > 0}
            fallback={
              <div
                style={{
                  padding: "32px 16px",
                  "text-align": "center",
                  display: "flex",
                  "flex-direction": "column",
                  "align-items": "center",
                  gap: "12px",
                }}
              >
                <div style={{ "font-size": "14px", color: "var(--muted)" }}>
                  当前没有在运行或等待确认的 Agent
                </div>
                <button
                  class="touch-target"
                  onClick={() => {
                    closeActiveAgentsModal();
                    openNewTabModal();
                  }}
                  style={{
                    height: "44px",
                    padding: "0 16px",
                    "border-radius": "10px",
                    border: 0,
                    background: "var(--accent)",
                    color: "var(--onaccent)",
                    "font-size": "14px",
                    "font-weight": 600,
                    cursor: "pointer",
                  }}
                >
                  新建 Tab 启动 Agent
                </button>
              </div>
            }
          >
            <For each={state.workingAgents}>
              {(a) => {
                const isBlocked = a.status === "blocked";
                return (
                  <button
                    class="touch-target"
                    onClick={() => handleSelectAgent(a)}
                    style={{
                      display: "flex",
                      "flex-direction": "column",
                      gap: "6px",
                      padding: "12px 14px",
                      border: isBlocked ? "1.5px solid var(--warnb)" : "1px solid var(--border)",
                      "border-radius": "12px",
                      background: isBlocked ? "var(--warns)" : "var(--surface)",
                      color: "var(--fg)",
                      "text-align": "left",
                      cursor: "pointer",
                      width: "100%",
                      "box-sizing": "border-box",
                    }}
                  >
                    <div style={{ display: "flex", "align-items": "center", gap: "8px", width: "100%" }}>
                      <span
                        style={{
                          width: "8px",
                          height: "8px",
                          "border-radius": "4px",
                          background: isBlocked ? "var(--warn)" : "var(--accent)",
                        }}
                      />
                      <span style={{ flex: 1, "font-size": "15px", "font-weight": 600 }}>
                        {a.name}
                      </span>
                      <span
                        style={{
                          "font-size": "12px",
                          "font-weight": 600,
                          padding: "2px 8px",
                          "border-radius": "6px",
                          background: isBlocked ? "var(--warnbg)" : "var(--accentbg)",
                          color: isBlocked ? "var(--warnt)" : "var(--accentt)",
                        }}
                      >
                        {isBlocked ? "待确认" : "工作中"}
                      </span>
                    </div>

                    <div
                      style={{
                        "font-size": "13px",
                        color: "var(--muted)",
                        "padding-left": "16px",
                        "white-space": "nowrap",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        width: "100%",
                        "box-sizing": "border-box",
                      }}
                    >
                      {a.workspaceLabel} · {a.summary || (isBlocked ? "需要确认授权" : "正在执行中")}
                    </div>
                  </button>
                );
              }}
            </For>
          </Show>
        </div>
      </section>
    </Show>
  );
};
