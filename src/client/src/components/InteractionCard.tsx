import { Component, For } from "solid-js";
import type { InteractionCardData } from "../../types/protocol";
import { respondInteraction, sendKeys } from "../state/ws";

export interface InteractionCardProps {
  interaction: InteractionCardData;
}

export const InteractionCard: Component<InteractionCardProps> = (props) => {
  const handleOption = (optId: string) => {
    respondInteraction(props.interaction.interactionId, optId, props.interaction.fingerprint);
  };

  const handleKey = (key: string) => {
    sendKeys([key]);
  };

  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "2px solid var(--color-warning)",
        "border-radius": "12px",
        padding: "16px",
        margin: "12px 0",
        "box-shadow": "0 4px 12px rgba(0,0,0,0.15)",
      }}
    >
      {/* Title */}
      <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "8px" }}>
        <span style={{ color: "var(--color-warning)", "font-size": "18px" }}>⚡</span>
        <span style={{ "font-size": "14px", "font-weight": "700", color: "var(--color-fg)" }}>
          {props.interaction.title || "Agent Needs Action"}
        </span>
      </div>

      {/* Question */}
      <div
        style={{
          "font-size": "15px",
          "font-weight": "600",
          color: "var(--color-fg)",
          "margin-bottom": "8px",
          "line-height": "1.4",
        }}
      >
        {props.interaction.question}
      </div>

      {/* Payload */}
      {props.interaction.payload && (
        <pre
          style={{
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            padding: "8px 12px",
            "border-radius": "6px",
            "font-size": "12px",
            "font-family": "monospace",
            color: "var(--color-fg)",
            "white-space": "pre-wrap",
            "word-break": "break-all",
            "margin-bottom": "12px",
            "max-height": "120px",
            overflow: "y-auto",
          }}
        >
          {props.interaction.payload}
        </pre>
      )}

      {/* Options grid */}
      <div style={{ display: "flex", "flex-direction": "column", gap: "8px", "margin-bottom": "12px" }}>
        <For each={props.interaction.options}>
          {(opt, idx) => {
            const isDanger = opt.id === "opt_no" || opt.label.toLowerCase().includes("no") || opt.label.toLowerCase().includes("reject");
            const isSuccess = opt.id === "opt_yes" || opt.label.toLowerCase().includes("yes") || opt.label.toLowerCase().includes("approve");

            return (
              <button
                class="touch-target"
                onClick={() => handleOption(opt.id)}
                style={{
                  background: isSuccess
                    ? "var(--color-success)"
                    : isDanger
                    ? "var(--color-danger)"
                    : "var(--color-accent)",
                  color: "#ffffff",
                  border: "none",
                  "border-radius": "8px",
                  padding: "10px 16px",
                  "font-size": "14px",
                  "font-weight": "600",
                  cursor: "pointer",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  width: "100%",
                }}
              >
                <span>{opt.label}</span>
                {opt.keyShortcut && (
                  <span
                    style={{
                      background: "rgba(0,0,0,0.2)",
                      padding: "2px 6px",
                      "border-radius": "4px",
                      "font-size": "11px",
                    }}
                  >
                    [{opt.keyShortcut}]
                  </span>
                )}
              </button>
            );
          }}
        </For>
      </div>

      {/* Fallback directional keypad */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          gap: "8px",
          "border-top": "1px solid var(--color-border)",
          "padding-top": "10px",
        }}
      >
        <button
          class="touch-target"
          onClick={() => handleKey("Up")}
          style={{
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            color: "var(--color-fg)",
            "border-radius": "6px",
            padding: "0 12px",
            height: "36px",
            cursor: "pointer",
            "font-weight": "600",
          }}
        >
          ↑ Up
        </button>
        <button
          class="touch-target"
          onClick={() => handleKey("Down")}
          style={{
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            color: "var(--color-fg)",
            "border-radius": "6px",
            padding: "0 12px",
            height: "36px",
            cursor: "pointer",
            "font-weight": "600",
          }}
        >
          ↓ Down
        </button>
        <button
          class="touch-target"
          onClick={() => handleKey("Enter")}
          style={{
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            color: "var(--color-fg)",
            "border-radius": "6px",
            padding: "0 12px",
            height: "36px",
            cursor: "pointer",
            "font-weight": "600",
          }}
        >
          ↵ Enter
        </button>
        <button
          class="touch-target"
          onClick={() => handleKey("Escape")}
          style={{
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            color: "var(--color-fg)",
            "border-radius": "6px",
            padding: "0 12px",
            height: "36px",
            cursor: "pointer",
            "font-weight": "600",
          }}
        >
          Esc
        </button>
      </div>
    </div>
  );
};
