import { Component, For, Show, createSignal } from "solid-js";
import { state, closeDiffDrawer } from "../state/store";

export const DiffDrawer: Component = () => {
  const [expandedFiles, setExpandedFiles] = createSignal<Record<string, boolean>>({});

  const toggleFile = (path: string) => {
    setExpandedFiles((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const stats = () => state.sessionStats;

  return (
    <Show when={state.diffDrawerOpen}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          "z-index": 1000,
          display: "flex",
          "justify-content": "flex-end",
        }}
      >
        {/* Scrim */}
        <div
          onClick={closeDiffDrawer}
          style={{
            position: "absolute",
            inset: 0,
            background: "var(--scrim, rgba(0, 0, 0, 0.5))",
            "backdrop-filter": "blur(2px)",
          }}
        />

        {/* Drawer Panel */}
        <div
          role="dialog"
          aria-label="代码变更概览"
          style={{
            position: "relative",
            width: "88vw",
            "max-width": "420px",
            height: "100%",
            background: "var(--surface)",
            color: "var(--fg)",
            display: "flex",
            "flex-direction": "column",
            "box-shadow": "-4px 0 20px rgba(0, 0, 0, 0.25)",
            "z-index": 1001,
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "16px",
              "border-bottom": "1px solid var(--border)",
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
            }}
          >
            <div>
              <div style={{ "font-size": "16px", "font-weight": 650 }}>
                代码变更 Diff
              </div>
              <Show when={stats()}>
                <div
                  style={{
                    "font-size": "12px",
                    color: "var(--muted)",
                    "margin-top": "2px",
                    display: "flex",
                    gap: "8px",
                  }}
                >
                  <span>{stats()!.filesModified} 个文件变更</span>
                  <span style={{ color: "var(--addfg, #3fb950)" }}>
                    +{stats()!.additions}
                  </span>
                  <span style={{ color: "var(--delfg, #f85149)" }}>
                    -{stats()!.deletions}
                  </span>
                </div>
              </Show>
            </div>

            <button
              aria-label="关闭"
              class="touch-target"
              onClick={closeDiffDrawer}
              style={{
                width: "44px",
                height: "44px",
                border: 0,
                background: "transparent",
                color: "var(--muted)",
                cursor: "pointer",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Files List */}
          <div
            class="pigeon-scroll"
            style={{
              flex: 1,
              "overflow-y": "auto",
              padding: "12px",
              display: "flex",
              "flex-direction": "column",
              gap: "10px",
            }}
          >
            <Show
              when={stats()?.diffs && stats()!.diffs!.length > 0}
              fallback={
                <div style={{ padding: "30px 10px", "text-align": "center", color: "var(--faint)" }}>
                  本次会话暂无文件变更记录
                </div>
              }
            >
              <For each={stats()?.diffs || []}>
                {(diff) => {
                  const isExpanded = () => !!expandedFiles()[diff.filePath];
                  return (
                    <div
                      style={{
                        border: "1px solid var(--border)",
                        "border-radius": "8px",
                        background: "var(--inset)",
                        overflow: "hidden",
                      }}
                    >
                      <button
                        class="touch-target"
                        onClick={() => toggleFile(diff.filePath)}
                        style={{
                          width: "100%",
                          padding: "10px 12px",
                          border: 0,
                          background: "transparent",
                          color: "var(--fg)",
                          display: "flex",
                          "align-items": "center",
                          "justify-content": "space-between",
                          cursor: "pointer",
                          "text-align": "left",
                          gap: "8px",
                        }}
                      >
                        <div style={{ flex: 1, "min-width": 0 }}>
                          <div
                            style={{
                              "font-size": "13px",
                              "font-weight": 600,
                              "font-family": "monospace",
                              overflow: "hidden",
                              "text-overflow": "ellipsis",
                              "white-space": "nowrap",
                            }}
                          >
                            {diff.filePath}
                          </div>
                          <div
                            style={{
                              "font-size": "11px",
                              color: "var(--muted)",
                              "margin-top": "2px",
                              display: "flex",
                              gap: "6px",
                            }}
                          >
                            <span style={{ color: "var(--addfg, #3fb950)" }}>
                              +{diff.additions}
                            </span>
                            <span style={{ color: "var(--delfg, #f85149)" }}>
                              -{diff.deletions}
                            </span>
                          </div>
                        </div>
                        <span style={{ "font-size": "12px", color: "var(--faint)" }}>
                          {isExpanded() ? "▲" : "▼"}
                        </span>
                      </button>

                      <Show when={isExpanded() && diff.patch}>
                        <div
                          style={{
                            "border-top": "1px solid var(--border)",
                            background: "var(--code)",
                            padding: "8px",
                            "font-size": "11px",
                            "font-family": "monospace",
                            "overflow-x": "auto",
                            "white-space": "pre",
                            "line-height": 1.4,
                          }}
                        >
                          <For each={diff.patch!.split("\n")}>
                            {(line) => {
                              const isAdd = line.startsWith("+");
                              const isDel = line.startsWith("-");
                              return (
                                <div
                                  style={{
                                    color: isAdd
                                      ? "var(--addfg, #3fb950)"
                                      : isDel
                                      ? "var(--delfg, #f85149)"
                                      : "var(--codefg)",
                                    background: isAdd
                                      ? "var(--addbg, rgba(63, 185, 80, 0.15))"
                                      : isDel
                                      ? "var(--delbg, rgba(248, 81, 73, 0.15))"
                                      : "transparent",
                                    padding: "1px 4px",
                                  }}
                                >
                                  {line}
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};
