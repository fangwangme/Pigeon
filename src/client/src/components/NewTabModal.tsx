import { Component, For, Show, createSignal, createEffect } from "solid-js";
import {
  state,
  closeNewTabModal,
  getActiveWorkspace,
} from "../state/store";
import { createTab } from "../state/ws";

export const NewTabModal: Component = () => {
  const ws = getActiveWorkspace;

  const defaultAgents = [
    { kind: "claude", name: "Claude Code" },
    { kind: "codex", name: "Codex" },
    { kind: "agy", name: "Antigravity" },
    { kind: "opencode", name: "OpenCode" },
    { kind: "pi", name: "pi" },
    { kind: "terminal", name: "Terminal 终端" },
  ];

  const [selectedKind, setSelectedKind] = createSignal("claude");
  const [selectedModel, setSelectedModel] = createSignal("");
  const [selectedThinking, setSelectedThinking] = createSignal("");

  const currentRecipe = () => {
    return state.recipes?.[selectedKind()];
  };

  createEffect(() => {
    const recipe = currentRecipe();
    if (recipe && recipe.models?.length > 0) {
      const defM = recipe.defaultModel || recipe.models[0]?.id || "";
      setSelectedModel(defM);
      const mObj = recipe.models.find((m) => m.id === defM);
      if (mObj && mObj.thinkingLevels && mObj.thinkingLevels.length > 0) {
        setSelectedThinking(recipe.defaultThinking || mObj.thinkingLevels[0] || "");
      } else {
        setSelectedThinking("");
      }
    } else {
      setSelectedModel("");
      setSelectedThinking("");
    }
  });

  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId);
    const recipe = currentRecipe();
    const mObj = recipe?.models.find((m) => m.id === modelId);
    if (mObj && mObj.thinkingLevels && mObj.thinkingLevels.length > 0) {
      if (!mObj.thinkingLevels.includes(selectedThinking())) {
        setSelectedThinking(mObj.thinkingLevels[0] || "");
      }
    } else {
      setSelectedThinking("");
    }
  };

  const handleStart = () => {
    const wsId = state.activeWorkspaceId || state.workspaces[0]?.id;
    if (wsId) {
      createTab(wsId, selectedKind(), {
        modelId: selectedModel() || undefined,
        thinking: selectedThinking() || undefined,
      });
    }
    closeNewTabModal();
  };

  const selectedAgentName = () => {
    return defaultAgents.find((a) => a.kind === selectedKind())?.name || "Agent";
  };

  return (
    <Show when={state.newTabModalOpen}>
      <div
        aria-hidden="true"
        onClick={closeNewTabModal}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--scrim)",
          "z-index": 55,
        }}
      />

      <section
        aria-label="新建 Tab"
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          "max-height": "90vh",
          "box-sizing": "border-box",
          background: "var(--sheet)",
          "border-top": "1px solid var(--border)",
          "border-radius": "20px 20px 0 0",
          display: "flex",
          "flex-direction": "column",
          "z-index": 60,
          color: "var(--fg)",
          "overflow-y": "auto",
        }}
      >
        {/* Handle bar */}
        <div style={{ display: "flex", "justify-content": "center", "padding-top": "8px" }}>
          <div style={{ width: "40px", height: "4px", "border-radius": "2px", background: "var(--border2)" }} />
        </div>

        {/* Title row */}
        <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "8px 8px 8px 20px" }}>
          <div style={{ flex: 1 }}>
            <div style={{ "font-size": "18px", "font-weight": 700 }}>新建 Tab</div>
            <div style={{ "font-size": "12px", color: "var(--muted)", "margin-top": "2px" }}>
              工作区 {ws()?.label || "Pigeon"}
            </div>
          </div>
          <button
            aria-label="关闭"
            class="touch-target"
            onClick={closeNewTabModal}
            style={{
              width: "44px",
              height: "44px",
              border: 0,
              background: "transparent",
              color: "var(--muted)",
              "border-radius": "10px",
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
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* Agent selection */}
        <div style={{ padding: "4px 20px 0", display: "flex", "flex-direction": "column", gap: "16px" }}>
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend style={{ padding: 0, "margin-bottom": "8px", "font-size": "13px", "font-weight": 600, color: "var(--muted)" }}>
              选一个 Agent
            </legend>
            <div style={{ display: "grid", "grid-template-columns": "repeat(2, minmax(0, 1fr))", gap: "8px" }}>
              <For each={defaultAgents}>
                {(a) => {
                  const isSelected = () => selectedKind() === a.kind;
                  return (
                    <button
                      aria-pressed={isSelected()}
                      class="touch-target"
                      onClick={() => setSelectedKind(a.kind)}
                      style={{
                        "min-height": "60px",
                        display: "flex",
                        "flex-direction": "column",
                        "align-items": "flex-start",
                        "justify-content": "center",
                        gap: "3px",
                        padding: "0 14px",
                        "border-radius": "12px",
                        border: isSelected() ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                        background: isSelected() ? "var(--accentbg)" : "var(--surface)",
                        color: "var(--fg)",
                        "text-align": "left",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ "font-size": "14px", "font-weight": 600 }}>{a.name}</span>
                      <span
                        style={{
                          "font-family": "'JetBrains Mono', ui-monospace, monospace",
                          "font-size": "11px",
                          color: isSelected() ? "var(--accentt)" : "var(--muted)",
                        }}
                      >
                        {a.kind}
                      </span>
                    </button>
                  );
                }}
              </For>
            </div>
          </fieldset>

          {/* Model and Thinking selection (D1) */}
          <Show when={currentRecipe() && (currentRecipe()?.models?.length || 0) > 0}>
            <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
              <div>
                <label style={{ display: "block", "margin-bottom": "6px", "font-size": "13px", "font-weight": 600, color: "var(--muted)" }}>
                  指定模型 (Model)
                </label>
                <select
                  aria-label="指定模型"
                  value={selectedModel()}
                  onChange={(e) => handleModelChange(e.currentTarget.value)}
                  style={{
                    width: "100%",
                    height: "44px",
                    "border-radius": "10px",
                    border: "1.5px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--fg)",
                    padding: "0 12px",
                    "font-size": "14px",
                    "font-family": "inherit",
                    outline: "none",
                    cursor: "pointer",
                  }}
                >
                  <For each={currentRecipe()?.models || []}>
                    {(m) => <option value={m.id}>{m.label}</option>}
                  </For>
                </select>
              </div>

              {/* Thinking levels */}
              <Show
                when={
                  currentRecipe()
                    ?.models?.find((m) => m.id === selectedModel())
                    ?.thinkingLevels?.length
                }
              >
                <div>
                  <label style={{ display: "block", "margin-bottom": "6px", "font-size": "13px", "font-weight": 600, color: "var(--muted)" }}>
                    思考强度 (Thinking Level)
                  </label>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <For
                      each={
                        currentRecipe()?.models?.find((m) => m.id === selectedModel())
                          ?.thinkingLevels || []
                      }
                    >
                      {(lvl) => {
                        const isLvlSelected = () => selectedThinking() === lvl;
                        return (
                          <button
                            class="touch-target"
                            onClick={() => setSelectedThinking(lvl)}
                            style={{
                              flex: 1,
                              height: "36px",
                              "border-radius": "8px",
                              border: isLvlSelected()
                                ? "1.5px solid var(--accent)"
                                : "1px solid var(--border)",
                              background: isLvlSelected()
                                ? "var(--accentbg)"
                                : "var(--surface)",
                              color: isLvlSelected() ? "var(--accent)" : "var(--fg)",
                              "font-size": "13px",
                              "font-weight": isLvlSelected() ? 650 : 500,
                              cursor: "pointer",
                            }}
                          >
                            {lvl}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          </Show>

          <div
            style={{
              display: "flex",
              gap: "10px",
              padding: "10px 12px",
              "border-radius": "10px",
              background: "var(--inset)",
              border: "1px solid var(--codeb)",
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
              style={{ "flex-shrink": 0, "margin-top": "2px", color: "var(--accent)" }}
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5M12 8v.01" />
            </svg>
            <div style={{ "font-size": "12.5px", "line-height": 1.5, color: "var(--codefg)" }}>
              通过服务端启动参数安全组装（如 <code style={{ "font-family": "monospace" }}>--model</code>），防止命令行未授权注入。
            </div>
          </div>
        </div>

        {/* Start button */}
        <div style={{ padding: "16px 20px 24px" }}>
          <button
            class="touch-target"
            onClick={handleStart}
            style={{
              width: "100%",
              height: "48px",
              "border-radius": "12px",
              border: 0,
              background: "var(--accent)",
              color: "var(--onaccent)",
              "font-size": "15px",
              "font-weight": 600,
              cursor: "pointer",
            }}
          >
            启动 {selectedAgentName()} {selectedModel() ? `(${selectedModel()})` : ""}
          </button>
        </div>
      </section>
    </Show>
  );
};
