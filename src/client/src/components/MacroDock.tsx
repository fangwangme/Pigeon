import { Component, For, createSignal, Show } from "solid-js";
import { state, getActiveTab, openSettingsModal } from "../state/store";
import { sendPrompt, sendKeys, respondInteraction } from "../state/ws";

const CHIP_HEIGHT = 40;
const TOUCH = 44;

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
    if (text) {
      sendPrompt(text);
      setInputText("");
    } else {
      // Empty input: Send button acts as instant Enter confirmation
      sendKeys(["enter"]);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (isComposing() || (e as any).isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isDisabled = (macro: { name: string }) =>
    macro.name === "Approve" && !state.pendingInteraction;

  return (
    <div
      style={{
        "flex-shrink": 0,
        background: "var(--bg)",
        color: "var(--fg)",
        "border-top": "1px solid var(--line)",
      }}
    >
      {/* Quick actions: wrap so no macro is ever hidden behind a scroll edge */}
      <div
        role="toolbar"
        aria-label="快捷操作栏"
        style={{
          display: "flex",
          "flex-wrap": "wrap",
          "align-items": "center",
          gap: "6px",
          padding: "8px 10px 0",
        }}
      >
        <For each={state.macros}>
          {(macro) => {
            const isCtrlC = () => macro.name === "Ctrl+C" || macro.payload === "ctrl+c";
            const isConfirming = () => isCtrlC() && ctrlCConfirm();
            const disabled = () => isDisabled(macro);

            return (
              <button
                class="touch-target"
                disabled={disabled()}
                aria-disabled={disabled()}
                onClick={() => !disabled() && handleMacroClick(macro)}
                style={{
                  height: `${CHIP_HEIGHT}px`,
                  padding: "0 12px",
                  "flex-shrink": 0,
                  "border-radius": "10px",
                  border: isConfirming()
                    ? "1px solid var(--delbg)"
                    : "1px solid var(--border)",
                  background: isConfirming()
                    ? "var(--delbg)"
                    : "var(--surface)",
                  color: isConfirming() ? "var(--delfg)" : "var(--fg)",
                  "font-size": "12.5px",
                  "font-weight": 500,
                  cursor: disabled() ? "default" : "pointer",
                  opacity: disabled() ? 0.42 : 1,
                  "white-space": "nowrap",
                  transition: "background 0.15s ease, color 0.15s ease, opacity 0.15s ease",
                }}
              >
                {isConfirming() ? "Confirm Ctrl+C" : macro.name}
              </button>
            );
          }}
        </For>

        <button
          class="touch-target"
          aria-label="管理快捷操作"
          title="管理快捷操作"
          onClick={() => openSettingsModal("macros")}
          style={{
            width: `${TOUCH}px`,
            height: `${CHIP_HEIGHT}px`,
            "flex-shrink": 0,
            "border-radius": "10px",
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--muted)",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            cursor: "pointer",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
      </div>

      {/* Composer */}
      <div
        style={{
          padding: "7px 10px calc(10px + env(safe-area-inset-bottom))",
          display: "flex",
          gap: "8px",
          "align-items": "flex-end",
        }}
      >
        <textarea
          id="pigeon-input"
          aria-label={`发给 ${tab()?.label || "Agent"}`}
          rows={1}
          placeholder="输入"
          value={inputText()}
          onInput={(e) => setInputText(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          style={{
            flex: 1,
            "min-height": `${TOUCH}px`,
            "max-height": "120px",
            "box-sizing": "border-box",
            resize: "none",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            "border-radius": "14px",
            color: "var(--fg)",
            "font-family": "inherit",
            "font-size": "15px",
            "line-height": "20px",
            padding: "11px 13px",
            "field-sizing": "content",
          }}
        />

        <button
          aria-label={inputText().trim() ? "发送消息并回车" : "发送回车确认 (Enter)"}
          class="touch-target"
          onClick={handleSend}
          title={inputText().trim() ? "发送并回车" : "回车 (Enter)"}
          style={{
            width: `${TOUCH}px`,
            height: `${TOUCH}px`,
            "flex-shrink": 0,
            "border-radius": "14px",
            border: 0,
            background: inputText().trim() ? "var(--accent)" : "var(--sel)",
            color: inputText().trim() ? "var(--onaccent)" : "var(--accent)",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            cursor: "pointer",
            transition: "background 0.15s ease, color 0.15s ease",
          }}
        >
          <Show
            when={inputText().trim().length > 0}
            fallback={
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
                <polyline points="9 10 4 15 9 20" />
                <path d="M20 4v7a4 4 0 0 1-4 4H4" />
              </svg>
            }
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
          </Show>
        </button>
      </div>
    </div>
  );
};
