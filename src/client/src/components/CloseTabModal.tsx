import { Component, Show } from "solid-js";
import { state, cancelCloseTabConfirm } from "../state/store";
import { closeTab } from "../state/ws";

export const CloseTabModal: Component = () => {
  const handleConfirm = () => {
    const tab = state.tabToClose;
    if (tab?.tabId) {
      closeTab(tab.tabId);
    }
    cancelCloseTabConfirm();
  };

  return (
    <Show when={state.closeTabConfirmModalOpen}>
      <div
        aria-hidden="true"
        onClick={cancelCloseTabConfirm}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--scrim)",
          "z-index": 70,
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="确认关闭 Tab"
        style={{
          position: "fixed",
          left: "20px",
          right: "20px",
          top: "50%",
          transform: "translateY(-50%)",
          "box-sizing": "border-box",
          background: "var(--sheet)",
          border: "1.5px solid var(--border)",
          "border-radius": "16px",
          padding: "20px",
          display: "flex",
          "flex-direction": "column",
          gap: "14px",
          "z-index": 75,
          color: "var(--fg)",
          "box-shadow": "0 8px 30px rgba(0, 0, 0, 0.4)",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
          <div
            style={{
              width: "36px",
              height: "36px",
              "border-radius": "50%",
              background: "rgba(234, 105, 98, 0.15)",
              color: "var(--delbg)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              "flex-shrink": 0,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div>
            <div style={{ "font-size": "16px", "font-weight": 700 }}>确认关闭此 Tab？</div>
            <div style={{ "font-size": "12px", color: "var(--muted)", "margin-top": "2px" }}>
              {state.tabToClose?.label || "选中 Tab"}
            </div>
          </div>
        </div>

        <div style={{ "font-size": "13px", "line-height": "1.5", color: "var(--fg)" }}>
          关闭 Tab 将彻底终止其中正在运行的 Agent 进程与当前会话，并同步关闭 Herdr 终端。此操作不可逆。
        </div>

        <div style={{ display: "flex", gap: "10px", "margin-top": "6px" }}>
          <button
            class="touch-target"
            onClick={cancelCloseTabConfirm}
            style={{
              flex: 1,
              height: "44px",
              "border-radius": "10px",
              border: "1.5px solid var(--border)",
              background: "var(--surface)",
              color: "var(--fg)",
              "font-size": "14px",
              "font-weight": 600,
              cursor: "pointer",
            }}
          >
            取消
          </button>
          <button
            class="touch-target"
            onClick={handleConfirm}
            style={{
              flex: 1,
              height: "44px",
              "border-radius": "10px",
              border: "1.5px solid var(--delbg)",
              background: "var(--delbg)",
              color: "#fff",
              "font-size": "14px",
              "font-weight": 600,
              cursor: "pointer",
            }}
          >
            确认关闭
          </button>
        </div>
      </div>
    </Show>
  );
};
