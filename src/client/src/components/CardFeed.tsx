import { Component, For, Show, createSignal } from "solid-js";
import { state, setState, getActiveWorkspace, getActiveTab, toggleTerminalSheet } from "../state/store";
import { InteractionCard } from "./InteractionCard";
import { sendPrompt } from "../state/ws";
import type { Card, DiffCard, ThoughtCard, ToolCallCard, MarkdownCard } from "../../types/protocol";

export const CardFeed: Component = () => {
  const [expandedThoughts, setExpandedThoughts] = createSignal<Record<string, boolean>>({});
  const [expandedDiffs, setExpandedDiffs] = createSignal<Record<string, boolean>>({});

  const toggleThought = (id: string) => {
    setExpandedThoughts((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleDiff = (id: string) => {
    setExpandedDiffs((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const getStatusText = () => {
    if (state.pendingInteraction) return "待确认 · 等待授权";
    if (state.agentStatus === "working") return "工作中 · 正在执行任务";
    if (state.agentStatus === "done") return "已完成 · 等待你的输入";
    return "空闲 · 等待你的输入";
  };

  const getStatusDotColor = () => {
    if (state.pendingInteraction || state.agentStatus === "blocked") return "var(--warn)";
    if (state.agentStatus === "working") return "var(--accent)";
    return "var(--faint)";
  };

  const ws = getActiveWorkspace;
  const tab = getActiveTab;

  return (
    <main
      style={{
        flex: 1,
        "min-height": 0,
        "overflow-y": "auto",
        "-webkit-overflow-scrolling": "touch",
        padding: "16px 12px",
        display: "flex",
        "flex-direction": "column",
        gap: "12px",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      {/* Workspace & Tab Context Info Banner */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "8px",
          "font-size": "12px",
          color: "var(--faint)",
          padding: "0 4px",
        }}
      >
        <span style={{ flex: 1, height: "1px", background: "var(--line)" }} />
        <span>
          {ws()?.label || "工作区"} ·{" "}
          <code style={{ "font-family": "'JetBrains Mono', monospace", color: "var(--muted)" }}>
            {tab()?.label || "tab"}
          </code>
        </span>
        <span style={{ flex: 1, height: "1px", background: "var(--line)" }} />
      </div>

      {/* When no cards are present, display the terminal output screen */}
      <Show when={state.cards.length === 0}>
        <div
          style={{
            background: "var(--code)",
            border: "1px solid var(--codeb)",
            "border-radius": "10px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              padding: "8px 12px",
              "border-bottom": "1px solid var(--codeb)",
              "font-size": "12px",
              color: "var(--muted)",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M5 8l4 4-4 4M12 16h7" />
            </svg>
            <span style={{ flex: 1 }}>{tab()?.label || "Terminal"}</span>
            <span style={{ color: "var(--faint)" }}>
              {state.agentStatus === "working"
                ? "工作中"
                : state.agentStatus === "blocked"
                ? "待确认"
                : "就绪"}
            </span>
          </div>
          <pre
            style={{
              margin: 0,
              padding: "10px 12px",
              "font-family": "'JetBrains Mono', ui-monospace, monospace",
              "font-size": "12px",
              "line-height": 1.7,
              color: "var(--codefg)",
              "white-space": "pre-wrap",
              "word-break": "break-all",
            }}
          >
            {state.rawScreen || `Agent [${tab()?.label || "agent"}] 已就绪，等待输入指令...`}
          </pre>
        </div>
      </Show>

      <For each={state.cards}>
        {(card: Card) => {
          if (card.kind === "thought") {
            const thought = card as ThoughtCard;
            const isExpanded = () => !!expandedThoughts()[thought.id];
            return (
              <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                <button
                  class="touch-target"
                  onClick={() => toggleThought(thought.id)}
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "8px",
                    width: "100%",
                    "min-height": "44px",
                    "text-align": "left",
                    background: "transparent",
                    border: "1px solid var(--codeb)",
                    "border-radius": "10px",
                    padding: "0 12px",
                    color: "var(--muted)",
                    "font-size": "13px",
                    cursor: "pointer",
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
                    style={{
                      transform: isExpanded() ? "rotate(90deg)" : "none",
                      transition: "transform 0.15s ease",
                    }}
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                  <span style={{ flex: 1 }}>{thought.title || "思考过程"}</span>
                  <span style={{ "font-size": "12px", color: "var(--faint)" }}>
                    {isExpanded() ? "收起" : "已折叠"}
                  </span>
                </button>
                <Show when={isExpanded()}>
                  <div
                    style={{
                      padding: "10px 12px",
                      background: "var(--inset)",
                      border: "1px solid var(--codeb)",
                      "border-radius": "10px",
                      "font-size": "13px",
                      "line-height": 1.6,
                      color: "var(--muted)",
                      "white-space": "pre-wrap",
                    }}
                  >
                    {thought.body}
                  </div>
                </Show>
              </div>
            );
          }

          if (card.kind === "diff") {
            const diffCard = card as DiffCard;
            const isExpanded = () => !!expandedDiffs()[diffCard.id];
            return (
              <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                <button
                  aria-expanded={isExpanded()}
                  class="touch-target"
                  onClick={() => toggleDiff(diffCard.id)}
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "8px",
                    width: "100%",
                    "min-height": "44px",
                    padding: "0 12px",
                    "text-align": "left",
                    background: "var(--code)",
                    border: "1px solid var(--codeb)",
                    "border-radius": "10px",
                    color: "var(--muted)",
                    "font-size": "12px",
                    cursor: "pointer",
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />
                  </svg>
                  <span>编辑</span>
                  <span
                    style={{
                      flex: 1,
                      color: "var(--fg)",
                      "font-family": "'JetBrains Mono', ui-monospace, monospace",
                    }}
                  >
                    {diffCard.filePath}
                  </span>
                  <Show when={diffCard.additions > 0}>
                    <span style={{ color: "var(--addfg)" }}>+{diffCard.additions}</span>
                  </Show>
                  <Show when={diffCard.deletions > 0}>
                    <span style={{ color: "var(--delfg)" }}>−{diffCard.deletions}</span>
                  </Show>
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
                    style={{
                      transform: isExpanded() ? "rotate(180deg)" : "none",
                      transition: "transform 0.15s ease",
                    }}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                <Show when={isExpanded()}>
                  <pre
                    style={{
                      margin: 0,
                      padding: "10px 12px",
                      background: "var(--code)",
                      border: "1px solid var(--codeb)",
                      "border-radius": "10px",
                      "font-family": "'JetBrains Mono', ui-monospace, monospace",
                      "font-size": "12px",
                      "line-height": 1.6,
                      color: "var(--codefg)",
                      "overflow-x": "auto",
                      "white-space": "pre",
                    }}
                  >
                    {diffCard.diff}
                  </pre>
                </Show>
              </div>
            );
          }

          if (card.kind === "tool_call") {
            const tool = card as ToolCallCard;
            return (
              <div
                style={{
                  background: "var(--code)",
                  border: "1px solid var(--codeb)",
                  "border-radius": "10px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "8px",
                    padding: "8px 12px",
                    "border-bottom": "1px solid var(--codeb)",
                    "font-size": "12px",
                    color: "var(--muted)",
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M5 8l4 4-4 4M12 16h7" />
                  </svg>
                  <span style={{ flex: 1 }}>{tool.title || "Bash"}</span>
                  <span style={{ color: "var(--faint)" }}>
                    {tool.status === "running"
                      ? "运行中..."
                      : `退出码 ${tool.exitCode ?? 0}`}
                  </span>
                </div>
                <div
                  style={{
                    padding: "8px 12px",
                    "font-family": "'JetBrains Mono', ui-monospace, monospace",
                    "font-size": "12px",
                    "line-height": 1.7,
                    color: "var(--codefg)",
                  }}
                >
                  <div style={{ color: "var(--fg)", "font-weight": 500 }}>$ {tool.command}</div>
                  <Show when={tool.output}>
                    <pre
                      style={{
                        margin: "4px 0 0",
                        padding: 0,
                        "font-family": "inherit",
                        "font-size": "inherit",
                        "white-space": "pre-wrap",
                        "word-break": "break-all",
                        color: "var(--muted)",
                      }}
                    >
                      {tool.output}
                    </pre>
                  </Show>
                </div>
              </div>
            );
          }

          if (card.kind === "markdown") {
            const md = card as MarkdownCard;
            return (
              <div
                style={{
                  "font-size": "14px",
                  "line-height": 1.65,
                  color: "var(--fg)",
                  "white-space": "pre-wrap",
                }}
              >
                {md.content}
              </div>
            );
          }

          return null;
        }}
      </For>

      {/* Inline Interaction Prompt Card if blocked */}
      <Show when={state.pendingInteraction}>
        <InteractionCard data={state.pendingInteraction!} />
      </Show>

      {/* Ghost suggestion banner */}
      <Show when={state.activeGhost}>
        <section
          aria-label="预测指令"
          style={{
            "flex-shrink": 0,
            padding: "6px 6px 6px 12px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            "border-radius": "12px",
            display: "flex",
            "align-items": "center",
            gap: "10px",
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
            style={{ color: "var(--accent)" }}
          >
            <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
          </svg>
          <div style={{ flex: 1, "min-width": 0 }}>
            <div style={{ "font-size": "11px", color: "var(--muted)" }}>预测指令</div>
            <div
              style={{
                "font-family": "'JetBrains Mono', ui-monospace, monospace",
                "font-size": "13px",
                "white-space": "nowrap",
                overflow: "hidden",
                "text-overflow": "ellipsis",
              }}
            >
              {state.activeGhost!.suggestion}
            </div>
          </div>
          <button
            class="touch-target"
            onClick={() => {
              const el = document.getElementById("pigeon-input") as HTMLTextAreaElement | null;
              if (el) {
                el.value = state.activeGhost!.suggestion;
                el.focus();
              }
            }}
            style={{
              height: "44px",
              padding: "0 12px",
              "border-radius": "10px",
              border: "1px solid var(--selb)",
              background: "transparent",
              color: "var(--fg)",
              "font-size": "13px",
              "font-weight": 500,
              cursor: "pointer",
            }}
          >
            填入
          </button>
          <button
            class="touch-target"
            onClick={() => {
              if (state.activeGhost) {
                sendPrompt(state.activeGhost.suggestion);
                setState("activeGhost", null);
              }
            }}
            style={{
              height: "44px",
              padding: "0 14px",
              "border-radius": "10px",
              border: 0,
              background: "var(--accent)",
              color: "var(--onaccent)",
              "font-size": "13px",
              "font-weight": 600,
              cursor: "pointer",
            }}
          >
            {state.activeGhost!.actionText || "执行"}
          </button>
        </section>
      </Show>

      {/* Bottom Status line */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "8px",
          "font-size": "12px",
          color: "var(--faint)",
          padding: "4px 0",
        }}
      >
        <span
          style={{
            width: "7px",
            height: "7px",
            "border-radius": "4px",
            background: getStatusDotColor(),
          }}
        />
        {getStatusText()}
      </div>
    </main>
  );
};
