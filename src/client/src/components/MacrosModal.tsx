import { Component, For, Show, createSignal } from "solid-js";
import {
  state,
  setState,
  closeMacrosModal,
  type MacroItem,
} from "../state/store";
import { sendConfigPatch } from "../state/ws";

const DEFAULT_MACROS: MacroItem[] = [
  { id: "m_model", name: "模型", type: "key", payload: "model" },
  { id: "m_continue", name: "Continue", type: "text", payload: "continue" },
  { id: "m_ctrlc", name: "Ctrl+C", type: "key", payload: "ctrl+c" },
  { id: "m_enter", name: "Enter", type: "key", payload: "enter" },
  { id: "m_tab", name: "Tab", type: "key", payload: "tab" },
];

export const MacrosModal: Component = () => {
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [nameInput, setNameInput] = createSignal("");
  const [typeInput, setTypeInput] = createSignal<"text" | "key">("text");
  const [payloadInput, setPayloadInput] = createSignal("");

  const handleAdd = () => {
    const newMacro: MacroItem = {
      id: `m_${Date.now()}`,
      name: "新操作",
      type: "text",
      payload: "继续",
    };
    setState("macros", (prev) => [...prev, newMacro]);
    setEditingId(newMacro.id);
    setNameInput(newMacro.name);
    setTypeInput(newMacro.type);
    setPayloadInput(newMacro.payload);
  };

  const handleSaveEdit = () => {
    if (!editingId()) return;
    const updated = state.macros.map((m) =>
      m.id === editingId()
        ? { ...m, name: nameInput(), type: typeInput(), payload: payloadInput() }
        : m
    );
    setState("macros", updated);
    setEditingId(null);
    sendConfigPatch({ macros: updated });
  };

  const handleDelete = (id: string) => {
    const updated = state.macros.filter((m) => m.id !== id);
    setState("macros", updated);
    if (editingId() === id) {
      setEditingId(null);
    }
    sendConfigPatch({ macros: updated });
  };

  const moveUp = (idx: number) => {
    if (idx <= 0) return;
    const next = [...state.macros];
    const temp = next[idx];
    next[idx] = next[idx - 1];
    next[idx - 1] = temp;
    setState("macros", next);
    sendConfigPatch({ macros: next });
  };

  const handleReset = () => {
    setState("macros", DEFAULT_MACROS);
    setEditingId(null);
    sendConfigPatch({ macros: DEFAULT_MACROS });
  };

  return (
    <Show when={state.macrosModalOpen}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          "z-index": 60,
          background: "var(--bg)",
          color: "var(--fg)",
          display: "flex",
          "flex-direction": "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <header
          style={{
            height: "56px",
            "flex-shrink": 0,
            display: "flex",
            "align-items": "center",
            gap: "4px",
            padding: "0 8px 0 4px",
            "border-bottom": "1px solid var(--line)",
          }}
        >
          <button
            aria-label="返回"
            class="touch-target"
            onClick={closeMacrosModal}
            style={{
              width: "44px",
              height: "44px",
              border: 0,
              background: "transparent",
              color: "var(--fg)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              "border-radius": "10px",
              cursor: "pointer",
            }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <div style={{ flex: 1, "font-size": "16px", "font-weight": 600 }}>快捷操作栏</div>
          <button
            class="touch-target"
            onClick={closeMacrosModal}
            style={{
              height: "44px",
              padding: "0 12px",
              border: 0,
              background: "transparent",
              color: "var(--accentt)",
              "font-size": "15px",
              "font-weight": 600,
              cursor: "pointer",
            }}
          >
            完成
          </button>
        </header>

        {/* Preview row */}
        <div
          style={{
            "flex-shrink": 0,
            padding: "12px 16px",
            "border-bottom": "1px solid var(--line)",
            display: "flex",
            "flex-direction": "column",
            gap: "8px",
          }}
        >
          <div style={{ "font-size": "12px", color: "var(--muted)" }}>预览</div>
          <div
            style={{
              display: "flex",
              gap: "6px",
              "overflow-x": "auto",
              "scrollbar-width": "none",
            }}
          >
            <span
              style={{
                height: "32px",
                padding: "0 10px",
                "flex-shrink": 0,
                "border-radius": "8px",
                border: "1px dashed var(--border2)",
                color: "var(--muted)",
                "font-size": "12px",
                display: "flex",
                "align-items": "center",
              }}
            >
              模型
            </span>
            <For each={state.macros}>
              {(m) => (
                <span
                  style={{
                    height: "32px",
                    padding: "0 10px",
                    "flex-shrink": 0,
                    "border-radius": "8px",
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    "font-size": "12px",
                    display: "flex",
                    "align-items": "center",
                  }}
                >
                  {m.name}
                </span>
              )}
            </For>
          </div>
          <div style={{ "font-size": "11px", color: "var(--faint)" }}>
            虚线按钮由当前 Agent 自动提供，不可编辑
          </div>
        </div>

        {/* List of macros */}
        <div
          style={{
            flex: 1,
            "min-height": 0,
            "overflow-y": "auto",
            padding: "12px 12px 0",
            display: "flex",
            "flex-direction": "column",
            gap: "6px",
          }}
        >
          <div style={{ "font-size": "12px", color: "var(--muted)", padding: "0 4px 4px" }}>
            按住左侧手柄拖动或点击排序
          </div>

          <For each={state.macros}>
            {(macro, idx) => (
              <div
                style={{
                  height: "52px",
                  display: "flex",
                  "align-items": "center",
                  gap: "8px",
                  padding: "0 4px 0 0",
                  "border-radius": "10px",
                  background: "var(--sheet)",
                  border: "1px solid var(--line)",
                }}
              >
                <button
                  aria-label={`拖动排序：${macro.name}`}
                  class="touch-target"
                  onClick={() => moveUp(idx())}
                  style={{
                    width: "36px",
                    height: "44px",
                    border: 0,
                    background: "transparent",
                    color: "var(--faint)",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    cursor: "pointer",
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="9" cy="6" r="1.6" />
                    <circle cx="15" cy="6" r="1.6" />
                    <circle cx="9" cy="12" r="1.6" />
                    <circle cx="15" cy="12" r="1.6" />
                    <circle cx="9" cy="18" r="1.6" />
                    <circle cx="15" cy="18" r="1.6" />
                  </svg>
                </button>

                <span style={{ width: "84px", "font-size": "14px", "font-weight": 600 }}>
                  {macro.name}
                </span>

                <span
                  style={{
                    height: "22px",
                    padding: "0 8px",
                    "border-radius": "11px",
                    background: macro.type === "key" ? "var(--accentbg)" : "var(--badge)",
                    color: macro.type === "key" ? "var(--accentt)" : "var(--codefg)",
                    "font-size": "11px",
                    "font-weight": 600,
                    display: "flex",
                    "align-items": "center",
                  }}
                >
                  {macro.type === "key" ? "按键" : "文本"}
                </span>

                <span
                  style={{
                    flex: 1,
                    "min-width": 0,
                    "font-family": "'JetBrains Mono', ui-monospace, monospace",
                    "font-size": "12px",
                    color: "var(--muted)",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}
                >
                  {macro.payload}
                </span>

                <button
                  aria-label={`删除 ${macro.name}`}
                  class="touch-target"
                  onClick={() => handleDelete(macro.id)}
                  style={{
                    width: "44px",
                    height: "44px",
                    border: 0,
                    background: "transparent",
                    color: "var(--faint)",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    cursor: "pointer",
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
                  >
                    <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />
                  </svg>
                </button>
              </div>
            )}
          </For>

          {/* Form edit block */}
          <Show when={editingId()}>
            <div
              style={{
                "border-radius": "12px",
                background: "var(--sheet)",
                border: "1.5px solid var(--accent)",
                padding: "12px",
                display: "flex",
                "flex-direction": "column",
                gap: "10px",
                "margin-top": "8px",
              }}
            >
              <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                <span style={{ "font-size": "13px", "font-weight": 600 }}>编辑快捷操作</span>
                <button
                  class="touch-target"
                  onClick={handleSaveEdit}
                  style={{
                    border: 0,
                    background: "var(--accent)",
                    color: "var(--onaccent)",
                    padding: "4px 10px",
                    "border-radius": "6px",
                    "font-size": "12px",
                    cursor: "pointer",
                  }}
                >
                  保存
                </button>
              </div>

              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <label style={{ "font-size": "12px", color: "var(--muted)" }}>名称</label>
                <input
                  value={nameInput()}
                  onInput={(e) => setNameInput(e.currentTarget.value)}
                  style={{
                    height: "44px",
                    "box-sizing": "border-box",
                    background: "var(--inset)",
                    border: "1px solid var(--border)",
                    "border-radius": "10px",
                    color: "var(--fg)",
                    "font-size": "14px",
                    padding: "0 12px",
                  }}
                />
              </div>

              <div
                style={{
                  display: "grid",
                  "grid-template-columns": "repeat(2, minmax(0, 1fr))",
                  gap: "4px",
                  padding: "4px",
                  "border-radius": "10px",
                  background: "var(--inset)",
                  border: "1px solid var(--codeb)",
                }}
              >
                <button
                  class="touch-target"
                  onClick={() => setTypeInput("text")}
                  style={{
                    height: "36px",
                    "border-radius": "7px",
                    border: 0,
                    background: typeInput() === "text" ? "var(--sel)" : "transparent",
                    color: typeInput() === "text" ? "var(--fg)" : "var(--muted)",
                    "font-size": "13px",
                    "font-weight": typeInput() === "text" ? 600 : 500,
                    cursor: "pointer",
                  }}
                >
                  发送文本
                </button>
                <button
                  class="touch-target"
                  onClick={() => setTypeInput("key")}
                  style={{
                    height: "36px",
                    "border-radius": "7px",
                    border: 0,
                    background: typeInput() === "key" ? "var(--sel)" : "transparent",
                    color: typeInput() === "key" ? "var(--fg)" : "var(--muted)",
                    "font-size": "13px",
                    "font-weight": typeInput() === "key" ? 600 : 500,
                    cursor: "pointer",
                  }}
                >
                  发送按键
                </button>
              </div>

              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <label style={{ "font-size": "12px", color: "var(--muted)" }}>发给 Agent 的内容</label>
                <textarea
                  rows={2}
                  value={payloadInput()}
                  onInput={(e) => setPayloadInput(e.currentTarget.value)}
                  style={{
                    "box-sizing": "border-box",
                    resize: "none",
                    background: "var(--inset)",
                    border: "1px solid var(--border)",
                    "border-radius": "10px",
                    color: "var(--fg)",
                    "font-size": "14px",
                    "line-height": "20px",
                    padding: "10px 12px",
                  }}
                />
              </div>
            </div>
          </Show>

          <button
            class="touch-target"
            onClick={handleAdd}
            style={{
              height: "48px",
              "flex-shrink": 0,
              "border-radius": "10px",
              border: "1px dashed var(--border2)",
              background: "transparent",
              color: "var(--muted)",
              "font-size": "14px",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              gap: "6px",
              cursor: "pointer",
              "margin-top": "6px",
              "margin-bottom": "24px",
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
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            添加快捷操作
          </button>

          <button
            class="touch-target"
            onClick={handleReset}
            style={{
              height: "40px",
              "flex-shrink": 0,
              border: 0,
              background: "transparent",
              color: "var(--faint)",
              "font-size": "13px",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              cursor: "pointer",
              "margin-bottom": "24px",
            }}
          >
            恢复默认宏
          </button>
        </div>
      </div>
    </Show>
  );
};
