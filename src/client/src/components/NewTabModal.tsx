import { Component, For, Show, createSignal } from "solid-js";
import {
  state,
  closeNewTabModal,
  getActiveWorkspace,
} from "../state/store";
import { createTab } from "../state/ws";

export const NewTabModal: Component = () => {
  const ws = getActiveWorkspace;

  const agents = [
    { kind: "claude", name: "Claude Code" },
    { kind: "codex", name: "Codex" },
    { kind: "agy", name: "Antigravity" },
    { kind: "opencode", name: "OpenCode" },
    { kind: "pi", name: "pi" },
    { kind: "terminal", name: "Terminal 终端" },
  ];

  const [selectedKind, setSelectedKind] = createSignal("claude");

  const handleStart = () => {
    const wsId = state.activeWorkspaceId || state.workspaces[0]?.id;
    if (wsId) {
      createTab(wsId, selectedKind());
    }
    closeNewTabModal();
  };

  const selectedAgentName = () => {
    return agents.find((a) => a.kind === selectedKind())?.name || "Agent";
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
          "box-sizing": "border-box",
          background: "var(--sheet)",
          "border-top": "1px solid var(--border)",
          "border-radius": "20px 20px 0 0",
          display: "flex",
          "flex-direction": "column",
          "z-index": 60,
          color: "var(--fg)",
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
              <For each={agents}>
                {(a) => {
                  const isSelected = () => selectedKind() === a.kind;
                  return (
                    <button
                      aria-pressed={isSelected()}
                      class="touch-target"
                      onClick={() => setSelectedKind(a.kind)}
                      style={{
                        "min-height": "64px",
                        display: "flex",
                        "flex-direction": "column",
                        "align-items": "flex-start",
                        "justify-content": "center",
                        gap: "4px",
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
                          "font-size": "12px",
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

          <div
            style={{
              display: "flex",
              gap: "10px",
              padding: "12px",
              "border-radius": "12px",
              background: "var(--inset)",
              border: "1px solid var(--codeb)",
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              style={{ "flex-shrink": 0, "margin-top": "1px", color: "var(--accent)" }}
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5M12 8v.01" />
            </svg>
            <div style={{ "font-size": "13px", "line-height": 1.55, color: "var(--codefg)" }}>
              不带任何启动参数，就像你在终端里直接敲{" "}
              <code
                style={{
                  "font-family": "'JetBrains Mono', ui-monospace, monospace",
                  "font-size": "12px",
                  background: "var(--code)",
                  border: "1px solid var(--codeb)",
                  "border-radius": "4px",
                  padding: "1px 4px",
                }}
              >
                {selectedKind()}
              </code>
              。模型和思考深度等启动后，用底栏的「模型」「思考」按钮，从 Agent 自己的菜单里选。
            </div>
          </div>
        </div>

        {/* Start button */}
        <div style={{ padding: "20px 20px 24px" }}>
          <button
            class="touch-target"
            onClick={handleStart}
            style={{
              width: "100%",
              height: "52px",
              "border-radius": "12px",
              border: 0,
              background: "var(--accent)",
              color: "var(--onaccent)",
              "font-size": "16px",
              "font-weight": 600,
              cursor: "pointer",
            }}
          >
            启动 {selectedAgentName()}
          </button>
        </div>
      </section>
    </Show>
  );
};
