import { Component, For, Show } from "solid-js";
import type { InteractionCardData } from "../../../types/protocol";
import { respondInteraction, sendKeys } from "../state/ws";
import { toggleTerminalSheet } from "../state/store";

const KEY_LABELS: Record<string, string> = { enter: "Enter", esc: "Esc", up: "↑", down: "↓", y: "y", n: "n", tab: "Tab" };

export const InteractionCard: Component<{ data: InteractionCardData }> = (props) => {
  const item = () => props.data;

  const handleSelect = (optionId: string) => {
    respondInteraction(item().interactionId, optionId, item().fingerprint);
  };

  const handleKey = (key: string) => {
    sendKeys([key]);
  };

  return (
    <section
      aria-label="Agent 请求授权"
      style={{
        border: "1.5px solid var(--warn)",
        background: "var(--warns)",
        "border-radius": "14px",
        padding: "14px",
        display: "flex",
        "flex-direction": "column",
        gap: "12px",
        "margin-top": "8px",
        color: "var(--fg)",
      }}
    >
      {/* Top Banner */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "8px",
          color: "var(--warnt)",
          "font-size": "12px",
          "font-weight": 600,
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
        </svg>
        <span style={{ flex: 1 }}>{item().title || "需要授权 · 交互确认"}</span>
        <span style={{ "font-weight": 500, color: "var(--muted)" }}>等待回应</span>
      </div>

      {/* Question */}
      <div style={{ "font-size": "16px", "font-weight": 600, "line-height": 1.4 }}>
        {item().question}
      </div>

      {/* Command/Payload Preview */}
      <Show when={item().payload}>
        <div
          style={{
            background: "var(--code)",
            border: "1px solid var(--warnl)",
            "border-radius": "8px",
            padding: "10px 12px",
            "font-family": "'JetBrains Mono', ui-monospace, monospace",
            "font-size": "13px",
            color: "var(--fg)",
            "word-break": "break-all",
            "white-space": "pre-wrap",
          }}
        >
          {item().payload}
        </div>
      </Show>

      {/* Numbered choices: tapping sends exactly that digit */}
      <div style={{ display: item().options.length > 0 ? "flex" : "none", "flex-direction": "column", gap: "8px" }}>
        <For each={item().options}>
          {(opt, idx) => {
            const isPrimary = idx() === 0;
            return (
              <button
                class="touch-target"
                onClick={() => handleSelect(opt.id)}
                style={{
                  "min-height": "52px",
                  display: "flex",
                  "align-items": "center",
                  gap: "10px",
                  padding: "0 14px",
                  border: isPrimary ? 0 : "1px solid var(--warnl)",
                  "border-radius": "12px",
                  background: isPrimary ? "var(--warn)" : "transparent",
                  color: isPrimary ? "var(--onwarn)" : "var(--fg)",
                  "font-size": "15px",
                  "font-weight": isPrimary ? 600 : 500,
                  "text-align": "left",
                  cursor: "pointer",
                }}
              >
                <span style={{ flex: 1 }}>{opt.label}</span>
                <span
                  style={{
                    "font-size": "11px",
                    "font-weight": 500,
                    color: isPrimary ? "inherit" : "var(--faint)",
                  }}
                >
                  {opt.keyShortcut}
                </span>
              </button>
            );
          }}
        </For>
      </div>

      {/* Raw key pad: the only controls when the prompt has no numbered options */}
      <Show when={item().options.length > 0}>
        <div style={{ height: "1px", background: "var(--warnl)" }} />
      </Show>
      <div style={{ display: "flex", "align-items": "center", gap: "6px", "flex-wrap": "wrap" }}>
        <span style={{ flex: "1 1 100%", "font-size": "12px", color: "var(--muted)" }}>
          {item().options.length > 0 ? "识别不准？直接发按键" : "看着上面的画面，用按键操作"}
        </span>
        <For each={item().fallbackKeys}>
          {(key) => (
            <button
              class="touch-target"
              aria-label={KEY_LABELS[key] || key}
              onClick={() => handleKey(key)}
              style={{
                "min-width": "48px",
                height: "44px",
                padding: "0 10px",
                "border-radius": "10px",
                border: "1px solid var(--warnl)",
                background: "var(--warnk)",
                color: "var(--fg)",
                "font-size": "13px",
                "font-weight": 500,
                cursor: "pointer",
              }}
            >
              {KEY_LABELS[key] || key}
            </button>
          )}
        </For>
      </div>

      {/* Terminal View Button */}
      <button
        class="touch-target"
        onClick={toggleTerminalSheet}
        style={{
          "align-self": "flex-start",
          height: "32px",
          padding: 0,
          border: 0,
          background: "transparent",
          color: "var(--accentt)",
          "font-size": "13px",
          display: "flex",
          "align-items": "center",
          gap: "6px",
          cursor: "pointer",
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
          <path d="M5 8l4 4-4 4M12 16h7" />
        </svg>
        查看原始终端画面
      </button>
    </section>
  );
};
