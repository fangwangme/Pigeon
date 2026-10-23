import { Component, For, createSignal, Show } from "solid-js";
import { state, getActiveTab, openSettingsModal } from "../state/store";
import { sendPrompt, sendKeys, respondInteraction } from "../state/ws";

const CHIP_HEIGHT = 32;
const TOUCH = 44;

export const MacroDock: Component = () => {
  const [inputText, setInputText] = createSignal("");
  const [isComposing, setIsComposing] = createSignal(false);
  const [ctrlCConfirm, setCtrlCConfirm] = createSignal(false);
  const [showMore, setShowMore] = createSignal(false);
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

  const primaryMacros = () => state.macros.slice(0, 3);
  const overflowMacros = () => state.macros.slice(3);

  const renderMacroButton = (macro: { id: string; name: string; type: "text" | "key"; payload: string }) => {
    const isCtrlC = () => macro.name === "Ctrl+C" || macro.payload === "ctrl+c";
    const isConfirming = () => isCtrlC() && ctrlCConfirm();

    return (
      <button
        class="touch-target"
        onClick={() => handleMacroClick(macro)}
        style={{
          height: `${CHIP_HEIGHT}px`,
          padding: "0 10px",
          "flex-shrink": 0,
          "border-radius": "9px",
          border: isConfirming()
            ? "1px solid var(--delbg)"
            : "1px solid var(--border)",
          background: isConfirming()
            ? "var(--delbg)"
            : "var(--surface)",
          color: isConfirming() ? "var(--delfg)" : "var(--fg)",
          "font-size": "12px",
          "font-weight": 550,
          cursor: "pointer",
          "white-space": "nowrap",
          transition: "background 0.15s ease, color 0.15s ease, opacity 0.15s ease, transform 0.15s ease",
        }}
      >
        {isConfirming() ? "Confirm Ctrl+C" : macro.name}
      </button>
    );
  };

  return (
    <div
      style={{
        "flex-shrink": 0,
        background: "var(--bg)",
        color: "var(--fg)",
        "border-top": "1px solid var(--line)",
      }}
    >
      {/* Strictly Single-Row Macro Bar with Lateral Slide Drawer */}
      <div
        role="toolbar"
        aria-label="快捷操作栏"
        style={{
          position: "relative",
          height: "42px",
          display: "flex",
          "align-items": "center",
          overflow: "hidden",
          padding: "0 10px",
          background: "var(--bg)",
        }}
      >
        {/* Layer 1: Primary Row (Always fits within 1 row) */}
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "6px",
            width: "100%",
            height: "100%",
            transition: "transform 0.24s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease",
            transform: showMore() ? "translateX(-20%)" : "translateX(0)",
            opacity: showMore() ? 0 : 1,
            "pointer-events": showMore() ? "none" : "auto",
          }}
        >
          <For each={primaryMacros()}>{renderMacroButton}</For>

          {/* Last slot in row: More / Overflow trigger (Icon-only 3-dots, no text, clean & internationalized) */}
          <button
            class="touch-target macro-more-btn"
            aria-label="更多操作"
            title="更多操作"
            onClick={() => setShowMore(true)}
            style={{
              height: `${CHIP_HEIGHT}px`,
              width: "34px",
              padding: "0",
              "flex-shrink": 0,
              "border-radius": "9px",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--muted)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              cursor: "pointer",
              "margin-left": "auto",
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
              style={{ display: "block" }}
            >
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </button>
        </div>

        {/* Layer 2: Lateral Slide-Out Tray (Reveals extra macros in the same single row) */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            "align-items": "center",
            gap: "6px",
            padding: "0 10px",
            background: "var(--surface)",
            transition: "transform 0.24s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease",
            transform: showMore() ? "translateX(0)" : "translateX(100%)",
            opacity: showMore() ? 1 : 0,
            "pointer-events": showMore() ? "auto" : "none",
            "overflow-x": "auto",
            "scrollbar-width": "none",
            "-webkit-overflow-scrolling": "touch",
            "z-index": 5,
          }}
        >
          {/* Back Button */}
          <button
            class="touch-target"
            aria-label="返回"
            title="返回主快捷操作"
            onClick={() => setShowMore(false)}
            style={{
              height: `${CHIP_HEIGHT}px`,
              width: "34px",
              padding: "0",
              "flex-shrink": 0,
              "border-radius": "9px",
              border: "1px solid var(--border)",
              background: "var(--inset)",
              color: "var(--fg)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              cursor: "pointer",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              style={{ display: "block" }}
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>

          {/* Divider */}
          <div style={{ width: "1px", height: "18px", background: "var(--line)", "flex-shrink": 0, margin: "0 2px" }} />

          {/* Secondary / Overflow Macros */}
          <For each={overflowMacros()}>{renderMacroButton}</For>

          {/* Manage Settings */}
          <button
            class="touch-target"
            aria-label="管理快捷操作"
            title="管理快捷操作"
            onClick={() => openSettingsModal("macros")}
            style={{
              height: `${CHIP_HEIGHT}px`,
              padding: "0 10px",
              "flex-shrink": 0,
              "border-radius": "9px",
              border: "1px dashed var(--border)",
              background: "transparent",
              color: "var(--muted)",
              "font-size": "12px",
              display: "flex",
              "align-items": "center",
              gap: "4px",
              cursor: "pointer",
              "white-space": "nowrap",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>管理</span>
          </button>
        </div>
      </div>

      {/* Composer Input Area */}
      <div
        style={{
          padding: "6px 10px calc(8px + env(safe-area-inset-bottom))",
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
            "min-height": "40px",
            "max-height": "110px",
            "box-sizing": "border-box",
            resize: "none",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            "border-radius": "12px",
            color: "var(--fg)",
            "font-family": "inherit",
            "font-size": "14.5px",
            "line-height": "19px",
            padding: "10px 12px",
            "field-sizing": "content",
          }}
        />

        <button
          aria-label={inputText().trim() ? "发送消息并回车" : "发送回车确认 (Enter)"}
          class="touch-target"
          onClick={handleSend}
          title={inputText().trim() ? "发送并回车" : "回车 (Enter)"}
          style={{
            width: "40px",
            height: "40px",
            "flex-shrink": 0,
            "border-radius": "12px",
            border: 0,
            background: inputText().trim() ? "var(--accent)" : "var(--sel)",
            color: inputText().trim() ? "var(--onaccent)" : "var(--accent)",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            cursor: "pointer",
            transition: "background 0.15s ease, color 0.15s ease, transform 0.1s ease",
          }}
        >
          <Show
            when={inputText().trim().length > 0}
            fallback={
              <svg
                width="19"
                height="19"
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
              width="19"
              height="19"
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
