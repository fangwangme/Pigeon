import { Component, For, Show } from "solid-js";
import {
  state,
  toggleDrawer,
  toggleTerminalSheet,
  getActiveWorkspace,
  getActiveTab,
  getSubPanes,
  setTheme,
} from "../state/store";
import { selectPane } from "../state/ws";
import { THEMES } from "../themes";

export const Header: Component = () => {
  const ws = getActiveWorkspace;
  const tab = getActiveTab;
  const subPanes = getSubPanes;

  const cycleTheme = () => {
    const keys = Object.keys(THEMES);
    const currIdx = keys.indexOf(state.themeId);
    const nextIdx = (currIdx + 1) % keys.length;
    setTheme(keys[nextIdx]);
  };

  return (
    <header
      style={{
        background: "var(--color-surface)",
        "border-bottom": "1px solid var(--color-border)",
        display: "flex",
        "flex-direction": "column",
        "flex-shrink": 0,
      }}
    >
      {/* Top Navbar */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          height: "48px",
          padding: "0 8px",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          {/* Drawer Hamburger */}
          <button
            class="touch-target"
            onClick={toggleDrawer}
            title="Open Drawer"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--color-fg)",
              cursor: "pointer",
              "font-size": "20px",
              padding: "0 8px",
            }}
          >
            ☰
          </button>

          {/* Title */}
          <div style={{ "line-height": "1.2" }}>
            <div style={{ "font-size": "14px", "font-weight": "600", color: "var(--color-fg)" }}>
              {ws()?.label || "Pigeon"}
            </div>
            <div style={{ "font-size": "11px", color: "var(--color-faint)" }}>
              {tab()?.label || "tab"} · {state.agentStatus}
            </div>
          </div>
        </div>

        {/* Action icons */}
        <div style={{ display: "flex", "align-items": "center", gap: "4px" }}>
          {/* Theme switcher */}
          <button
            class="touch-target"
            onClick={cycleTheme}
            title={`Current Theme: ${state.themeId}`}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--color-faint)",
              cursor: "pointer",
              "font-size": "16px",
            }}
          >
            🎨
          </button>

          {/* Raw Terminal Sheet Toggle */}
          <button
            class="touch-target"
            onClick={toggleTerminalSheet}
            title="Toggle Raw Terminal Screen"
            style={{
              background: state.terminalSheetOpen ? "var(--color-accent)" : "transparent",
              border: "1px solid var(--color-border)",
              "border-radius": "6px",
              color: state.terminalSheetOpen ? "#fff" : "var(--color-fg)",
              cursor: "pointer",
              "font-size": "12px",
              "font-family": "monospace",
              padding: "4px 8px",
              height: "32px",
            }}
          >
            &gt;_
          </button>
        </div>
      </div>

      {/* Sub-pane Pill Chips: rendered when a tab has multiple split panes */}
      <Show when={subPanes().length > 1}>
        <div
          style={{
            display: "flex",
            gap: "6px",
            padding: "4px 8px 8px 8px",
            overflow: "x-auto",
            "-webkit-overflow-scrolling": "touch",
          }}
        >
          <For each={subPanes()}>
            {(pane) => {
              const isSelected = () => state.activePaneId === pane.id;
              return (
                <button
                  class="touch-target"
                  onClick={() => selectPane(pane.id)}
                  style={{
                    background: isSelected() ? "var(--color-accent)" : "var(--color-bg)",
                    color: isSelected() ? "#ffffff" : "var(--color-fg)",
                    border: `1px solid ${isSelected() ? "var(--color-accent)" : "var(--color-border)"}`,
                    "border-radius": "16px",
                    padding: "0 12px",
                    "font-size": "12px",
                    "font-weight": "500",
                    cursor: "pointer",
                    height: "32px",
                    display: "flex",
                    "align-items": "center",
                    gap: "6px",
                    "white-space": "nowrap",
                  }}
                >
                  <span
                    style={{
                      width: "6px",
                      height: "6px",
                      "border-radius": "50%",
                      background:
                        pane.agentStatus === "blocked"
                          ? "var(--color-danger)"
                          : pane.agentStatus === "working"
                          ? "var(--color-warning)"
                          : "var(--color-success)",
                    }}
                  />
                  <span>{pane.name || pane.agent || pane.id}</span>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </header>
  );
};
