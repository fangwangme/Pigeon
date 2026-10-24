import { Component, For, Show } from "solid-js";
import {
  state,
  setState,
  closeActiveAgentsModal,
  openNewTabModal,
} from "../state/store";
import { selectPane } from "../state/ws";
import type { WorkingAgentSummary } from "../../../types/protocol";

interface WorkspaceAgentGroup {
  workspaceId: string;
  workspaceLabel: string;
  hasBlocked: boolean;
  hasWorking: boolean;
  agents: WorkingAgentSummary[];
}

export const ActiveAgentsModal: Component = () => {
  const blockedAgents = () => state.workingAgents.filter((a) => a.status === "blocked");
  const workingAgents = () => state.workingAgents.filter((a) => a.status === "working");

  const handleSelectAgent = (agent: { workspaceId: string; tabId: string; paneId: string }) => {
    setState("activeWorkspaceId", agent.workspaceId);
    setState("activeTabId", agent.tabId);
    selectPane(agent.paneId, agent.workspaceId, agent.tabId);
    closeActiveAgentsModal();
  };

  const groupedWorkspaces = () => {
    const map = new Map<string, WorkspaceAgentGroup>();

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

    // Sort agents in each workspace: blocked first, working next, idle/done after
    for (const group of map.values()) {
      group.agents.sort((a, b) => statusPriority(a.status) - statusPriority(b.status));
    }

    // Sort workspace groups: those with blocked/working agents float to the top
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
          "max-height": "80vh",
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
              {blockedAgents().length} 待确认 · {workingAgents().length} 工作中 · 按工作区聚合
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

        {/* Agent list grouped by workspace */}
        <div
          style={{
            flex: 1,
            "min-height": 0,
            "overflow-y": "auto",
            padding: "12px 16px 24px",
            display: "flex",
            "flex-direction": "column",
            gap: "16px",
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
            <For each={groupedWorkspaces()}>
              {(group) => (
                <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                  {/* Workspace Group Header */}
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "6px",
                      padding: "4px 8px",
                      "font-size": "12px",
                      "font-weight": 700,
                      color: "var(--muted)",
                      "letter-spacing": "0.02em",
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
                    >
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <span style={{ flex: 1 }}>{group.workspaceLabel}</span>
                    <Show when={group.hasBlocked}>
                      <span
                        style={{
                          "font-size": "11px",
                          "font-weight": 600,
                          padding: "1px 6px",
                          "border-radius": "4px",
                          background: "var(--warnbg)",
                          color: "var(--warnt)",
                        }}
                      >
                        待确认
                      </span>
                    </Show>
                    <Show when={group.hasWorking}>
                      <span
                        style={{
                          "font-size": "11px",
                          "font-weight": 600,
                          padding: "1px 6px",
                          "border-radius": "4px",
                          background: "var(--accentbg)",
                          color: "var(--accentt)",
                        }}
                      >
                        运行中
                      </span>
                    </Show>
                  </div>

                  {/* Agents in this Workspace */}
                  <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                    <For each={group.agents}>
                      {(a) => {
                        const isBlocked = a.status === "blocked";
                        const isWorking = a.status === "working";
                        return (
                          <button
                            class="touch-target"
                            onClick={() => handleSelectAgent(a)}
                            style={{
                              display: "flex",
                              "flex-direction": "column",
                              gap: "6px",
                              padding: "12px 14px",
                              border: isBlocked
                                ? "1.5px solid var(--warnb)"
                                : isWorking
                                ? "1.5px solid var(--accentl)"
                                : "1px solid var(--border)",
                              "border-radius": "12px",
                              background: isBlocked
                                ? "var(--warns)"
                                : isWorking
                                ? "var(--accents)"
                                : "var(--surface)",
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
                                  background: isBlocked
                                    ? "var(--warn)"
                                    : isWorking
                                    ? "var(--accent)"
                                    : "var(--faint)",
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
                                  background: isBlocked
                                    ? "var(--warnbg)"
                                    : isWorking
                                    ? "var(--accentbg)"
                                    : "var(--inset)",
                                  color: isBlocked
                                    ? "var(--warnt)"
                                    : isWorking
                                    ? "var(--accentt)"
                                    : "var(--muted)",
                                }}
                              >
                                {isBlocked ? "待确认" : isWorking ? "工作中" : "就绪"}
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
                              {a.summary || (isBlocked ? "需要确认授权" : isWorking ? "正在执行中" : "就绪")}
                            </div>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </section>
    </Show>
  );
};
