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
          "touch-action": "pan-y",
        }}
      >
        {/* Backdrop */}
        <div
          aria-hidden="true"
          onClick={closeTerminalSheet}
          style={{
            position: "absolute",
            inset: 0,
            background: "var(--scrim)",
          }}
        />

        {/* Slide-up Container */}
        <section
          aria-label="完整终端屏幕"
          style={{
            position: "relative",
            width: "100%",
            "max-width": "100vw",
            height: "75vh",
            background: "var(--bg)",
            "border-top": "2px solid var(--border)",
            display: "flex",
            "flex-direction": "column",
            "z-index": 91,
            "border-top-left-radius": "18px",
            "border-top-right-radius": "18px",
            overflow: "hidden",
            "box-shadow": "0 -6px 24px rgba(0, 0, 0, 0.35)",
            "box-sizing": "border-box",
            "touch-action": "pan-y",
            "overscroll-behavior-x": "none",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "12px 16px",
              background: "var(--surface)",
              "border-bottom": "1px solid var(--border)",
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
            }}
          >
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <div style={{ display: "flex", gap: "5px" }}>
                <span style={{ width: "9px", height: "9px", "border-radius": "5px", background: "#FF5F56" }} />
                <span style={{ width: "9px", height: "9px", "border-radius": "5px", background: "#FFBD2E" }} />
                <span style={{ width: "9px", height: "9px", "border-radius": "5px", background: "#27C93F" }} />
              </div>
              <span style={{ "font-size": "13px", "font-weight": "600", color: "var(--fg)", "font-family": "'JetBrains Mono', monospace" }}>
                终端视窗 ({state.activePaneId})
              </span>
            </div>
            <button
              aria-label="收起终端"
              class="touch-target"
              onClick={closeTerminalSheet}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--muted)",
                "font-size": "16px",
                cursor: "pointer",
                padding: "4px 8px",
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
              padding: "14px",
              "overflow-y": "auto",
              "overflow-x": "hidden",
              "-webkit-overflow-scrolling": "touch",
              "touch-action": "pan-y",
              "overscroll-behavior-x": "none",
              "font-family": "'JetBrains Mono', ui-monospace, monospace",
              "font-size": "12px",
              "line-height": 1.5,
              color: "var(--codefg)",
              background: "var(--code)",
              "white-space": "pre-wrap",
              "word-break": "break-word",
              "max-width": "100%",
              "box-sizing": "border-box",
            }}
          >
            {state.rawScreen || "等待终端输出..."}
          </pre>
        </section>
      </div>
    </Show>
  );
};
