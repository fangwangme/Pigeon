import { Component, createSignal, Show } from "solid-js";
import { state } from "../state/store";
import { sendPrompt, sendKeys, respondInteraction } from "../state/ws";

export const MacroDock: Component = () => {
  const [inputText, setInputText] = createSignal("");
  const [isComposing, setIsComposing] = createSignal(false);
  const [ctrlCTapPending, setCtrlCTapPending] = createSignal(false);
  const [showKeypad, setShowKeypad] = createSignal(false);
  let ctrlCTimer: any = null;

  const handleCtrlC = () => {
    if (ctrlCTapPending()) {
      // Second tap within 800ms: dispatch Ctrl+C
      clearTimeout(ctrlCTimer);
      setCtrlCTapPending(false);
      sendKeys(["ctrl+c"]);
    } else {
      // First tap: set confirmation window for 800ms
      setCtrlCTapPending(true);
      ctrlCTimer = setTimeout(() => {
        setCtrlCTapPending(false);
      }, 800);
    }
  };

  const handleSend = () => {
    const text = inputText().trim();
    if (!text) return;
    sendPrompt(text);
    setInputText("");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    // Chinese/Japanese IME composition check
    if (isComposing() || e.isComposing) {
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleApprove = () => {
    if (state.pendingInteraction) {
      const opt = state.pendingInteraction.options.find(
        (o) => o.id === "opt_yes" || o.label.toLowerCase().includes("yes") || o.label.toLowerCase().includes("approve")
      );
      respondInteraction(
        state.pendingInteraction.interactionId,
        opt?.id,
        state.pendingInteraction.fingerprint
      );
    }
  };

  const handleReject = () => {
    if (state.pendingInteraction) {
      const opt = state.pendingInteraction.options.find(
        (o) => o.id === "opt_no" || o.label.toLowerCase().includes("no") || o.label.toLowerCase().includes("reject")
      );
      respondInteraction(
        state.pendingInteraction.interactionId,
        opt?.id,
        state.pendingInteraction.fingerprint
      );
    }
  };

  return (
    <footer
      style={{
        background: "var(--color-surface)",
        "border-top": "1px solid var(--color-border)",
        display: "flex",
        "flex-direction": "column",
        "flex-shrink": 0,
        padding: "6px 8px 8px 8px",
        gap: "6px",
      }}
    >
      {/* Quick Action Macro Bar */}
      <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
        {/* Double-tap Ctrl+C button */}
        <button
          class="touch-target"
          onClick={handleCtrlC}
          title="Interrupt running command"
          style={{
            background: ctrlCTapPending() ? "var(--color-danger)" : "var(--color-bg)",
            color: ctrlCTapPending() ? "#ffffff" : "var(--color-danger)",
            border: `1px solid ${ctrlCTapPending() ? "var(--color-danger)" : "var(--color-border)"}`,
            "border-radius": "8px",
            padding: "0 10px",
            height: "44px",
            "font-size": "13px",
            "font-weight": "700",
            cursor: "pointer",
            transition: "all 0.15s ease",
            "white-space": "nowrap",
          }}
        >
          {ctrlCTapPending() ? "Confirm Ctrl+C" : "Ctrl+C"}
        </button>

        {/* Quick Approve button */}
        <button
          class="touch-target"
          disabled={!state.pendingInteraction}
          onClick={handleApprove}
          style={{
            background: state.pendingInteraction ? "var(--color-success)" : "var(--color-bg)",
            color: state.pendingInteraction ? "#ffffff" : "var(--color-faint)",
            border: "1px solid var(--color-border)",
            "border-radius": "8px",
            padding: "0 12px",
            height: "44px",
            "font-size": "13px",
            "font-weight": "600",
            cursor: state.pendingInteraction ? "pointer" : "not-allowed",
            opacity: state.pendingInteraction ? "1" : "0.5",
          }}
        >
          ✓ Approve
        </button>

        {/* Quick Reject button */}
        <button
          class="touch-target"
          disabled={!state.pendingInteraction}
          onClick={handleReject}
          style={{
            background: state.pendingInteraction ? "var(--color-danger)" : "var(--color-bg)",
            color: state.pendingInteraction ? "#ffffff" : "var(--color-faint)",
            border: "1px solid var(--color-border)",
            "border-radius": "8px",
            padding: "0 12px",
            height: "44px",
            "font-size": "13px",
            "font-weight": "600",
            cursor: state.pendingInteraction ? "pointer" : "not-allowed",
            opacity: state.pendingInteraction ? "1" : "0.5",
          }}
        >
          ✕ Reject
        </button>

        {/* Keyboard Drawer Toggle */}
        <button
          class="touch-target"
          onClick={() => setShowKeypad(!showKeypad())}
          title="Terminal Navigation Keys"
          style={{
            background: showKeypad() ? "var(--color-accent)" : "var(--color-bg)",
            color: showKeypad() ? "#ffffff" : "var(--color-fg)",
            border: "1px solid var(--color-border)",
            "border-radius": "8px",
            padding: "0 10px",
            height: "44px",
            "font-size": "13px",
            cursor: "pointer",
            "margin-left": "auto",
          }}
        >
          ⌨
        </button>
      </div>

      {/* Expandable Navigation Keypad */}
      <Show when={showKeypad()}>
        <div
          style={{
            display: "flex",
            gap: "6px",
            "overflow-x": "auto",
            padding: "4px 0",
          }}
        >
          {["Esc", "Tab", "Up", "Down", "Left", "Right"].map((key) => (
            <button
              class="touch-target"
              onClick={() => sendKeys([key])}
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                color: "var(--color-fg)",
                "border-radius": "6px",
                padding: "0 12px",
                height: "36px",
                "font-size": "12px",
                "font-family": "monospace",
                cursor: "pointer",
              }}
            >
              {key}
            </button>
          ))}
        </div>
      </Show>

      {/* Text / Voice Input Row */}
      <div style={{ display: "flex", "align-items": "flex-end", gap: "6px" }}>
        <textarea
          rows={1}
          value={inputText()}
          onInput={(e) => setInputText(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          placeholder="Send prompt or command to agent..."
          style={{
            flex: 1,
            background: "var(--color-bg)",
            color: "var(--color-fg)",
            border: "1px solid var(--color-border)",
            "border-radius": "8px",
            padding: "10px 12px",
            "font-size": "14px",
            "font-family": "inherit",
            resize: "none",
            "min-height": "44px",
            "max-height": "100px",
            outline: "none",
          }}
        />

        {/* Send Button */}
        <button
          class="touch-target"
          onClick={handleSend}
          title="Send"
          style={{
            background: "var(--color-accent)",
            color: "#ffffff",
            border: "none",
            "border-radius": "8px",
            padding: "0 16px",
            height: "44px",
            "font-size": "14px",
            "font-weight": "600",
            cursor: "pointer",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
          }}
        >
          ➤
        </button>
      </div>
    </footer>
  );
};
