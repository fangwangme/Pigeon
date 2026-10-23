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
  NormalizedTurn,
  NormalizedToolCall,
} from "../../types/protocol";

export const CardFeed: Component = () => {
  const [expandedThoughts, setExpandedThoughts] = createSignal<Record<string, boolean>>({});
  const [expandedDiffs, setExpandedDiffs] = createSignal<Record<string, boolean>>({});
  const [expandedTools, setExpandedTools] = createSignal<Record<string, boolean>>({});
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

  // Clean raw screen output: remove terminal padding, strip ASCII banner art & clamp rules
  const cleanedScreenLines = createMemo(() => {
    const raw = state.rawScreen || "";
    if (!raw.trim()) return [];
    const lines = raw.split("\n");

    // 1. Process and clean each line: filter pure block banners, strip decorative side logos
    const processedLines: string[] = [];
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        processedLines.push("");
        continue;
      }

      const blockChars = (trimmed.match(/[\u2580-\u259F\u25A0-\u25FF]/g) || []).length;
      const words = trimmed.match(/[a-zA-Z0-9_\u4e00-\u9fa5]{3,}/g) || [];

      // If line is pure block/box drawing art with no meaningful words, drop it
      if (blockChars > 0 && words.length === 0) {
        continue;
      }

      // If line has block characters mixed with text (e.g. Antigravity ASCII logo beside text), strip the logo
      let cleaned = trimmed;
      if (blockChars > 0) {
        cleaned = trimmed.replace(/^[\s\u2580-\u259F\u25A0-\u25FF╹╻]+/, "").trim();
      }

      processedLines.push(cleaned);
    }

    // 2. Normalize, dedent and clamp horizontal divider rules
    const clampedLines: string[] = [];
    let prevWasDivider = false;
    let prevWasEmpty = false;

    for (const line of processedLines) {
      const trimmed = line.trimEnd();
      const isDivider = /^[─━\-_=~]{4,}$/.test(trimmed.trim());
      const isEmpty = trimmed.trim().length === 0;

      if (isDivider) {
        if (!prevWasDivider) {
          // Clamp divider to 28 characters so it never wraps on any mobile screen!
          clampedLines.push("────────────────────────────");
          prevWasDivider = true;
          prevWasEmpty = false;
        }
      } else if (isEmpty) {
        if (!prevWasEmpty && clampedLines.length > 0) {
          clampedLines.push("");
          prevWasEmpty = true;
          prevWasDivider = false;
        }
      } else {
        clampedLines.push(trimmed);
        prevWasDivider = false;
        prevWasEmpty = false;
      }
    }

    // Trim leading and trailing empty lines
    let start = 0;
    while (start < clampedLines.length && !clampedLines[start].trim()) start++;
    let end = clampedLines.length - 1;
    while (end >= start && !clampedLines[end].trim()) end--;
    if (start > end) return [];
    return clampedLines.slice(start, end + 1);
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
    const primaryPane = activeTab?.panes?.[0];
    const paneAgent = primaryPane?.agent?.toLowerCase() || "";
    const paneName = primaryPane?.name?.toLowerCase() || "";
    const label = (activeTab?.label || "").toLowerCase();

    let name = "Agent";
    let model = "";

    if (paneAgent === "opencode" || paneName.includes("opencode") || label.includes("opencode") || raw.includes("DeepSeek") || raw.includes("OpenCode")) {
      name = "OpenCode";
      model = "DeepSeek V4.1 Flash";
    } else if (paneAgent === "agy" || paneName.includes("agy") || label.includes("agy") || raw.includes("Antigravity") || raw.includes("Gemini")) {
      name = "Antigravity";
      model = "Gemini 3.8 Flash";
    } else if (paneAgent === "claude" || paneName.includes("claude") || label.includes("claude") || raw.includes("Claude")) {
      name = "Claude Code";
      model = "Claude 3.7 Sonnet";
    } else {
      name = activeTab?.label || "终端";
    }

    return { name, model };
  });

  return (
    <main
      class="pigeon-feed"
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
        padding: "10px 12px 18px",
        display: "flex",
        "flex-direction": "column",
        gap: "10px",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      {/* 1. Compact session strip: workspace › tab › agent, status, model */}
      <section
        aria-label="当前会话信息"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          "border-radius": "14px",
          padding: "9px 12px",
          display: "flex",
          "flex-direction": "column",
          gap: "6px",
          "box-shadow": "0 1px 2px rgba(0, 0, 0, 0.06)",
          "max-width": "100%",
          "box-sizing": "border-box",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "7px", width: "100%" }}>
          <div
            style={{
              width: "8px",
              height: "8px",
              "border-radius": "4px",
              background: getStatusDotColor(),
              "box-shadow":
                state.agentStatus === "working"
                  ? "0 0 6px var(--accent)"
                  : state.agentStatus === "blocked"
                  ? "0 0 6px var(--warn)"
                  : "none",
              "flex-shrink": 0,
            }}
          />

          {/* Breadcrumb hierarchy, single line with graceful truncation */}
          <div
            style={{
              flex: 1,
              "min-width": 0,
              display: "flex",
              "align-items": "baseline",
              gap: "5px",
              overflow: "hidden",
              "white-space": "nowrap",
            }}
          >
            <span
              style={{
                "font-size": "13.5px",
                "font-weight": 650,
                color: "var(--fg)",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "flex-shrink": 1,
              }}
            >
              {ws()?.label || "工作区"}
            </span>
            <span style={{ color: "var(--faint)", "font-size": "11px", "flex-shrink": 0 }}>›</span>
            <span
              style={{
                "font-size": "12px",
                "font-weight": 600,
                color: "var(--muted)",
                "font-family": "'JetBrains Mono', ui-monospace, monospace",
                "flex-shrink": 0,
              }}
            >
              {tab()?.label || "Tab 1"}
            </span>
            <span style={{ color: "var(--faint)", "font-size": "11px", "flex-shrink": 0 }}>›</span>
            <span
              style={{
                "font-size": "12.5px",
                "font-weight": 600,
                color: "var(--accent)",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "flex-shrink": 1,
              }}
            >
              {agentBadgeInfo().name}
            </span>
          </div>

          <button
            class="touch-target"
            onClick={toggleTerminalSheet}
            aria-label="展开终端输出"
            title="展开终端输出"
            style={{
              width: "32px",
              height: "32px",
              padding: 0,
              "border-radius": "9px",
              border: "1px solid var(--border)",
              background: "var(--inset)",
              color: "var(--muted)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              cursor: "pointer",
              "flex-shrink": 0,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>

        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px", "min-width": 0 }}>
          <span
            style={{
              "font-size": "11.5px",
              "font-weight": 500,
              color: "var(--muted)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            <span style={{ color: getStatusDotColor(), "font-weight": 650 }}>{getStatusText()}</span>
          </span>

          <Show when={agentBadgeInfo().model}>
            <span
              style={{
                "font-size": "10.5px",
                "font-weight": 600,
                padding: "2px 7px",
                "border-radius": "6px",
                background: "var(--accentbg)",
                color: "var(--accentt)",
                "font-family": "'JetBrains Mono', ui-monospace, monospace",
                "white-space": "nowrap",
                "flex-shrink": 0,
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

      {/* 4. Terminal output: full panel when there are no cards or turns, compact strip otherwise */}
      <Show
        when={state.normalizedTurns.length === 0 && state.cards.length === 0}
        fallback={
          <button
            class="touch-target"
            onClick={toggleTerminalSheet}
            aria-label="查看完整终端输出"
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              width: "100%",
              padding: "10px 12px",
              "border-radius": "12px",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--muted)",
              "font-size": "11.5px",
              "text-align": "left",
              cursor: "pointer",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "flex-shrink": 0 }}>
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span style={{ "font-weight": 600, color: "var(--fg)", "flex-shrink": 0 }}>终端</span>
            <span
              style={{
                flex: 1,
                "min-width": 0,
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
                "font-family": "'JetBrains Mono', ui-monospace, monospace",
                opacity: 0.85,
              }}
            >
              {cleanedScreenLines().slice(-1)[0]?.trim() || "暂无输出"}
            </span>
            <span style={{ "flex-shrink": 0, color: "var(--faint)" }}>
              {cleanedScreenLines().length} 行 ›
            </span>
          </button>
        }
      >
        <section
          aria-label="终端会话窗口"
          style={{
            background: "var(--code)",
            border: "1px solid var(--codeb)",
            "border-radius": "14px",
            overflow: "hidden",
            display: "flex",
            "flex-direction": "column",
            "box-shadow": "0 1px 2px rgba(0, 0, 0, 0.08)",
            "max-width": "100%",
            "box-sizing": "border-box",
          }}
        >
          {/* Terminal panel header */}
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              padding: "8px 10px 8px 12px",
              background: "var(--surface)",
              "border-bottom": "1px solid var(--border)",
              "font-size": "12px",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ color: "var(--muted)", "flex-shrink": 0 }}>
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span style={{ "font-weight": 600, color: "var(--fg)" }}>终端</span>
            <span
              style={{
                flex: 1,
                "min-width": 0,
                color: "var(--faint)",
                "font-size": "11px",
                "font-family": "'JetBrains Mono', ui-monospace, monospace",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
              }}
            >
              {tab()?.label || "term"} · {cleanedScreenLines().length} 行
            </span>

            <button
              class="touch-target"
              onClick={copyScreenToClipboard}
              aria-label="复制终端输出"
              title="复制终端输出"
              style={{
                height: "28px",
                padding: "0 8px",
                "border-radius": "7px",
                border: "1px solid var(--border)",
                background: "transparent",
                color: copiedNotification() ? "var(--accent)" : "var(--muted)",
                "font-size": "11px",
                cursor: "pointer",
                display: "flex",
                "align-items": "center",
                gap: "4px",
                "flex-shrink": 0,
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

            <button
              class="touch-target"
              onClick={toggleTerminalSheet}
              aria-label="全屏查看终端"
              title="全屏查看终端"
              style={{
                height: "28px",
                width: "28px",
                padding: 0,
                "border-radius": "7px",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--muted)",
                cursor: "pointer",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                "flex-shrink": 0,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          </div>

          {/* Omitted History Indicator */}
          <Show when={omittedLineCount() > 0}>
            <div
              onClick={() => setShowFullTerminalHistory(true)}
              style={{
                padding: "8px 12px",
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

          {/* Cleaned preformatted content */}
          <pre
            style={{
              margin: 0,
              padding: "12px 12px 14px",
              "font-family": "'JetBrains Mono', ui-monospace, monospace",
              "font-size": "12px",
              "line-height": 1.55,
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

      {/* 5. Render Structured Normalized Turns when available */}
      <Show when={state.normalizedTurns && state.normalizedTurns.length > 0}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "14px", width: "100%" }}>
          <For each={state.normalizedTurns}>
            {(turn: NormalizedTurn) => {
              const isThoughtExpanded = () => !!expandedThoughts()[turn.turnId];
              return (
                <article
                  style={{
                    display: "flex",
                    "flex-direction": "column",
                    gap: "8px",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    "border-radius": "14px",
                    padding: "12px",
                    "box-shadow": "0 1px 3px rgba(0, 0, 0, 0.05)",
                    width: "100%",
                    "box-sizing": "border-box",
                  }}
                >
                  {/* Turn header */}
                  <div
                    style={{
                      display: "flex",
                      "justify-content": "space-between",
                      "align-items": "center",
                      "font-size": "11.5px",
                      color: "var(--muted)",
                    }}
                  >
                    <span style={{ "font-weight": 600 }}>回合 #{turn.turnNumber}</span>
                    <span>
                      {new Date(turn.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>

                  {/* User Prompt */}
                  <Show when={turn.userPrompt?.text}>
                    <div
                      style={{
                        background: "var(--inset)",
                        "border-radius": "10px",
                        padding: "10px 12px",
                        "font-size": "14px",
                        "font-weight": 500,
                        color: "var(--fg)",
                        "white-space": "pre-wrap",
                        "word-break": "break-word",
                      }}
                    >
                      {turn.userPrompt!.text}
                    </div>
                  </Show>

                  {/* Thinking / Reasoning Accordion */}
                  <Show when={turn.reasoning?.text}>
                    <div
                      style={{
                        border: "1px solid var(--border)",
                        "border-radius": "10px",
                        background: "var(--bg)",
                        overflow: "hidden",
                      }}
                    >
                      <button
                        class="touch-target"
                        onClick={() => toggleThought(turn.turnId)}
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "8px",
                          width: "100%",
                          padding: "8px 12px",
                          background: "transparent",
                          border: 0,
                          color: "var(--muted)",
                          "font-size": "12px",
                          cursor: "pointer",
                          "text-align": "left",
                        }}
                      >
                        <span>{isThoughtExpanded() ? "▾" : "▸"}</span>
                        <span style={{ flex: 1, "font-weight": 500 }}>
                          Thought {turn.reasoning?.durationMs ? `for ${Math.round(turn.reasoning.durationMs / 1000)}s` : ""}
                          {turn.reasoning?.tokens ? ` (${turn.reasoning.tokens} tokens)` : ""}
                        </span>
                        <span style={{ "font-size": "11px", color: "var(--faint)" }}>
                          {isThoughtExpanded() ? "收起" : "展开"}
                        </span>
                      </button>
                      <Show when={isThoughtExpanded()}>
                        <div
                          style={{
                            padding: "8px 12px 12px",
                            "border-top": "1px solid var(--border)",
                            "border-left": "3px solid var(--accent)",
                            "font-size": "12.5px",
                            "line-height": 1.6,
                            color: "var(--muted)",
                            "white-space": "pre-wrap",
                            "word-break": "break-word",
                          }}
                        >
                          {turn.reasoning!.text}
                        </div>
                      </Show>
                    </div>
                  </Show>

                  {/* Tool Calls */}
                  <For each={turn.toolCalls || []}>
                    {(tc: NormalizedToolCall) => {
                      const isToolExpanded = () => !!expandedTools()[tc.id];
                      const lines = () => (tc.output || "").split("\n");
                      const isLong = () => lines().length > 5;
                      const cmdText = () =>
                        typeof tc.input === "string"
                          ? tc.input
                          : (tc.input as any)?.CommandLine ||
                            (tc.input as any)?.command ||
                            (tc.input as any)?.path ||
                            JSON.stringify(tc.input);

                      return (
                        <div
                          style={{
                            border: "1px solid var(--border)",
                            "border-radius": "10px",
                            background: "var(--inset)",
                            padding: "8px 10px",
                            display: "flex",
                            "flex-direction": "column",
                            gap: "6px",
                          }}
                        >
                          <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                            <span style={{ "font-weight": 600, "font-family": "monospace", "font-size": "12px", color: "var(--fg)" }}>
                              {tc.status === "completed" ? "✓" : tc.status === "failed" ? "✗" : "⟳"} {tc.name}
                            </span>
                            <Show when={tc.exitCode !== undefined}>
                              <span style={{ "font-size": "11px", color: tc.exitCode === 0 ? "var(--accent)" : "var(--warn)" }}>
                                exit {tc.exitCode}
                              </span>
                            </Show>
                          </div>

                          <div
                            style={{
                              "font-family": "'JetBrains Mono', ui-monospace, monospace",
                              "font-size": "11.5px",
                              background: "var(--code)",
                              padding: "4px 8px",
                              "border-radius": "6px",
                              overflow: "auto",
                              "white-space": "nowrap",
                            }}
                          >
                            $ {cmdText()}
                          </div>

                          <Show when={tc.output}>
                            <div style={{ position: "relative" }}>
                              <pre
                                style={{
                                  "font-family": "'JetBrains Mono', ui-monospace, monospace",
                                  "font-size": "11px",
                                  background: "var(--code)",
                                  padding: "6px 8px",
                                  "border-radius": "6px",
                                  "max-height": isToolExpanded() ? "none" : "90px",
                                  overflow: isToolExpanded() ? "auto" : "hidden",
                                  "white-space": "pre-wrap",
                                  "word-break": "break-all",
                                  "line-height": 1.45,
                                }}
                              >
                                {tc.output}
                              </pre>
                              <Show when={isLong()}>
                                <button
                                  class="touch-target"
                                  onClick={() => setExpandedTools((prev) => ({ ...prev, [tc.id]: !prev[tc.id] }))}
                                  style={{
                                    height: "30px",
                                    width: "100%",
                                    "font-size": "11px",
                                    color: "var(--accent)",
                                    background: "transparent",
                                    border: 0,
                                    cursor: "pointer",
                                    display: "flex",
                                    "align-items": "center",
                                    "justify-content": "center",
                                  }}
                                >
                                  {isToolExpanded() ? "收起输出 ▲" : `展开输出 (${lines().length} 行) ▼`}
                                </button>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      );
                    }}
                  </For>

                  {/* Assistant Response with Table Horizontal Overflow Protection */}
                  <Show when={turn.assistantResponse?.markdown}>
                    <div
                      class="markdown-body"
                      style={{
                        padding: "10px 0 4px",
                        "font-size": "13.5px",
                        "line-height": 1.6,
                        color: "var(--fg)",
                        "overflow-x": "hidden",
                      }}
                    >
                      <div style={{ "white-space": "pre-wrap" }}>
                        {turn.assistantResponse!.markdown}
                      </div>
                    </div>
                  </Show>
                </article>
              );
            }}
          </For>
        </div>
      </Show>

      {/* 6. Render Structured Cards when available */}
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
            const outputLines = () => (tool.output || "").split("\n").filter((l) => l.trim().length > 0);
            const isLongOutput = () => outputLines().length > 5;
            const isExpanded = () => !!expandedTools()[tool.id];
            const shownOutput = () => {
              const lines = outputLines();
              if (isExpanded() || !isLongOutput()) return lines.join("\n");
              return lines.slice(0, 5).join("\n");
            };
            const toggle = () =>
              setExpandedTools((prev) => ({ ...prev, [tool.id]: !prev[tool.id] }));

            return (
              <div
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  "border-radius": "12px",
                  overflow: "hidden",
                  "max-width": "100%",
                  "box-sizing": "border-box",
                }}
              >
                {/* Tool header: name + exit status */}
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "7px",
                    padding: "8px 12px 6px",
                    "font-size": "12px",
                    color: "var(--muted)",
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ "flex-shrink": 0 }}>
                    <path d="M5 8l4 4-4 4M12 16h7" />
                  </svg>
                  <span
                    style={{
                      flex: 1,
                      "min-width": 0,
                      "font-weight": 650,
                      color: "var(--fg)",
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                    }}
                  >
                    {tool.title || "Command"}
                  </span>
                  <span
                    style={{
                      "flex-shrink": 0,
                      "font-size": "10.5px",
                      "font-weight": 600,
                      color: tool.status === "running" ? "var(--accentt)" : tool.exitCode ? "var(--delfg)" : "var(--faint)",
                      background: tool.status === "running" ? "var(--accentbg)" : "transparent",
                      padding: tool.status === "running" ? "1px 6px" : 0,
                      "border-radius": "4px",
                    }}
                  >
                    {tool.status === "running" ? "执行中" : tool.exitCode ? `退出码 ${tool.exitCode}` : "完成"}
                  </span>
                </div>

                {/* Command */}
                <div
                  style={{
                    padding: "0 12px 10px",
                    "font-family": "'JetBrains Mono', ui-monospace, monospace",
                    "font-size": "12px",
                    "line-height": 1.5,
                    color: "var(--codefg)",
                    "overflow-x": "hidden",
                  }}
                >
                  <div style={{ "word-break": "break-word", "white-space": "pre-wrap" }}>
                    <span style={{ color: "var(--faint)", "user-select": "none" }}>$ </span>
                    {tool.command}
                  </div>

                  <Show when={shownOutput()}>
                    <pre
                      style={{
                        margin: "6px 0 0",
                        padding: "7px 9px",
                        background: "var(--code)",
                        border: "1px solid var(--codeb)",
                        "border-radius": "8px",
                        "font-family": "inherit",
                        "font-size": "11.5px",
                        "line-height": 1.5,
                        "white-space": "pre-wrap",
                        "word-break": "break-word",
                        color: "var(--muted)",
                        "overflow-x": "hidden",
                      }}
                    >
                      {shownOutput()}
                    </pre>
                  </Show>

                  <Show when={isLongOutput()}>
                    <button
                      onClick={toggle}
                      aria-expanded={isExpanded()}
                      style={{
                        margin: "6px 0 0",
                        padding: "5px 9px",
                        "border-radius": "7px",
                        border: "1px solid var(--border)",
                        background: "transparent",
                        color: "var(--muted)",
                        "font-size": "11px",
                        cursor: "pointer",
                      }}
                    >
                      {isExpanded() ? "收起输出" : `展开 ${outputLines().length - 5} 行输出`}
                    </button>
                  </Show>
                </div>
              </div>
            );
          }

          if (card.kind === "markdown") {
            const md = card as MarkdownCard;
            const cleanedContent = (md.content || "")
              .split("\n")
              .filter((l) => {
                const t = l.trim();
                if (!t) return false;
                const blockChars = (t.match(/[\u2580-\u259F\u25A0-\u25FF]/g) || []).length;
                const words = t.match(/[a-zA-Z0-9_\u4e00-\u9fa5]{3,}/g) || [];
                return !(blockChars > 0 && words.length === 0);
              })
              .map((l) => l.replace(/^[\s\u2580-\u259F\u25A0-\u25FF╹╻]+/, "").trim())
              .filter((l) => l.length > 0)
              .join("\n");

            if (!cleanedContent) return null;

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
                {cleanedContent}
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

      {/* 7. Bottom spacing is provided by the feed padding; status lives in the session strip. */}
    </main>
  );
};
