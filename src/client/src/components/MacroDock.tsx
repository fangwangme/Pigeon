import { Component, For, createSignal } from "solid-js";
import { state, openMacrosModal, getActiveTab } from "../state/store";
import { sendPrompt, sendKeys, respondInteraction } from "../state/ws";

export const MacroDock: Component = () => {
  const [inputText, setInputText] = createSignal("");
  const [isComposing, setIsComposing] = createSignal(false);
  const [ctrlCConfirm, setCtrlCConfirm] = createSignal(false);
  let ctrlCTimer: any = null;

  const tab = getActiveTab;

  const handleCtrlC = () => {
    if (ctrlCConfirm()) {
      clearTimeout(ctrlCTimer);
      setCtrlCConfirm(false);
      sendKeys(["ctrl+c"]);
    } else {
      setCtrlCConfirm(true);
      ctrlCTimer = setTimeout(() => {
        setCtrlCConfirm(false);
      }, 800);
    }
  };

  const handleMacroClick = (macro: { id: string; name: string; type: "text" | "key"; payload: string }) => {
    if (macro.name === "Ctrl+C" || macro.payload === "ctrl+c") {
      handleCtrlC();
      return;
    }

    if (macro.name === "Approve" && state.pendingInteraction) {
      const yesOpt = state.pendingInteraction.options.find(
        (o) => o.id === "opt_yes" || o.id === "opt_1" || o.label.includes("是") || o.label.toLowerCase().includes("yes")
      );
      respondInteraction(state.pendingInteraction.interactionId, yesOpt?.id, state.pendingInteraction.fingerprint);
      return;
    }

    if (macro.name === "模型" || macro.payload === "model") {
      sendPrompt("/model");
      return;
    }

    if (macro.type === "key") {
      sendKeys([macro.payload]);
    } else {
      sendPrompt(macro.payload);
    }
  };

  const handleSend = () => {
    const text = inputText().trim();
    if (!text) return;
    sendPrompt(text);
    setInputText("");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (isComposing() || (e as any).isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      style={{
        "flex-shrink": 0,
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      {/* Horizontal Scrollable Macro Dock */}
      <div
        aria-label="快捷操作栏"
        style={{
          display: "flex",
          gap: "8px",
          padding: "0 12px 8px",
          "overflow-x": "auto",
          "scrollbar-width": "none",
        }}
      >
        <For each={state.macros}>
          {(macro) => {
            const isCtrlC = () => macro.name === "Ctrl+C" || macro.payload === "ctrl+c";
            const isConfirming = () => isCtrlC() && ctrlCConfirm();

            return (
              <button
                class="touch-target"
                onClick={() => handleMacroClick(macro)}
                style={{
                  height: "44px",
                  padding: "0 14px",
                  "flex-shrink": 0,
                  "border-radius": "10px",
                  border: isConfirming()
                    ? "1px solid var(--delbg)"
                    : "1px solid var(--border)",
                  background: isConfirming()
                    ? "var(--delbg)"
                    : "var(--surface)",
                  color: isConfirming() ? "var(--delfg)" : "var(--fg)",
                  "font-size": "13px",
                  "font-weight": 500,
                  cursor: "pointer",
                  "white-space": "nowrap",
                  transition: "all 0.15s ease",
                }}
              >
                {isConfirming() ? "Confirm Ctrl+C" : macro.name}
              </button>
            );
          }}
        </For>
      </div>

      {/* Input bar */}
      <div
        style={{
          padding: "8px 12px 20px",
          "border-top": "1px solid var(--line)",
          display: "flex",
          gap: "8px",
          "align-items": "flex-end",
        }}
      >
        <button
          aria-label="编辑快捷操作栏"
          class="touch-target"
          onClick={openMacrosModal}
          style={{
            width: "44px",
            height: "44px",
            "flex-shrink": 0,
            "border-radius": "12px",
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--muted)",
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
            <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
            <circle cx="15" cy="6" r="2" />
            <circle cx="9" cy="12" r="2" />
            <circle cx="17" cy="18" r="2" />
          </svg>
        </button>

        <textarea
          id="pigeon-input"
          aria-label={`发给 ${tab()?.label || "Agent"}`}
          rows={1}
          placeholder="输入，或点键盘上的麦克风说话…"
          value={inputText()}
          onInput={(e) => setInputText(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          style={{
            flex: 1,
            "min-height": "44px",
            "box-sizing": "border-box",
            resize: "none",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            "border-radius": "12px",
            color: "var(--fg)",
            "font-family": "inherit",
            "font-size": "15px",
            "line-height": "20px",
            padding: "11px 12px",
          }}
        />

        <button
          aria-label="发送"
          class="touch-target"
          onClick={handleSend}
          style={{
            width: "44px",
            height: "44px",
            "flex-shrink": 0,
            "border-radius": "12px",
            border: 0,
            background: "var(--accent)",
            color: "var(--onaccent)",
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
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
};
