import { createHash } from "node:crypto";
import type { Card, CardKind, InteractionCardData } from "../types/protocol";

export function stripAnsi(str: string): string {
  // Herdr already strips ANSI by default (`strip_ansi: true`); this only removes leftovers.
  return str
    .replace(/\x1B\][^\x07\x1B]*(\x07|\x1B\\)/g, "") // OSC (any number, BEL or ST terminated)
    .replace(/\x1B\[[0-9;?<>=!]*[ -\/]*[@-~]/g, "") // CSI
    .replace(/\x1B[()*+][0-9A-Za-z]/g, "") // charset selection
    .replace(/\x1B[=>78DEHMNOZc]/g, "") // single-char escapes
    .replace(/\r/g, "");
}

export function computeCardId(kind: CardKind, anchor: string, occurrence: number): string {
  const hash = createHash("sha256")
    .update(`${kind}:${anchor.trim().slice(0, 80)}:${occurrence}`)
    .digest("hex")
    .slice(0, 16);
  return `card_${kind}_${hash}`;
}

export function computeInteractionFingerprint(question: string, payload = "", options: Array<{ id?: string; label: string }> = []): string {
  const raw = `${question.trim()}|${payload.trim()}|${options.map((o) => o.id || o.label).join(",")}`;
  return "fp_" + createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

export const DEFAULT_FALLBACK_KEYS = ["enter", "esc", "up", "down"];
const YES_NO_FALLBACK_KEYS = ["y", "n", "enter", "esc"];

const QUESTION_RE = /^(Allow|Do you want to|Would you like to|Do you trust|Select|Choose|Approve|Permission)\b/i;
const YES_NO_MARKER_RE = /\((y\/n)\)|\[y\/N\]|\[Y\/n\]/;
const THOUGHT_RE = /^(\+ Thought|Thinking\.\.\.|▸ Thought|∴ Thought)/;
// A TUI selection cursor in front of an option ("❯ 1. Yes", "› 2. No").
const CURSOR_RE = /^[❯›▶>]\s*/;
const NUMBERED_OPTION_RE = /^(?:\[(\d+)\]|\((\d+)\)|(\d+)[.)])\s+(.+)$/;
// Lines that may legitimately follow a prompt at the bottom of the screen.
const PROMPT_HINT_RE = /(esc|enter|tab|↑|↓|to cancel|to select|to confirm|to navigate|ctrl\+)/i;
const BORDER_ONLY_RE = /^[\s─━│┃╭╮╰╯┌┐└┘├┤═║╔╗╚╝-]*$/;
const TOOL_CALL_RE = /^([A-Za-z_][A-Za-z0-9_.-]*)\((.*)\)$/;

/** Removes TUI box-drawing side borders so `│ Do you want to proceed? │` reads as plain text. */
function unbox(line: string): string {
  return line.replace(/^\s*[│┃║]\s?/, "").replace(/\s?[│┃║]\s*$/, "");
}

function isToolStart(trimmed: string): boolean {
  if (trimmed.startsWith("$ ")) return true;
  // `●`/`○` prefix both tool calls and plain assistant text in Claude-style TUIs;
  // only `Name(args)` is a tool call.
  const bullet = /^[●○]\s+(.*)$/.exec(trimmed);
  return !!bullet && TOOL_CALL_RE.test(bullet[1].trim());
}

function isBlockStart(trimmed: string): boolean {
  return (
    isToolStart(trimmed) ||
    trimmed.startsWith("diff --git") ||
    trimmed.startsWith("@@ ") ||
    THOUGHT_RE.test(trimmed) ||
    isQuestionLine(trimmed)
  );
}

function isQuestionLine(trimmed: string): boolean {
  return QUESTION_RE.test(trimmed) || YES_NO_MARKER_RE.test(trimmed);
}

function parseNumberedOption(trimmed: string): { num: string; label: string } | null {
  const m = NUMBERED_OPTION_RE.exec(trimmed.replace(CURSOR_RE, ""));
  if (!m) return null;
  return { num: m[1] || m[2] || m[3], label: m[4].trim() };
}

interface PromptParse {
  question: string;
  payload: string;
  options: Array<{ id: string; label: string; keyShortcut: string }>;
  fallbackKeys: string[];
}

/**
 * Parses a prompt that starts at `start`. A prompt only counts when it sits at the bottom of the
 * screen: after its options nothing follows except blank lines, borders, or key hints. A prompt that
 * has scrolled into history (output after it) is not pending.
 *
 * Only numbered options become structured choices, because a digit selects the option directly in
 * the agent TUIs. Arrow-cursor menus and "Yes/No" lines get no structured choices — answering them
 * by guessing keys could pick the wrong item — so the client shows the raw key pad instead.
 */
function parseTailPrompt(lines: string[], start: number): PromptParse | null {
  const question = lines[start].trim();
  const isYesNo = YES_NO_MARKER_RE.test(question);
  const options: PromptParse["options"] = [];
  const payloadLines: string[] = [];
  let lastOptionIdx = -1;

  for (let j = start + 1; j < lines.length; j++) {
    const trimmed = lines[j].trim();
    if (!trimmed || BORDER_ONLY_RE.test(trimmed)) continue;
    const opt = parseNumberedOption(trimmed);
    if (opt) {
      options.push({ id: `opt_${opt.num}`, label: opt.label, keyShortcut: opt.num });
      lastOptionIdx = j;
      continue;
    }
    if (lastOptionIdx === -1) {
      payloadLines.push(trimmed);
    } else if (!PROMPT_HINT_RE.test(trimmed) && !/^\s{2,}\S/.test(lines[j])) {
      // Real content after the options: the prompt is history, not pending.
      return null;
    }
  }

  if (options.length === 0) {
    // Without numbered options a prompt is pending only as an arrow menu ("❯ Yes") or when
    // nothing but key hints follows the question.
    const hasCursorMenu = payloadLines.some((l) => CURSOR_RE.test(l));
    const content = payloadLines.filter((l) => !PROMPT_HINT_RE.test(l));
    if (!hasCursorMenu && content.length > 0) return null;
  }

  return {
    question,
    payload: payloadLines.join("\n"),
    options,
    fallbackKeys: isYesNo ? YES_NO_FALLBACK_KEYS : DEFAULT_FALLBACK_KEYS,
  };
}

export function buildInteraction(prompt: PromptParse, title = "需要授权"): InteractionCardData {
  const optionKey = prompt.options.map((o) => o.label).join("|");
  const interactionId = "int_" + createHash("sha256").update(`${prompt.question}|${optionKey}`).digest("hex").slice(0, 10);
  return {
    id: computeCardId("interaction", prompt.question, 0),
    kind: "interaction",
    interactionId,
    title,
    question: prompt.question,
    payload: prompt.payload,
    fingerprint: computeInteractionFingerprint(prompt.question, prompt.payload, prompt.options),
    options: prompt.options,
    fallbackKeys: prompt.fallbackKeys,
  };
}

/**
 * Herdr reports `blocked` but the screen holds no prompt the classifier recognizes. The client
 * still needs something to act on: a card with the screen tail and the raw key pad, no choices.
 */
export function buildUnrecognizedPrompt(rawScreen: string): InteractionCardData {
  const tail = stripAnsi(rawScreen)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !BORDER_ONLY_RE.test(l.trim()))
    .slice(-6);
  const question = tail.length > 0 ? unbox(tail[tail.length - 1]).trim() : "Agent 正在等待输入";
  return buildInteraction(
    { question, payload: tail.slice(0, -1).map((l) => unbox(l)).join("\n"), options: [], fallbackKeys: DEFAULT_FALLBACK_KEYS },
    "等待输入"
  );
}

export class CardClassifier {
  public classifyScreen(rawScreen: string): { cards: Card[]; pendingInteraction: InteractionCardData | null } {
    const lines = stripAnsi(rawScreen).split("\n").map(unbox);
    const cards: Card[] = [];
    let pendingInteraction: InteractionCardData | null = null;
    const occurrences = new Map<string, number>();
    const nextId = (kind: CardKind, anchor: string) => {
      const key = `${kind}:${anchor}`;
      const n = occurrences.get(key) || 0;
      occurrences.set(key, n + 1);
      return computeCardId(kind, anchor, n);
    };

    let i = 0;
    while (i < lines.length) {
      const trimmed = lines[i].trim();
      if (!trimmed) {
        i++;
        continue;
      }

      // 1. Tool call: "$ cmd" or "● Name(args)"
      if (isToolStart(trimmed)) {
        const cmd = trimmed.replace(/^(\$|●|○)\s+/, "");
        i++;
        const outputLines: string[] = [];
        let exitCode: number | undefined;
        while (i < lines.length && !isBlockStart(lines[i].trim())) {
          const exitMatch = lines[i].trim().match(/exit code:?\s*(\d+)/i);
          if (exitMatch) exitCode = parseInt(exitMatch[1], 10);
          outputLines.push(lines[i]);
          i++;
        }
        const callMatch = TOOL_CALL_RE.exec(cmd.trim());
        cards.push({
          id: nextId("tool_call", trimmed),
          kind: "tool_call",
          title: callMatch ? callMatch[1] : cmd.split(" ")[0] || "Command",
          command: callMatch ? callMatch[2].trim() : cmd,
          status: exitCode !== undefined && exitCode !== 0 ? "error" : "done",
          exitCode,
          output: outputLines.join("\n").trim(),
        });
        continue;
      }

      // 2. Diff: "diff --git" or "@@ -x,y +x,y @@"
      if (trimmed.startsWith("diff --git") || trimmed.startsWith("@@ ")) {
        const diffLines: string[] = [lines[i]];
        const fileMatch = trimmed.match(/diff --git a\/(.+?) b\//);
        const filePath = fileMatch ? fileMatch[1] : "diff.patch";
        let additions = 0;
        let deletions = 0;
        i++;
        while (i < lines.length) {
          const next = lines[i];
          const nextTrimmed = next.trim();
          if (nextTrimmed.startsWith("diff --git") || (isBlockStart(nextTrimmed) && !nextTrimmed.startsWith("@@ "))) break;
          if (next.startsWith("+") && !next.startsWith("+++")) additions++;
          if (next.startsWith("-") && !next.startsWith("---")) deletions++;
          diffLines.push(next);
          i++;
        }
        cards.push({
          id: nextId("diff", trimmed),
          kind: "diff",
          filePath,
          additions,
          deletions,
          diff: diffLines.join("\n"),
          collapsed: true,
        });
        continue;
      }

      // 3. Thought
      if (THOUGHT_RE.test(trimmed)) {
        i++;
        const thoughtLines: string[] = [];
        while (i < lines.length && !isBlockStart(lines[i].trim())) {
          thoughtLines.push(lines[i]);
          i++;
        }
        cards.push({
          id: nextId("thought", trimmed),
          kind: "thought",
          title: trimmed,
          body: thoughtLines.join("\n").trim(),
          collapsed: true,
        });
        continue;
      }

      // 4. Prompt at the bottom of the screen
      if (isQuestionLine(trimmed) || (trimmed.endsWith("?") && this.hasNumberedOptionsAhead(lines, i))) {
        const prompt = parseTailPrompt(lines, i);
        if (prompt) {
          const card = buildInteraction(prompt);
          cards.push(card);
          pendingInteraction = card;
          break; // a pending prompt extends to the end of the screen
        }
      }

      // 5. Text
      const mdLines: string[] = [lines[i]];
      i++;
      while (i < lines.length) {
        const nextTrimmed = lines[i].trim();
        if (isBlockStart(nextTrimmed) || nextTrimmed.endsWith("?")) break;
        mdLines.push(lines[i]);
        i++;
      }
      const content = mdLines
        .filter((l) => {
          const t = l.trim();
          if (!t) return false;
          const blockChars = (t.match(/[▀-▟■-◿]/g) || []).length;
          const words = t.match(/[a-zA-Z0-9_一-龥]{3,}/g) || [];
          return !(blockChars > 0 && words.length === 0);
        })
        .map((l) => l.trimEnd().replace(/^[\s▀-▟■-◿╹╻]+/, (m) => (/[^\s]/.test(m) ? "" : m)))
        .filter((l) => l.trim().length > 0)
        .join("\n")
        .trim();
      if (content) {
        cards.push({ id: nextId("markdown", trimmed), kind: "markdown", content: content.replace(/^[●○]\s+/, "") });
      }
    }

    return { cards, pendingInteraction };
  }

  private hasNumberedOptionsAhead(lines: string[], i: number): boolean {
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      if (parseNumberedOption(lines[j].trim())) return true;
    }
    return false;
  }
}
