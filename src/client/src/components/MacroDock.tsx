import { Component, For, createSignal, Show, createMemo } from "solid-js";
import { state, getActiveTab, openSettingsModal, type MacroItem } from "../state/store";
import { sendPrompt, sendKeys } from "../state/ws";

export const MacroDock: Component = () => {
  const [inputText, setInputText] = createSignal("");
  const [isComposing, setIsComposing] = createSignal(false);
  const [ctrlCConfirm, setCtrlCConfirm] = createSignal(false);
  const [showOptions, setShowOptions] = createSignal(false);
  let ctrlCTimer: any = null;
  let textareaRef: HTMLTextAreaElement | undefined;

  const tab = getActiveTab;

  const activePane = () => {
    const t = tab();
    if (!t) return undefined;
    return t.panes?.find((p) => p.id === state.activePaneId) || t.panes?.[0];
  };

  const currentAgentKind = () => {
    const p = activePane();
    return p?.agent?.toLowerCase() || "";
  };

  const currentRecipe = () => {
    return state.recipes?.[currentAgentKind()];
  };

  // Skill completion: a "/" at the start of the input, before any space (D2).
  const skillQuery = createMemo(() => {
    if (isComposing()) return null;
    const m = /^\/(\S*)$/.exec(inputText());
    return m ? m[1].toLowerCase() : null;
  });

  const matchingSkills = createMemo(() => {
    const q = skillQuery();
    if (q === null) return [];
    const all = state.skills || [];
    if (!q) return all.slice(0, 8);
    return all
      .filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .slice(0, 8);
  });

  // Inserts the skill in the current agent's own syntax (e.g. "/name", "$name").
  const handleSelectSkill = (invocation: string) => {
    setInputText(`${invocation} `);
    textareaRef?.focus();
  };

  const handleInterrupt = () => {
    const recipe = currentRecipe();
    const keys = recipe?.interruptKeys || ["esc"];
    sendKeys(keys);
    setShowOptions(false);
  };

  // Ctrl+C can kill the agent, so it needs a second tap within 2s unless the user turned that off.
  const confirmThenSend = (keys: string[]) => {
    if (!state.confirmCtrlC || ctrlCConfirm()) {
      clearTimeout(ctrlCTimer);
      setCtrlCConfirm(false);
      sendKeys(keys);
      setShowOptions(false);
      return;
    }
    setCtrlCConfirm(true);
    ctrlCTimer = setTimeout(() => setCtrlCConfirm(false), 2000);
  };
  const handleCtrlC = () => confirmThenSend(["ctrl+c"]);

  const handleSend = () => {
    const text = inputText().trim();
    if (text) {
      // Keep the draft when the message could not be sent (offline).
      if (sendPrompt(text)) setInputText("");
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

  const handleMacroAction = (macro: MacroItem) => {
    if (macro.type === "key" && macro.confirm) {
      confirmThenSend([macro.payload]);
      return;
    }
    if (macro.type === "key") {
      sendKeys([macro.payload]);
    } else {
      sendPrompt(macro.payload);
    }
    setShowOptions(false);
  };

  return (
    <div
      style={{
        "flex-shrink": 0,
        background: "var(--bg)",
        "border-top": "1px solid var(--line)",
        position: "relative",
        "z-index": 20,
      }}
    >
      {/* Skill completion popup (D2) */}
      <Show when={skillQuery() !== null && matchingSkills().length > 0}>
        <div
          role="listbox"
          aria-label="Skill 补全列表"
          style={{
            position: "absolute",
            bottom: "100%",
            left: "10px",
            right: "10px",
            "margin-bottom": "6px",
            "max-height": "220px",
            "overflow-y": "auto",
            background: "var(--sheet)",
            border: "1.5px solid var(--border)",
            "border-radius": "14px",
            "box-shadow": "0 8px 24px rgba(0,0,0,0.3)",
            padding: "6px",
            display: "flex",
            "flex-direction": "column",
            gap: "4px",
            "z-index": 35,
          }}
        >
          <div
            style={{
              padding: "4px 8px 6px",
              "font-size": "11px",
              color: "var(--muted)",
              "font-weight": 600,
              "border-bottom": "1px solid var(--line)",
              display: "flex",
              "justify-content": "space-between",
            }}
          >
            <span>SKILL 补全 ({matchingSkills().length})</span>
            <span>点击选择</span>
          </div>
          <For each={matchingSkills()}>
            {(skill) => (
              <button
                class="touch-target"
                onClick={() => handleSelectSkill(skill.invocation)}
                style={{
                  display: "flex",
                  "flex-direction": "column",
                  "align-items": "flex-start",
                  padding: "8px 10px",
                  "border-radius": "8px",
                  border: "1px solid transparent",
                  background: "var(--surface)",
                  color: "var(--fg)",
                  "text-align": "left",
                  cursor: "pointer",
                  gap: "2px",
                }}
              >
                <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                  <span
                    style={{
                      "font-family": "'JetBrains Mono', monospace",
                      "font-weight": 700,
                      "font-size": "13px",
                      color: "var(--accent)",
                    }}
                  >
                    {skill.invocation}
                  </span>
                  <span
                    style={{
                      "font-size": "10px",
                      padding: "1px 5px",
                      "border-radius": "4px",
                      background: "var(--inset)",
                      color: "var(--muted)",
                    }}
                  >
                    {skill.source}
                  </span>
                </div>
                <div
                  style={{
                    "font-size": "12px",
                    color: "var(--muted)",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                    width: "100%",
                  }}
                >
                  {skill.description}
                </div>
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* Option Sheet popup (D7) */}
      <Show when={showOptions()}>
        <div
          aria-hidden="true"
          onClick={() => setShowOptions(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "var(--scrim)",
            "z-index": 45,
          }}
        />
        <div
          role="dialog"
          aria-label="操作选项"
          style={{
            position: "absolute",
            bottom: "100%",
            left: "10px",
            right: "10px",
            "margin-bottom": "8px",
            background: "var(--sheet)",
            border: "1.5px solid var(--border)",
            "border-radius": "16px",
            "box-shadow": "0 10px 30px rgba(0,0,0,0.35)",
            padding: "14px",
            display: "flex",
            "flex-direction": "column",
            gap: "12px",
            "z-index": 50,
          }}
        >
          {/* Section: Interrupt & Stop */}
          <div>
            <div style={{ "font-size": "11.5px", "font-weight": 700, color: "var(--muted)", "margin-bottom": "6px" }}>
              控制与中断
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                class="touch-target"
                onClick={handleInterrupt}
                style={{
                  flex: 1,
                  height: "40px",
                  "border-radius": "9px",
                  border: "1.5px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--fg)",
                  "font-size": "13px",
                  "font-weight": 600,
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  gap: "6px",
                  cursor: "pointer",
                }}
              >
                <span>🛑 中断 ({(currentRecipe()?.interruptKeys || ["esc"]).join("+")})</span>
              </button>
              <button
                class="touch-target"
                onClick={handleCtrlC}
                style={{
                  flex: 1,
                  height: "40px",
                  "border-radius": "9px",
                  border: ctrlCConfirm() ? "1.5px solid var(--delbg)" : "1.5px solid var(--border)",
                  background: ctrlCConfirm() ? "var(--delbg)" : "var(--surface)",
                  color: ctrlCConfirm() ? "#fff" : "var(--delbg)",
                  "font-size": "13px",
                  "font-weight": 600,
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  cursor: "pointer",
                }}
              >
                <span>{ctrlCConfirm() ? "再按一次确认" : "Ctrl+C"}</span>
              </button>
            </div>
          </div>

          {/* Section: Keys */}
          <div>
            <div style={{ "font-size": "11.5px", "font-weight": 700, color: "var(--muted)", "margin-bottom": "6px" }}>
              常用按键
            </div>
            <div style={{ display: "grid", "grid-template-columns": "repeat(4, 1fr)", gap: "6px" }}>
              <button
                class="touch-target"
                onClick={() => { sendKeys(["tab"]); setShowOptions(false); }}
                style={{
                  height: "36px",
                  "border-radius": "8px",
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--fg)",
                  "font-size": "12.5px",
                  "font-weight": 600,
                  cursor: "pointer",
                }}
              >
                Tab
              </button>
              <button
                class="touch-target"
                onClick={() => { sendKeys(["enter"]); setShowOptions(false); }}
                style={{
                  height: "36px",
                  "border-radius": "8px",
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--fg)",
                  "font-size": "12.5px",
                  "font-weight": 600,
                  cursor: "pointer",
                }}
              >
                Enter
              </button>
              <button
                class="touch-target"
                onClick={() => { sendKeys(["up"]); setShowOptions(false); }}
                style={{
                  height: "36px",
                  "border-radius": "8px",
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--fg)",
                  "font-size": "12.5px",
                  "font-weight": 600,
                  cursor: "pointer",
                }}
              >
                ↑
              </button>
              <button
                class="touch-target"
                onClick={() => { sendKeys(["down"]); setShowOptions(false); }}
                style={{
                  height: "36px",
                  "border-radius": "8px",
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--fg)",
                  "font-size": "12.5px",
                  "font-weight": 600,
                  cursor: "pointer",
                }}
              >
                ↓
              </button>
            </div>
          </div>

          {/* Section: Custom Macros */}
          <div>
            <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "6px" }}>
              <span style={{ "font-size": "11.5px", "font-weight": 700, color: "var(--muted)" }}>快捷宏</span>
              <button
                onClick={() => { setShowOptions(false); openSettingsModal("macros"); }}
                style={{
                  background: "transparent",
                  border: 0,
                  color: "var(--accent)",
                  "font-size": "11.5px",
                  cursor: "pointer",
                }}
              >
                ⚙️ 管理
              </button>
            </div>
            <div style={{ display: "flex", "overflow-x": "auto", gap: "6px", "scrollbar-width": "none" }}>
              <For each={state.macros}>
                {(m) => (
                  <button
                    class="touch-target"
                    onClick={() => handleMacroAction(m)}
                    style={{
                      height: "34px",
                      padding: "0 10px",
                      "border-radius": "8px",
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      color: "var(--fg)",
                      "font-size": "12px",
                      cursor: "pointer",
                    }}
                  >
                    {m.name}
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>

      {/* Unified Input Composer Row (D3) */}
      <div
        style={{
          padding: "8px 10px calc(12px + env(safe-area-inset-bottom))",
          display: "flex",
          gap: "8px",
          "align-items": "flex-end",
          background: "var(--bg)",
          "box-sizing": "border-box",
        }}
      >
        <div style={{ flex: 1, position: "relative" }}>
          <textarea
            ref={textareaRef}
            id="pigeon-input"
            aria-label={`发给 ${tab()?.label || "Agent"}`}
            rows={1}
            placeholder={
              state.agentStatus === "blocked"
                ? "Agent 处于确认状态，输入或点击选项..."
                : "输入消息或指令（输入 / 唤起 Skill）..."
            }
            value={inputText()}
            onInput={(e) => setInputText(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            style={{
              width: "100%",
              "min-height": "44px",
              "max-height": "120px",
              "box-sizing": "border-box",
              resize: "none",
              background: "var(--surface)",
              border: "1.5px solid var(--border)",
              "border-radius": "12px",
              color: "var(--fg)",
              "font-family": "inherit",
              "font-size": "14px",
              "line-height": "20px",
              padding: "11px 12px",
              "field-sizing": "content",
              "box-shadow": "0 1px 3px rgba(0, 0, 0, 0.15)",
              outline: "none",
            }}
          />
        </div>

        {/* Options Button (···) (D7) */}
        <Show when={state.showMacroDock !== false}>
          <button
            id="macro-more-btn"
            aria-label="操作与宏选项"
            class="touch-target macro-more-btn"
            onClick={() => setShowOptions((o) => !o)}
            title="快捷操作与宏"
            style={{
              width: "44px",
              height: "44px",
              "min-width": "44px",
              "min-height": "44px",
              "flex-shrink": 0,
              "border-radius": "12px",
              border: "1.5px solid var(--border)",
              background: showOptions() ? "var(--accentbg)" : "var(--surface)",
              color: showOptions() ? "var(--accent)" : "var(--fg)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              cursor: "pointer",
              "box-shadow": "0 1px 3px rgba(0, 0, 0, 0.15)",
              "box-sizing": "border-box",
              transition: "all 0.15s ease",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="19" cy="12" r="1.5" />
              <circle cx="5" cy="12" r="1.5" />
            </svg>
          </button>
        </Show>

        {/* Send Button */}
        <button
          aria-label={inputText().trim() ? "发送消息并回车" : "发送回车确认 (Enter)"}
          class="touch-target"
          onClick={handleSend}
          title={inputText().trim() ? "发送" : "回车 (Enter)"}
          style={{
            width: "44px",
            height: "44px",
            "min-width": "44px",
            "min-height": "44px",
            "flex-shrink": 0,
            "border-radius": "12px",
            border: "1.5px solid " + (inputText().trim() ? "var(--accent)" : "var(--border)"),
            background: inputText().trim() ? "var(--accent)" : "var(--surface)",
            color: inputText().trim() ? "var(--onaccent)" : "var(--accent)",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            cursor: "pointer",
            "box-shadow": "0 1px 3px rgba(0, 0, 0, 0.15)",
            "box-sizing": "border-box",
            transition: "background 0.15s ease, color 0.15s ease, border-color 0.15s ease",
          }}
        >
          <Show
            when={inputText().trim().length > 0}
            fallback={
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 10 4 15 9 20" />
                <path d="M20 4v7a4 4 0 0 1-4 4H4" />
              </svg>
            }
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </Show>
        </button>
      </div>
    </div>
  );
};
