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
            height: "82vh",
            "max-height": "calc(100dvh - 24px)",
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
              padding: "8px 12px 10px",
              background: "var(--surface)",
              "border-bottom": "1px solid var(--border)",
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
            }}
          >
            <div style={{ display: "flex", "align-items": "center", gap: "8px", "min-width": 0 }}>
              <span
                aria-hidden="true"
                style={{
                  width: "34px",
                  height: "4px",
                  "border-radius": "2px",
                  background: "var(--border2)",
                  position: "absolute",
                  left: "50%",
                  top: "6px",
                  transform: "translateX(-50%)",
                }}
              />
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ color: "var(--muted)" }}>
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <span style={{ "font-size": "13.5px", "font-weight": 600, color: "var(--fg)", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                终端输出
                <span style={{ color: "var(--faint)", "font-weight": 500, "margin-left": "6px", "font-family": "'JetBrains Mono', ui-monospace, monospace", "font-size": "11px" }}>
                  {state.activePaneId || "—"}
                </span>
              </span>
            </div>
            <button
              aria-label="收起终端"
              class="touch-target"
              onClick={closeTerminalSheet}
              style={{
                width: "32px",
                height: "32px",
                "border-radius": "9px",
                background: "var(--inset)",
                border: "1px solid var(--border)",
                color: "var(--muted)",
                "font-size": "15px",
                cursor: "pointer",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                "flex-shrink": 0,
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
              "padding-bottom": "calc(14px + env(safe-area-inset-bottom))",
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
