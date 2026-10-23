import { Component, For, Show, createSignal, createMemo } from "solid-js";
import { marked } from "marked";
import {
  state,
  setState,
  getActiveWorkspace,
  getActiveTab,
  toggleTerminalSheet,
  openDiffDrawer,
  toggleSessionMenu,
  closeSessionMenu,
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

marked.use({
  gfm: true,
  breaks: true,
});

function renderMarkdown(content: string): string {
  if (!content) return "";
  try {
    return marked.parse(content) as string;
  } catch {
    return content;
  }
}

function cleanPath(p: string): string {
  if (!p) return "";
  return p.replace(/^\/home\/[^\/]+/, "~");
}

function parseToolInfo(name: string, input: any, title?: string, fallbackCmd?: string) {
  let action = "Tool";
  let target = "";
  const lowerName = (name || title || "").toLowerCase();

  const rawInput = typeof input === "object" && input !== null ? input : {};
  const cmd =
    rawInput.CommandLine ||
    rawInput.command ||
    rawInput.cmd ||
    fallbackCmd ||
    (typeof input === "string" ? input : "");
  const path = rawInput.Path || rawInput.path || rawInput.filePath || rawInput.file_path || "";
  const query = rawInput.query || rawInput.search || rawInput.pattern || "";

  if (lowerName.includes("read") || lowerName.includes("view") || lowerName === "read_file") {
    action = "Read";
    target = cleanPath(path || cmd);
  } else if (
    lowerName.includes("edit") ||
    lowerName.includes("write") ||
    lowerName === "edit_file" ||
    lowerName === "write_file" ||
    lowerName === "replace_file_content"
  ) {
    action = lowerName.includes("write") ? "Write" : "Edit";
    target = cleanPath(path || cmd);
  } else if (
    lowerName.includes("bash") ||
    lowerName.includes("run_command") ||
    lowerName.includes("cmd") ||
    lowerName.includes("exec") ||
    lowerName === "sh"
  ) {
    action = "Bash";
    target = cmd;
  } else if (lowerName.includes("search") || lowerName.includes("grep") || lowerName.includes("find")) {
    action = "Search";
    target = query || cmd || path;
  } else {
    action = name || title || "Tool";
    target = path || cmd || (typeof input === "string" ? input : JSON.stringify(input));
  }

  return { action, target, fullCommand: cmd || target };
}

function summarizeToolCalls(tools: NormalizedToolCall[]) {
  let reads = 0;
  let edits = 0;
  let bashes = 0;
  let searches = 0;
  let others = 0;

  for (const t of tools) {
    const { action } = parseToolInfo(t.name, t.input);
    if (action === "Read") reads++;
    else if (action === "Edit" || action === "Write") edits++;
    else if (action === "Bash") bashes++;
    else if (action === "Search") searches++;
    else others++;
  }

  const parts: string[] = [];
  if (reads > 0) parts.push(`${reads} reads`);
  if (searches > 0) parts.push(`${searches} search${searches > 1 ? "es" : ""}`);
  if (edits > 0) parts.push(`${edits} edit${edits > 1 ? "s" : ""}`);
  if (bashes > 0) parts.push(`${bashes} command${bashes > 1 ? "s" : ""}`);
  if (others > 0) parts.push(`${others} other${others > 1 ? "s" : ""}`);

  return parts.length > 0 ? parts.join(", ") : `${tools.length} actions`;
}

export const CardFeed: Component = () => {
  let feedContainerRef: HTMLElement | undefined;
  const [isAtBottom, setIsAtBottom] = createSignal(true);
  const [expandedThoughts, setExpandedThoughts] = createSignal<Record<string, boolean>>({});
  const [expandedDiffs, setExpandedDiffs] = createSignal<Record<string, boolean>>({});
  const [expandedTools, setExpandedTools] = createSignal<Record<string, boolean>>({});
  const [expandedAggregated, setExpandedAggregated] = createSignal<Record<string, boolean>>({});
  const [showFullTerminalHistory, setShowFullTerminalHistory] = createSignal(false);
  const [copiedNotification, setCopiedNotification] = createSignal(false);

  const handleScroll = () => {
    if (!feedContainerRef) return;
    const { scrollTop, scrollHeight, clientHeight } = feedContainerRef;
    const away = scrollHeight - scrollTop - clientHeight > 60;
    setIsAtBottom(!away);
  };

  const scrollToTop = () => {
    feedContainerRef?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const scrollToBottom = () => {
    if (!feedContainerRef) return;
    feedContainerRef.scrollTo({ top: feedContainerRef.scrollHeight, behavior: "smooth" });
  };

  const scrollPageUp = () => {
    if (!feedContainerRef) return;
    feedContainerRef.scrollBy({ top: -feedContainerRef.clientHeight * 0.75, behavior: "smooth" });
  };

  const scrollPageDown = () => {
    if (!feedContainerRef) return;
    feedContainerRef.scrollBy({ top: feedContainerRef.clientHeight * 0.75, behavior: "smooth" });
  };

  const toggleTool = (id: string) => {
    setExpandedTools((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleAggregated = (id: string) => {
    setExpandedAggregated((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleThought = (id: string) => {
    setExpandedThoughts((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleDiff = (id: string) => {
    setExpandedDiffs((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const ws = getActiveWorkspace;
  const tab = getActiveTab;

  const getStatusText = () => {
    if (state.pendingInteraction || state.agentStatus === "blocked") return "待确认";
    if (state.agentStatus === "working") return "工作中";
    if (state.agentStatus === "done") return "已完成";
    return "就绪";
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

  // Summarized conversation topic
  const conversationTopic = createMemo(() => {
    const isGeneric = (s?: string) => {
      if (!s) return true;
      const lower = s.trim().toLowerCase();
      return (
        lower === "agy" ||
        lower === "opencode" ||
        lower === "claude" ||
        lower === "terminal" ||
        lower === "bash" ||
        lower === "zsh" ||
        lower === "sh" ||
        lower === "agent" ||
        lower.startsWith("tab ") ||
        /^[a-z0-9]+:p\d+$/i.test(lower)
      );
    };

    const paneId = state.activePaneId;
    const currentAgent = state.workingAgents?.find((a) => a.paneId === paneId);
    if (currentAgent?.summary && !isGeneric(currentAgent.summary)) {
      const s = currentAgent.summary.trim();
      return s.length > 28 ? s.slice(0, 28) + "…" : s;
    }

    if (state.normalizedTurns && state.normalizedTurns.length > 0) {
      for (const t of state.normalizedTurns) {
        const text = t.userPrompt?.text?.trim() || "";
        if (text && !isGeneric(text)) {
          return text.length > 28 ? text.slice(0, 28) + "…" : text;
        }
      }
    }

    const tabLabel = (tab()?.label || "").trim();
    if (tabLabel && !isGeneric(tabLabel)) return tabLabel;

    return "会话";
  });

  return (
    <main
      ref={feedContainerRef}
      onScroll={handleScroll}
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
      {/* 1. Streamlined Session Bar (Model Badge + Dot + Summarized Topic + Options menu) */}
      <section
        aria-label="当前会话信息"
        style={{
          position: "relative",
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: "8px",
          padding: "6px 10px",
          background: "var(--surface)",
          border: "1.5px solid var(--border)",
          "border-radius": "9px",
          "min-height": "42px",
          "max-width": "100%",
          "box-sizing": "border-box",
          "box-shadow": "0 1px 3px rgba(0, 0, 0, 0.12)",
        }}
      >
        {/* Left: Two-line stack (Line 1: Status beacon + Model badge; Line 2: Divider dot + Summarized Topic) */}
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            "justify-content": "center",
            gap: "3px",
            flex: 1,
            "min-width": 0,
            overflow: "hidden",
          }}
        >
          {/* Line 1: Status Beacon + Model Badge */}
          <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
            {/* Status Indicator Animated Beacon */}
            <div
              title={`状态: ${getStatusText()}`}
              style={{
                position: "relative",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                width: "12px",
                height: "12px",
                "flex-shrink": 0,
              }}
            >
              <div
                class={
                  state.agentStatus === "working"
                    ? "status-dot-working"
                    : state.agentStatus === "blocked"
                    ? "status-dot-blocked"
                    : ""
                }
                style={{
                  width: "7px",
                  height: "7px",
                  "border-radius": "50%",
                  background: getStatusDotColor(),
                  "flex-shrink": 0,
                }}
              />
            </div>

            {/* Model badge with filled background */}
            <Show when={agentBadgeInfo().model}>
              <span
                style={{
                  "font-size": "11px",
                  "font-weight": 650,
                  padding: "1px 6px",
                  "border-radius": "4px",
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

          {/* Line 2: Dot + Summarized Topic Title */}
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "5px",
              "font-size": "12px",
              "font-weight": 550,
              color: "var(--fg)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
              "line-height": "16px",
            }}
            title={conversationTopic()}
          >
            <span style={{ color: "var(--faint)", "font-size": "10px", "flex-shrink": 0 }}>·</span>
            <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
              {conversationTopic()}
            </span>
          </div>
        </div>

        {/* Right: Three-dots Session Options button (Physical Button with solid border & shadow) */}
        <div style={{ position: "relative", display: "flex", "align-items": "center", "flex-shrink": 0 }}>
          <button
            class="touch-target"
            aria-label="会话操作选项"
            title="会话选项 (查看 Diff / 设置)"
            onClick={() => toggleSessionMenu()}
            style={{
              height: "30px",
              width: "34px",
              "min-height": "30px",
              "min-width": "34px",
              padding: 0,
              "border-radius": "8px",
              border: "1.5px solid var(--border)",
              background: state.sessionMenuOpen ? "var(--sel)" : "var(--surface)",
              color: state.sessionMenuOpen ? "var(--accent)" : "var(--fg)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              cursor: "pointer",
              "box-shadow": "0 1px 3px rgba(0, 0, 0, 0.2)",
              "box-sizing": "border-box",
              transition: "all 0.15s ease",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </button>

          {/* Options Popover Menu */}
          <Show when={state.sessionMenuOpen}>
            <div
              style={{
                position: "absolute",
                top: "34px",
                right: 0,
                "z-index": 60,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                "border-radius": "10px",
                padding: "4px",
                "box-shadow": "0 4px 16px rgba(0, 0, 0, 0.3)",
                display: "flex",
                "flex-direction": "column",
                gap: "2px",
                "min-width": "150px",
              }}
            >
              <button
                class="touch-target"
                onClick={() => {
                  closeSessionMenu();
                  openDiffDrawer();
                }}
                style={{
                  height: "32px",
                  padding: "0 8px",
                  border: 0,
                  background: "transparent",
                  color: "var(--fg)",
                  "font-size": "12px",
                  "font-weight": 550,
                  display: "flex",
                  "align-items": "center",
                  gap: "6px",
                  "border-radius": "6px",
                  cursor: "pointer",
                  "text-align": "left",
                  width: "100%",
                }}
              >
                <span>📝</span>
                <span>查看代码 Diff</span>
                <Show when={state.sessionStats && state.sessionStats.filesModified > 0}>
                  <span
                    style={{
                      "margin-left": "auto",
                      "font-size": "10px",
                      color: "var(--accent)",
                      background: "var(--accentbg)",
                      padding: "1px 5px",
                      "border-radius": "4px",
                    }}
                  >
                    {state.sessionStats!.filesModified}
                  </span>
                </Show>
              </button>

              <button
                class="touch-target"
                onClick={() => {
                  closeSessionMenu();
                  setState("settingsModalOpen", true);
                }}
                style={{
                  height: "32px",
                  padding: "0 8px",
                  border: 0,
                  background: "transparent",
                  color: "var(--muted)",
                  "font-size": "12px",
                  display: "flex",
                  "align-items": "center",
                  gap: "6px",
                  "border-radius": "6px",
                  cursor: "pointer",
                  "text-align": "left",
                  width: "100%",
                }}
              >
                <span>⚙️</span>
                <span>偏好与显示设置</span>
              </button>
            </div>
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

      {/* 4. Terminal output: full panel only when there are no cards or turns */}
      <Show when={state.normalizedTurns.length === 0 && state.cards.length === 0}>
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
                    <Show
                      when={state.displayDensity === "detailed"}
                      fallback={
                        /* Antigravity / OpenCode compact thought */
                        <div style={{ margin: "2px 0 4px" }}>
                          <button
                            class="touch-target"
                            onClick={() => toggleThought(turn.turnId)}
                            style={{
                              display: "flex",
                              "align-items": "center",
                              gap: "6px",
                              width: "100%",
                              padding: "4px 6px",
                              background: "transparent",
                              border: 0,
                              color: "var(--muted)",
                              "font-size": "12px",
                              "font-family": "'JetBrains Mono', ui-monospace, monospace",
                              cursor: "pointer",
                              "text-align": "left",
                            }}
                          >
                            <span style={{ color: "var(--faint)", "font-size": "11px" }}>{isThoughtExpanded() ? "▾" : "▸"}</span>
                            <span style={{ color: "var(--muted)", "font-weight": 500 }}>
                              Thought {turn.reasoning?.durationMs ? `for ${Math.round(turn.reasoning.durationMs / 100) / 10}s` : ""}
                              {turn.reasoning?.tokens ? `, ${turn.reasoning.tokens} tokens` : ""}
                            </span>
                            <span style={{ "font-size": "11px", color: "var(--faint)", "margin-left": "auto" }}>
                              {isThoughtExpanded() ? "收起" : "展开"}
                            </span>
                          </button>
                          <Show when={!isThoughtExpanded()}>
                            <div
                              onClick={() => toggleThought(turn.turnId)}
                              style={{
                                padding: "0 6px 4px 18px",
                                "font-size": "11.5px",
                                color: "var(--faint)",
                                "white-space": "nowrap",
                                overflow: "hidden",
                                "text-overflow": "ellipsis",
                                cursor: "pointer",
                                "line-height": 1.4,
                              }}
                            >
                              {turn.reasoning!.text.slice(0, 140)}...
                            </div>
                          </Show>
                          <Show when={isThoughtExpanded()}>
                            <div
                              style={{
                                margin: "4px 0 6px 14px",
                                padding: "8px 12px",
                                background: "var(--inset)",
                                "border-left": "2px solid var(--accent)",
                                "border-radius": "0 8px 8px 0",
                                "font-size": "12px",
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
                      }
                    >
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
                  </Show>

                  {/* Tool Calls */}
                  <Show when={turn.toolCalls && turn.toolCalls.length > 0}>
                    <Show
                      when={state.displayDensity === "aggregated"}
                      fallback={
                        <Show
                          when={state.displayDensity === "detailed"}
                          fallback={
                            /* Antigravity Compact Single-Line Mode (DEFAULT) */
                            <div style={{ display: "flex", "flex-direction": "column", gap: "2px", margin: "2px 0" }}>
                              <For each={turn.toolCalls || []}>
                                {(tc: NormalizedToolCall) => {
                                  const isToolExpanded = () => !!expandedTools()[tc.id];
                                  const parsed = parseToolInfo(tc.name, tc.input);
                                  return (
                                    <div style={{ margin: "1px 0" }}>
                                      <div
                                        class="tool-compact-row"
                                        onClick={() => toggleTool(tc.id)}
                                        style={{
                                          display: "flex",
                                          "align-items": "center",
                                          gap: "6px",
                                          padding: "5px 6px",
                                          "border-radius": "6px",
                                          cursor: "pointer",
                                          "font-family": "'JetBrains Mono', ui-monospace, monospace",
                                          "font-size": "12px",
                                          "line-height": 1.4,
                                          width: "100%",
                                          "box-sizing": "border-box",
                                        }}
                                      >
                                        <span
                                          style={{
                                            color:
                                              tc.status === "failed" || (tc.exitCode !== undefined && tc.exitCode !== 0)
                                                ? "var(--warn)"
                                                : tc.status === "running"
                                                ? "var(--accent)"
                                                : "#e5c07b",
                                            "font-size": "13px",
                                            "line-height": 1,
                                            "flex-shrink": 0,
                                          }}
                                        >
                                          ●
                                        </span>
                                        <span style={{ "font-weight": 700, color: "var(--fg)", "flex-shrink": 0 }}>
                                          {parsed.action}
                                        </span>
                                        <span
                                          style={{
                                            color: "var(--muted)",
                                            flex: 1,
                                            "min-width": 0,
                                            overflow: "hidden",
                                            "text-overflow": "ellipsis",
                                            "white-space": "nowrap",
                                          }}
                                        >
                                          ({parsed.target})
                                        </span>
                                        <span style={{ "font-size": "10.5px", color: "var(--faint)", "flex-shrink": 0 }}>
                                          {isToolExpanded() ? "收起 ▲" : "(点按展开)"}
                                        </span>
                                      </div>

                                      <Show when={isToolExpanded()}>
                                        <div
                                          style={{
                                            margin: "4px 0 8px 16px",
                                            padding: "8px 10px",
                                            background: "var(--code)",
                                            border: "1px solid var(--codeb)",
                                            "border-radius": "8px",
                                            display: "flex",
                                            "flex-direction": "column",
                                            gap: "6px",
                                            "font-family": "'JetBrains Mono', monospace",
                                            "font-size": "11.5px",
                                          }}
                                        >
                                          <div style={{ display: "flex", "justify-content": "space-between", color: "var(--faint)", "font-size": "11px" }}>
                                            <span>$ {parsed.fullCommand || parsed.target}</span>
                                            <Show when={tc.exitCode !== undefined}>
                                              <span style={{ color: tc.exitCode === 0 ? "var(--accent)" : "var(--warn)" }}>exit {tc.exitCode}</span>
                                            </Show>
                                          </div>

                                          <Show when={tc.output}>
                                            <pre
                                              style={{
                                                margin: 0,
                                                padding: "6px 8px",
                                                background: "var(--inset)",
                                                "border-radius": "6px",
                                                "max-height": "160px",
                                                overflow: "auto",
                                                "white-space": "pre-wrap",
                                                "word-break": "break-all",
                                                color: "var(--codefg)",
                                                "font-size": "11px",
                                                "line-height": 1.45,
                                              }}
                                            >
                                              {tc.output}
                                            </pre>
                                          </Show>
                                        </div>
                                      </Show>
                                    </div>
                                  );
                                }}
                              </For>
                            </div>
                          }
                        >
                          {/* Traditional Detailed Card Mode */}
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
                        </Show>
                      }
                    >
                      {/* OpenCode Aggregated Mode */}
                      <div style={{ margin: "2px 0" }}>
                        <button
                          class="touch-target tool-compact-row"
                          onClick={() => toggleAggregated(turn.turnId)}
                          style={{
                            display: "flex",
                            "align-items": "center",
                            gap: "8px",
                            width: "100%",
                            padding: "5px 8px",
                            background: "transparent",
                            border: 0,
                            color: "var(--muted)",
                            "font-size": "12px",
                            "font-family": "'JetBrains Mono', monospace",
                            cursor: "pointer",
                            "text-align": "left",
                            "border-radius": "6px",
                          }}
                        >
                          <span style={{ color: "var(--accent)", "font-weight": 700 }}>→</span>
                          <span style={{ "font-weight": 600, color: "var(--fg)" }}>
                            Explored: {summarizeToolCalls(turn.toolCalls || [])}
                          </span>
                          <span style={{ "font-size": "11px", color: "var(--faint)", "margin-left": "auto" }}>
                            {expandedAggregated()[turn.turnId] ? "收起 ▲" : "详情 ▼"}
                          </span>
                        </button>

                        <Show when={expandedAggregated()[turn.turnId]}>
                          <div style={{ padding: "4px 0 4px 14px", display: "flex", "flex-direction": "column", gap: "2px" }}>
                            <For each={turn.toolCalls || []}>
                              {(tc) => {
                                const parsed = parseToolInfo(tc.name, tc.input);
                                const isToolExpanded = () => !!expandedTools()[tc.id];
                                return (
                                  <div>
                                    <div
                                      class="tool-compact-row"
                                      onClick={() => toggleTool(tc.id)}
                                      style={{
                                        display: "flex",
                                        "align-items": "center",
                                        gap: "6px",
                                        padding: "4px 6px",
                                        "font-size": "11.5px",
                                        "font-family": "'JetBrains Mono', monospace",
                                        cursor: "pointer",
                                        "border-radius": "6px",
                                      }}
                                    >
                                      <span style={{ color: "#e5c07b" }}>●</span>
                                      <span style={{ "font-weight": 600, color: "var(--fg)" }}>{parsed.action}</span>
                                      <span style={{ color: "var(--muted)", flex: 1, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                                        ({parsed.target})
                                      </span>
                                    </div>
                                    <Show when={isToolExpanded() && tc.output}>
                                      <pre
                                        style={{
                                          margin: "4px 0 6px 14px",
                                          padding: "6px 8px",
                                          background: "var(--code)",
                                          "border-radius": "6px",
                                          "font-size": "11px",
                                          "max-height": "140px",
                                          overflow: "auto",
                                          "white-space": "pre-wrap",
                                        }}
                                      >
                                        {tc.output}
                                      </pre>
                                    </Show>
                                  </div>
                                );
                              }}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </Show>

                  {/* Assistant Response with Full GFM Markdown Rendering */}
                  <Show when={turn.assistantResponse?.markdown}>
                    <div
                      class="markdown-body"
                      style={{
                        padding: "8px 0 4px",
                        "max-width": "100%",
                        "box-sizing": "border-box",
                      }}
                      innerHTML={renderMarkdown(turn.assistantResponse!.markdown)}
                    />
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
            const parsed = parseToolInfo(tool.title || "Command", tool.command, tool.title, tool.command);
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

            if (state.displayDensity !== "detailed") {
              /* Antigravity single-line compact tool call */
              return (
                <div
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    "border-radius": "10px",
                    padding: "4px 8px",
                  }}
                >
                  <div
                    class="tool-compact-row"
                    onClick={toggle}
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "6px",
                      padding: "4px",
                      cursor: "pointer",
                      "font-family": "'JetBrains Mono', ui-monospace, monospace",
                      "font-size": "12px",
                      "border-radius": "6px",
                    }}
                  >
                    <span
                      style={{
                        color:
                          tool.status === "error" || (tool.exitCode !== undefined && tool.exitCode !== 0)
                            ? "var(--warn)"
                            : tool.status === "running"
                            ? "var(--accent)"
                            : "#e5c07b",
                        "font-size": "13px",
                      }}
                    >
                      ●
                    </span>
                    <span style={{ "font-weight": 700, color: "var(--fg)" }}>{parsed.action}</span>
                    <span
                      style={{
                        color: "var(--muted)",
                        flex: 1,
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "white-space": "nowrap",
                      }}
                    >
                      ({parsed.target})
                    </span>
                    <span style={{ "font-size": "10.5px", color: "var(--faint)" }}>
                      {isExpanded() ? "收起 ▲" : "(点按展开)"}
                    </span>
                  </div>

                  <Show when={isExpanded()}>
                    <div
                      style={{
                        margin: "4px 0 4px",
                        padding: "8px 10px",
                        background: "var(--code)",
                        "border-radius": "8px",
                        "font-family": "'JetBrains Mono', monospace",
                        "font-size": "11.5px",
                        display: "flex",
                        "flex-direction": "column",
                        gap: "6px",
                      }}
                    >
                      <div style={{ color: "var(--faint)", "font-size": "11px" }}>
                        $ {tool.command}
                      </div>
                      <Show when={tool.output}>
                        <pre
                          style={{
                            margin: 0,
                            padding: "6px 8px",
                            background: "var(--inset)",
                            "border-radius": "6px",
                            "max-height": "160px",
                            overflow: "auto",
                            "white-space": "pre-wrap",
                            "word-break": "break-all",
                            color: "var(--codefg)",
                            "font-size": "11px",
                          }}
                        >
                          {tool.output}
                        </pre>
                      </Show>
                    </div>
                  </Show>
                </div>
              );
            }

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
                class="markdown-body"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  "border-radius": "12px",
                  padding: "12px 14px",
                  "max-width": "100%",
                  "box-sizing": "border-box",
                  "box-shadow": "0 2px 6px rgba(0, 0, 0, 0.05)",
                }}
                innerHTML={renderMarkdown(cleanedContent)}
              />
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

      {/* 7. Right-Side Floating Quick Scroll Controls */}
      <Show when={state.showScrollControls !== false}>
        <aside
          class="floating-scroll-strip"
          role="toolbar"
          aria-label="快速滚动侧栏"
        >
          <button
            class="floating-scroll-btn"
            onClick={scrollToTop}
            title="回顶部 (Top)"
            aria-label="回顶部"
          >
            ⤒
          </button>
          <button
            class="floating-scroll-btn"
            onClick={scrollPageUp}
            title="上一页 (Page Up)"
            aria-label="上一页"
          >
            ↑
          </button>
          <button
            class="floating-scroll-btn"
            onClick={scrollPageDown}
            title="下一页 (Page Down)"
            aria-label="下一页"
          >
            ↓
          </button>
          <button
            class="floating-scroll-btn"
            onClick={scrollToBottom}
            title="到底部 (Bottom)"
            aria-label="到底部"
          >
            ⤓
          </button>
        </aside>
      </Show>

      {/* 8. Auto Floating Jump-to-Bottom Pill Button */}
      <Show when={!isAtBottom()}>
        <button
          class="jump-to-bottom-pill touch-target"
          onClick={scrollToBottom}
          aria-label="回到底部"
          title="回到底部"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 5v14M19 12l-7 7-7-7" />
          </svg>
          <span>回到底部</span>
        </button>
      </Show>
    </main>
  );
};
