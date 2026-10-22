import { Component, Show } from "solid-js";
import { state, closeTerminalSheet } from "../state/store";

export const TerminalSheet: Component = () => {
  return (
    <Show when={state.terminalSheetOpen}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          "z-index": 90,
          display: "flex",
          "flex-direction": "column",
          "justify-content": "flex-end",
        }}
      >
        {/* Backdrop */}
        <div
          onClick={closeTerminalSheet}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0, 0, 0, 0.5)",
          }}
        />

        {/* Slide-up Container */}
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "65vh",
            background: "var(--color-bg)",
            "border-top": "2px solid var(--color-border)",
            display: "flex",
            "flex-direction": "column",
            "z-index": 91,
            "border-top-left-radius": "16px",
            "border-top-right-radius": "16px",
            overflow: "hidden",
            "box-shadow": "0 -4px 16px rgba(0,0,0,0.3)",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "10px 16px",
              background: "var(--color-surface)",
              "border-bottom": "1px solid var(--color-border)",
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
            }}
          >
            <div style={{ "font-size": "13px", "font-weight": "600", color: "var(--color-fg)" }}>
              Raw Terminal View ({state.activePaneId})
            </div>
            <button
              class="touch-target"
              onClick={closeTerminalSheet}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--color-faint)",
                "font-size": "16px",
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </div>

          {/* Raw Text Body */}
          <pre
            style={{
              flex: 1,
              margin: 0,
              padding: "12px",
              "overflow-y": "auto",
              "-webkit-overflow-scrolling": "touch",
              "font-family": "monospace",
              "font-size": "12px",
              "line-height": "1.4",
              color: "var(--color-fg)",
              background: "var(--color-bg)",
              "white-space": "pre-wrap",
              "word-break": "break-all",
            }}
          >
            {state.rawScreen || "Waiting for terminal output..."}
          </pre>
        </div>
      </div>
    </Show>
  );
};
