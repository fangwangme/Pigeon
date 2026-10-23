import { Component, For, Show, createSignal, createMemo } from "solid-js";
import {
  state,
  setState,
  getActiveWorkspace,
  getActiveTab,
  toggleTerminalSheet,
} from "../state/store";
import { InteractionCard } from "./InteractionCard";
import { sendPrompt, sendKeys } from "../state/ws";
import type {
  Card,
  DiffCard,
  ThoughtCard,
  ToolCallCard,
  MarkdownCard,
} from "../../types/protocol";

export const CardFeed: Component = () => {
  const [expandedThoughts, setExpandedThoughts] = createSignal<Record<string, boolean>>({});
  const [expandedDiffs, setExpandedDiffs] = createSignal<Record<string, boolean>>({});
  const [showFullTerminalHistory, setShowFullTerminalHistory] = createSignal(false);
  const [copiedNotification, setCopiedNotification] = createSignal(false);

  const toggleThought = (id: string) => {
    setExpandedThoughts((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleDiff = (id: string) => {
    setExpandedDiffs((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const ws = getActiveWorkspace;
  const tab = getActiveTab;

  const getStatusText = () => {
    if (state.pendingInteraction || state.agentStatus === "blocked") return "待确认 · 等待授权";
    if (state.agentStatus === "working") return "工作中 · 正在执行任务";
    if (state.agentStatus === "done") return "已完成 · 等待输入";
    return "就绪 · 等待输入";
  };

  const getStatusDotColor = () => {
    if (state.pendingInteraction || state.agentStatus === "blocked") return "var(--warn)";
    if (state.agentStatus === "working") return "var(--accent)";
    return "var(--faint)";
  };

  // Clean raw screen output: remove empty terminal padding rows
  const cleanedScreenLines = createMemo(() => {
    const raw = state.rawScreen || "";
    if (!raw.trim()) return [];
    const lines = raw.split("\n");
    let start = 0;
    while (start < lines.length && !lines[start].trim()) start++;
    let end = lines.length - 1;
    while (end >= start && !lines[end].trim()) end--;
    if (start > end) return [];
    return lines.slice(start, end + 1);
  });

  const displayedScreenText = createMemo(() => {
    const lines = cleanedScreenLines();
    if (lines.length === 0) return "";
    if (showFullTerminalHistory() || lines.length <= 28) {
      return lines.join("\n");
    }
    // By default show recent 28 lines to avoid vertical clutter
    return lines.slice(-28).join("\n");
  });

  const omittedLineCount = createMemo(() => {
    const total = cleanedScreenLines().length;
    return total > 28 && !showFullTerminalHistory() ? total - 28 : 0;
  });

  const copyScreenToClipboard = async () => {
    const text = cleanedScreenLines().join("\n");
    if (!text) return;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedNotification(true);
      setTimeout(() => setCopiedNotification(false), 2000);
    } catch {}
  };

  // Detect interactive confirmation clues directly in raw terminal screen
  const detectedInteractivePrompt = createMemo(() => {
    const raw = state.rawScreen || "";
    if (state.agentStatus !== "blocked" && !raw.includes("Confirm") && !raw.includes("(y/n)") && !raw.includes("[y/N]")) {
      return null;
    }
    if (raw.includes("Do you trust") || raw.includes("trust this folder")) {
      return {
        question: "确认信任当前工作区文件夹？",
        description: "Agent 请求读取、编辑并在当前目录执行代码的权限。",
        options: [
          { label: "信任并继续 (Enter)", action: () => sendKeys(["enter"]), primary: true },
          { label: "拒绝并退出 (Ctrl+C)", action: () => sendKeys(["ctrl+c"]), primary: false },
        ],
      };
    }
    if (raw.includes("(y/n)") || raw.includes("[y/N]") || raw.includes("[Y/n]")) {
      return {
        question: "需要授权确认 (y/n)",
        description: "终端命令请求执行确认。",
        options: [
          { label: "确认 (y)", action: () => sendKeys(["y", "enter"]), primary: true },
          { label: "拒绝 (n)", action: () => sendKeys(["n", "enter"]), primary: false },
        ],
      };
    }
    return null;
  });

  // Infer agent model or friendly name
  const agentBadgeInfo = createMemo(() => {
    const raw = state.rawScreen || "";
    const activeTab = tab();
    const label = activeTab?.label || "";
    let name = "Agent";
    let model = "";

    if (raw.includes("DeepSeek") || label.toLowerCase().includes("opencode")) {
      name = "OpenCode";
      model = "DeepSeek V4.1 Flash";
    } else if (raw.includes("Antigravity") || raw.includes("Gemini") || label.toLowerCase().includes("agy")) {
      name = "Antigravity";
      model = "Gemini 3.8 Flash";
    } else if (raw.includes("Claude") || label.toLowerCase().includes("claude")) {
      name = "Claude Code";
      model = "Claude 3.7 Sonnet";
    } else {
      name = label || "终端";
    }

    return { name, model };
  });

  return (
    <main
      role="feed"
      aria-label="Agent 交互与卡片流"
      style={{
        flex: 1,
        "min-height": 0,
        "overflow-y": "auto",
        "overflow-x": "hidden",
        "touch-action": "pan-y",
        "overscroll-behavior-x": "none",
        "overscroll-behavior-y": "contain",
        width: "100%",
        "max-width": "100vw",
        "box-sizing": "border-box",
        padding: "12px 12px 24px",
        display: "flex",
        "flex-direction": "column",
        gap: "12px",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      {/* 1. Layered Context & Agent Header Card (层次感与信息结构强化) */}
      <section
        aria-label="当前会话信息"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          "border-radius": "14px",
          padding: "10px 14px",
          display: "flex",
          "flex-direction": "column",
          gap: "8px",
          "box-shadow": "0 2px 8px rgba(0, 0, 0, 0.08)",
          "max-width": "100%",
          "box-sizing": "border-box",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "8px", width: "100%" }}>
          {/* Status Dot with pulse effect */}
          <div
            style={{
              width: "10px",
              height: "10px",
              "border-radius": "5px",
              background: getStatusDotColor(),
              "box-shadow":
                state.agentStatus === "working"
                  ? "0 0 8px var(--accent)"
                  : state.agentStatus === "blocked"
                  ? "0 0 8px var(--warn)"
                  : "none",
              "flex-shrink": 0,
            }}
          />

          {/* Breadcrumb Hierarchy */}
          <div style={{ flex: 1, "min-width": 0, display: "flex", "align-items": "baseline", gap: "6px" }}>
            <span style={{ "font-size": "14px", "font-weight": 700, color: "var(--fg)" }}>
              {ws()?.label || "工作区"}
            </span>
            <span style={{ color: "var(--faint)", "font-size": "12px" }}>›</span>
            <span
              style={{
                "font-size": "13px",
                "font-weight": 600,
                color: "var(--muted)",
                "font-family": "'JetBrains Mono', monospace",
              }}
            >
              Tab {tab()?.label || "1"}
            </span>
            <span style={{ color: "var(--faint)", "font-size": "12px" }}>›</span>
            <span style={{ "font-size": "13px", "font-weight": 600, color: "var(--accent)" }}>
              {agentBadgeInfo().name}
            </span>
          </div>

          {/* View Toggle & Full Terminal Button */}
          <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
            <button
              class="touch-target"
              onClick={toggleTerminalSheet}
              aria-label="展开全屏终端"
              title="切换全屏终端"
              style={{
                height: "32px",
                padding: "0 10px",
                "border-radius": "8px",
                border: "1px solid var(--border)",
                background: "var(--inset)",
                color: "var(--muted)",
                "font-size": "12px",
                display: "flex",
                "align-items": "center",
                gap: "4px",
                cursor: "pointer",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
              <span>终端视窗</span>
            </button>
          </div>
        </div>

        {/* Sub-row: Model info badge and active status description */}
        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px" }}>
          <div style={{ display: "flex", "align-items": "center", gap: "6px", "font-size": "12px", color: "var(--muted)" }}>
            <span style={{ color: getStatusDotColor(), "font-weight": 600 }}>{getStatusText()}</span>
          </div>

          <Show when={agentBadgeInfo().model}>
            <span
              style={{
                "font-size": "11px",
                "font-weight": 600,
                padding: "2px 8px",
                "border-radius": "6px",
                background: "var(--accentbg)",
                color: "var(--accentt)",
                "font-family": "'JetBrains Mono', monospace",
              }}
            >
              {agentBadgeInfo().model}
            </span>
          </Show>
        </div>
      </section>

      {/* 2. Prominent Interactive Confirmation Card (当检测到待确认交互时优先置顶展示) */}
      <Show when={state.pendingInteraction}>
        <InteractionCard data={state.pendingInteraction!} />
      </Show>

      {/* 3. In-Terminal Detected Prompt Elevation (当终端处于授权阻断时提升交互) */}
      <Show when={!state.pendingInteraction && detectedInteractivePrompt()}>
        <section
          aria-label="智能体交互授权请求"
          style={{
            background: "var(--warns)",
            border: "1.5px solid var(--warn)",
            "border-radius": "14px",
            padding: "14px",
            display: "flex",
            "flex-direction": "column",
            gap: "10px",
            "box-shadow": "0 4px 14px rgba(234, 179, 8, 0.15)",
          }}
        >
          <div style={{ display: "flex", "align-items": "center", gap: "8px", color: "var(--warnt)", "font-weight": 700 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span style={{ "font-size": "14px" }}>{detectedInteractivePrompt()!.question}</span>
          </div>
          <div style={{ "font-size": "12px", color: "var(--muted)", "line-height": 1.5 }}>
            {detectedInteractivePrompt()!.description}
          </div>
          <div style={{ display: "grid", "grid-template-columns": "repeat(2, minmax(0, 1fr))", gap: "8px", "margin-top": "4px" }}>
            <For each={detectedInteractivePrompt()!.options}>
              {(opt) => (
                <button
                  class="touch-target"
                  onClick={opt.action}
                  style={{
                    height: "44px",
                    "border-radius": "10px",
                    border: opt.primary ? 0 : "1px solid var(--border)",
                    background: opt.primary ? "var(--warn)" : "var(--surface)",
                    color: opt.primary ? "#fff" : "var(--fg)",
                    "font-size": "13px",
                    "font-weight": 600,
                    cursor: "pointer",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    gap: "6px",
                  }}
                >
                  {opt.label}
                </button>
              )}
            </For>
          </div>
        </section>
      </Show>

      {/* 4. Structured Terminal Window Output (去噪与层次化终端视窗) */}
      <Show when={state.cards.length === 0}>
        <section
          aria-label="终端会话窗口"
          style={{
            background: "var(--code)",
            border: "1px solid var(--codeb)",
            "border-radius": "14px",
            overflow: "hidden",
            display: "flex",
            "flex-direction": "column",
            "box-shadow": "0 4px 16px rgba(0, 0, 0, 0.12)",
            "max-width": "100%",
            "box-sizing": "border-box",
          }}
        >
          {/* macOS Style Terminal Window Header */}
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              padding: "10px 14px",
              background: "var(--surface)",
              "border-bottom": "1px solid var(--border)",
              "font-size": "12px",
            }}
          >
            {/* Window Traffic Dots */}
            <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
              <span style={{ width: "10px", height: "10px", "border-radius": "5px", background: "#FF5F56" }} />
              <span style={{ width: "10px", height: "10px", "border-radius": "5px", background: "#FFBD2E" }} />
              <span style={{ width: "10px", height: "10px", "border-radius": "5px", background: "#27C93F" }} />
            </div>

            <div
              style={{
                flex: 1,
                "text-align": "center",
                color: "var(--muted)",
                "font-size": "12px",
                "font-family": "'JetBrains Mono', monospace",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
              }}
            >
              {tab()?.label || "term"} · {cleanedScreenLines().length} 行
            </div>

            {/* Quick Copy Output Button */}
            <button
              class="touch-target"
              onClick={copyScreenToClipboard}
              aria-label="复制终端输出"
              style={{
                height: "28px",
                padding: "0 8px",
                "border-radius": "6px",
                border: "1px solid var(--border)",
                background: "transparent",
                color: copiedNotification() ? "var(--accent)" : "var(--muted)",
                "font-size": "11px",
                cursor: "pointer",
                display: "flex",
                "align-items": "center",
                gap: "4px",
              }}
            >
              <Show
                when={copiedNotification()}
                fallback={
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    <span>复制</span>
                  </>
                }
              >
                <span>已复制 ✓</span>
              </Show>
            </button>
          </div>

          {/* Omitted History Indicator */}
          <Show when={omittedLineCount() > 0}>
            <div
              onClick={() => setShowFullTerminalHistory(true)}
              style={{
                padding: "8px 14px",
                background: "var(--inset)",
                "border-bottom": "1px solid var(--codeb)",
                "font-size": "11px",
                color: "var(--muted)",
                cursor: "pointer",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                gap: "6px",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
              <span>已折叠上方 {omittedLineCount()} 行历史，点此展开全部</span>
            </div>
          </Show>

          {/* Cleaned Preformatted Content */}
          <pre
            style={{
              margin: 0,
              padding: "12px 14px",
              "font-family": "'JetBrains Mono', ui-monospace, monospace",
              "font-size": "12px",
              "line-height": 1.6,
              color: "var(--codefg)",
              "white-space": "pre-wrap",
              "word-break": "break-word",
              "word-wrap": "break-word",
              "overflow-x": "hidden",
              "max-width": "100%",
              "box-sizing": "border-box",
            }}
          >
            {displayedScreenText() || `Agent [${tab()?.label || "agent"}] 已就绪，请在底栏输入指令并发送。`}
          </pre>
        </section>
      </Show>

      {/* 5. Render Structured Cards when available */}
      <For each={state.cards}>
        {(card: Card) => {
          if (card.kind === "thought") {
            const thought = card as ThoughtCard;
            const isExpanded = () => !!expandedThoughts()[thought.id];
            return (
              <div
                style={{
                  display: "flex",
                  "flex-direction": "column",
                  gap: "6px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  "border-radius": "12px",
                  overflow: "hidden",
                  "box-shadow": "0 2px 6px rgba(0, 0, 0, 0.05)",
                }}
              >
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
                    border: 0,
                    padding: "0 14px",
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
                  <span style={{ flex: 1, "font-weight": 500 }}>{thought.title || "思考过程"}</span>
                  <span style={{ "font-size": "12px", color: "var(--faint)" }}>
                    {isExpanded() ? "收起" : "已折叠"}
                  </span>
                </button>
                <Show when={isExpanded()}>
                  <div
                    style={{
                      padding: "10px 14px 14px",
                      background: "var(--inset)",
                      "border-top": "1px solid var(--border)",
                      "font-size": "13px",
                      "line-height": 1.65,
                      color: "var(--fg)",
                      "white-space": "pre-wrap",
                      "word-break": "break-word",
                      "overflow-x": "hidden",
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
              <div
                style={{
                  display: "flex",
                  "flex-direction": "column",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  "border-radius": "12px",
                  overflow: "hidden",
                  "box-shadow": "0 2px 6px rgba(0, 0, 0, 0.05)",
                }}
              >
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
                    padding: "0 14px",
                    "text-align": "left",
                    background: "transparent",
                    border: 0,
                    color: "var(--muted)",
                    "font-size": "12px",
                    cursor: "pointer",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />
                  </svg>
                  <span style={{ "font-weight": 600 }}>变更</span>
                  <span
                    style={{
                      flex: 1,
                      color: "var(--fg)",
                      "font-family": "'JetBrains Mono', ui-monospace, monospace",
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                    }}
                  >
                    {diffCard.filePath}
                  </span>
                  <Show when={diffCard.additions > 0}>
                    <span style={{ color: "var(--addfg)", "font-weight": 600 }}>+{diffCard.additions}</span>
                  </Show>
                  <Show when={diffCard.deletions > 0}>
                    <span style={{ color: "var(--delfg)", "font-weight": 600 }}>−{diffCard.deletions}</span>
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
                      padding: "10px 14px",
                      background: "var(--code)",
                      "border-top": "1px solid var(--border)",
                      "font-family": "'JetBrains Mono', ui-monospace, monospace",
                      "font-size": "12px",
                      "line-height": 1.6,
                      color: "var(--codefg)",
                      "overflow-x": "hidden",
                      "white-space": "pre-wrap",
                      "word-break": "break-word",
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
                  "border-radius": "12px",
                  overflow: "hidden",
                  "box-shadow": "0 2px 6px rgba(0, 0, 0, 0.05)",
                  "max-width": "100%",
                  "box-sizing": "border-box",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "8px",
                    padding: "8px 12px",
                    background: "var(--surface)",
                    "border-bottom": "1px solid var(--border)",
                    "font-size": "12px",
                    color: "var(--muted)",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 8l4 4-4 4M12 16h7" />
                  </svg>
                  <span style={{ flex: 1, "font-weight": 600 }}>{tool.title || "Bash"}</span>
                  <span style={{ color: tool.status === "running" ? "var(--accent)" : "var(--faint)" }}>
                    {tool.status === "running" ? "执行中..." : `退出码 ${tool.exitCode ?? 0}`}
                  </span>
                </div>
                <div
                  style={{
                    padding: "8px 12px",
                    "font-family": "'JetBrains Mono', ui-monospace, monospace",
                    "font-size": "12px",
                    "line-height": 1.6,
                    color: "var(--codefg)",
                    "overflow-x": "hidden",
                  }}
                >
                  <div style={{ color: "var(--fg)", "font-weight": 600 }}>$ {tool.command}</div>
                  <Show when={tool.output}>
                    <pre
                      style={{
                        margin: "4px 0 0",
                        padding: 0,
                        "font-family": "inherit",
                        "font-size": "inherit",
                        "white-space": "pre-wrap",
                        "word-break": "break-word",
                        color: "var(--muted)",
                        "overflow-x": "hidden",
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
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  "border-radius": "12px",
                  padding: "12px 14px",
                  "font-size": "14px",
                  "line-height": 1.65,
                  color: "var(--fg)",
                  "white-space": "pre-wrap",
                  "word-break": "break-word",
                  "overflow-x": "hidden",
                  "box-shadow": "0 2px 6px rgba(0, 0, 0, 0.05)",
                }}
              >
                {md.content}
              </div>
            );
          }

          return null;
        }}
      </For>

      {/* 6. Active Ghost Suggestion Banner */}
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
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ color: "var(--accent)" }}>
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

      {/* 7. Bottom Status line */}
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
