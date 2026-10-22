import { Component, For, Show } from "solid-js";
import { state, setState, closeDrawer } from "../state/store";
import { selectPane, createTab } from "../state/ws";

export const Drawer: Component = () => {
  const handleSelectTab = (wsId: string, tabId: string, paneId?: string) => {
    setState({
      activeWorkspaceId: wsId,
      activeTabId: tabId,
    });
    if (paneId) {
      selectPane(paneId);
    }
    closeDrawer();
  };

  const handleNewTab = (workspaceId: string) => {
    const kind = prompt("Launch Agent (claude, codex, pi, opencode):", "claude");
    if (kind) {
      createTab(workspaceId, kind.trim());
      closeDrawer();
    }
  };

  return (
    <Show when={state.drawerOpen}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          "z-index": 100,
          display: "flex",
        }}
      >
        {/* Backdrop */}
        <div
          onClick={closeDrawer}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0, 0, 0, 0.6)",
            "backdrop-filter": "blur(2px)",
          }}
        />

        {/* Drawer Content */}
        <div
          style={{
            position: "relative",
            width: "280px",
            height: "100%",
            background: "var(--color-surface)",
            "border-right": "1px solid var(--color-border)",
            display: "flex",
            "flex-direction": "column",
            "z-index": 101,
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "16px",
              "border-bottom": "1px solid var(--color-border)",
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
            }}
          >
            <div style={{ "font-size": "16px", "font-weight": "700", color: "var(--color-fg)" }}>
              Workspaces & Tabs
            </div>
            <button
              class="touch-target"
              onClick={closeDrawer}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--color-faint)",
                "font-size": "18px",
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </div>

          {/* List of Workspaces */}
          <div style={{ flex: 1, "overflow-y": "auto", padding: "12px" }}>
            <For each={state.workspaces}>
              {(ws) => (
                <div style={{ "margin-bottom": "16px" }}>
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "space-between",
                      "font-size": "12px",
                      "font-weight": "600",
                      color: "var(--color-faint)",
                      "text-transform": "uppercase",
                      "margin-bottom": "6px",
                    }}
                  >
                    <span>{ws.label}</span>
                    <button
                      onClick={() => handleNewTab(ws.id)}
                      title="New Tab in this Workspace"
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--color-accent)",
                        cursor: "pointer",
                        "font-size": "14px",
                        padding: "0 4px",
                      }}
                    >
                      + Tab
                    </button>
                  </div>

                  {/* Tabs in workspace */}
                  <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                    <For each={ws.tabs}>
                      {(t) => {
                        const isCurrentTab = () => state.activeTabId === t.id;
                        const primaryPane = t.panes[0];

                        return (
                          <div
                            onClick={() => handleSelectTab(ws.id, t.id, primaryPane?.id)}
                            class="touch-target"
                            style={{
                              padding: "8px 12px",
                              "border-radius": "8px",
                              cursor: "pointer",
                              background: isCurrentTab() ? "var(--color-bg)" : "transparent",
                              border: isCurrentTab()
                                ? "1px solid var(--color-border)"
                                : "1px solid transparent",
                              display: "flex",
                              "align-items": "center",
                              "justify-content": "space-between",
                              width: "100%",
                            }}
                          >
                            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                              <span
                                style={{
                                  width: "8px",
                                  height: "8px",
                                  "border-radius": "50%",
                                  background:
                                    primaryPane?.agentStatus === "blocked"
                                      ? "var(--color-danger)"
                                      : primaryPane?.agentStatus === "working"
                                      ? "var(--color-warning)"
                                      : "var(--color-success)",
                                }}
                              />
                              <span
                                style={{
                                  "font-size": "14px",
                                  color: isCurrentTab() ? "var(--color-accent)" : "var(--color-fg)",
                                  "font-weight": isCurrentTab() ? "600" : "400",
                                }}
                              >
                                {t.label}
                              </span>
                            </div>

                            <Show when={t.panes.length > 1}>
                              <span
                                style={{
                                  "font-size": "10px",
                                  padding: "2px 6px",
                                  "border-radius": "10px",
                                  background: "var(--color-border)",
                                  color: "var(--color-faint)",
                                }}
                              >
                                {t.panes.length} panes
                              </span>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
};
