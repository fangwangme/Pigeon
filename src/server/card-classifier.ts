import { createHash } from "node:crypto";
import type { Card, CardKind, InteractionCardData } from "../types/protocol";

export function stripAnsi(str: string): string {
  // Strip ANSI escape sequences, OSC sequences, and carriage returns
  return str
    .replace(/\x1B\][0-9];[^\x07\x1B]*(\x07|\x1B\\)/g, "") // OSC
    .replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, "") // CSI
    .replace(/\r/g, "");
}

export function computeCardId(kind: CardKind, anchor: string, index: number): string {
  const hash = createHash("sha256")
    .update(`${kind}:${anchor.trim().slice(0, 80)}:${index}`)
    .digest("hex")
    .slice(0, 16);
  return `card_${kind}_${hash}`;
}

export function computeInteractionFingerprint(question: string, payload = "", options: any[] = []): string {
  const raw = `${question.trim()}|${payload.trim()}|${options.map((o) => o.id || o.label).join(",")}`;
  return "fp_" + createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

export class CardClassifier {
  public classifyScreen(rawScreen: string): { cards: Card[]; pendingInteraction: InteractionCardData | null } {
    const clean = stripAnsi(rawScreen);
    const lines = clean.split("\n");
    const cards: Card[] = [];
    let pendingInteraction: InteractionCardData | null = null;

    let i = 0;
    let cardIdx = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      // 1. Tool Call: Line starting with "$ " or "❯ " or "● " or "○ "
      if (
        trimmed.startsWith("$ ") ||
        trimmed.startsWith("❯ ") ||
        trimmed.startsWith("● ") ||
        trimmed.startsWith("○ ")
      ) {
        const cmd = trimmed.replace(/^(\$|❯|●|○)\s+/, "");
        const startLine = trimmed;
        i++;
        const outputLines: string[] = [];
        let exitCode: number | undefined;

        while (i < lines.length) {
          const nextTrimmed = lines[i].trim();
          if (
            nextTrimmed.startsWith("$ ") ||
            nextTrimmed.startsWith("❯ ") ||
            nextTrimmed.startsWith("● ") ||
            nextTrimmed.startsWith("○ ") ||
            nextTrimmed.startsWith("diff --git") ||
            nextTrimmed.startsWith("@@ ") ||
            nextTrimmed.startsWith("+ Thought") ||
            nextTrimmed.startsWith("Thinking...") ||
            nextTrimmed.startsWith("▸ Thought") ||
            nextTrimmed.startsWith("Thought ") ||
            nextTrimmed.match(/^(Allow|Do you want to|Select|Choose|\(y\/n\))/i)
          ) {
            break;
          }

          // Check for exit status line e.g. [Process completed with exit code 0]
          const exitMatch = nextTrimmed.match(/exit code:?\s*(\d+)/i);
          if (exitMatch) {
            exitCode = parseInt(exitMatch[1], 10);
          }
          outputLines.push(lines[i]);
          i++;
        }

        // Antigravity/Claude style tool lines look like `Bash(cd /path && ...)`.
        // Keep the tool name as the heading and the inner text as the command.
        const callMatch = /^([A-Za-z_][A-Za-z0-9_.-]*)\((.*)\)$/.exec(cmd.trim());
        cards.push({
          id: computeCardId("tool_call", startLine, cardIdx++),
          kind: "tool_call",
          title: callMatch ? callMatch[1] : cmd.split(" ")[0] || "Command",
          command: callMatch ? callMatch[2].trim() : cmd,
          status: exitCode !== undefined && exitCode !== 0 ? "error" : "done",
          exitCode: exitCode ?? 0,
          output: outputLines.join("\n").trim(),
        });
        continue;
      }

      // 2. Diff Card: starts with diff --git or @@ -x,y +x,y @@
      if (trimmed.startsWith("diff --git") || trimmed.startsWith("@@ ")) {
        const startLine = trimmed;
        const diffLines: string[] = [line];
        let filePath = "diff.patch";
        const fileMatch = line.match(/diff --git a\/(.+?) b\//);
        if (fileMatch) {
          filePath = fileMatch[1];
        }

        i++;
        let additions = 0;
        let deletions = 0;

        while (i < lines.length) {
          const nextTrimmed = lines[i].trim();
          if (
            nextTrimmed.startsWith("$ ") ||
            nextTrimmed.startsWith("❯ ") ||
            nextTrimmed.startsWith("● ") ||
            nextTrimmed.startsWith("○ ") ||
            nextTrimmed.startsWith("+ Thought") ||
            nextTrimmed.startsWith("Thinking...") ||
            nextTrimmed.startsWith("▸ Thought") ||
            nextTrimmed.startsWith("diff --git")
          ) {
            break;
          }
          if (lines[i].startsWith("+") && !lines[i].startsWith("+++")) additions++;
          if (lines[i].startsWith("-") && !lines[i].startsWith("---")) deletions++;
          diffLines.push(lines[i]);
          i++;
        }

        cards.push({
          id: computeCardId("diff", startLine, cardIdx++),
          kind: "diff",
          filePath,
          additions,
          deletions,
          diff: diffLines.join("\n"),
          collapsed: true,
        });
        continue;
      }

      // 3. Thought Card: starts with "+ Thought", "Thinking...", "▸ Thought", or "Thought"
      if (
        trimmed.startsWith("+ Thought") ||
        trimmed.startsWith("Thinking...") ||
        trimmed.startsWith("▸ Thought") ||
        trimmed.startsWith("Thought ")
      ) {
        const startLine = trimmed;
        i++;
        const thoughtLines: string[] = [];

        while (i < lines.length) {
          const nextTrimmed = lines[i].trim();
          if (
            nextTrimmed.startsWith("$ ") ||
            nextTrimmed.startsWith("❯ ") ||
            nextTrimmed.startsWith("● ") ||
            nextTrimmed.startsWith("○ ") ||
            nextTrimmed.startsWith("diff --git") ||
            nextTrimmed.startsWith("@@ ") ||
            nextTrimmed.match(/^(Allow|Do you want to|Select|Choose|\(y\/n\))/i)
          ) {
            break;
          }
          thoughtLines.push(lines[i]);
          i++;
        }

        cards.push({
          id: computeCardId("thought", startLine, cardIdx++),
          kind: "thought",
          title: startLine,
          body: thoughtLines.join("\n").trim(),
          collapsed: true,
        });
        continue;
      }

      // 4. Interaction Prompt: e.g. "Allow Claude to execute this command?", "(y/n)", "[1] ... [2] ..."
      const hasExplicitChoiceMarker =
        trimmed.includes("(y/n)") ||
        trimmed.includes("[y/N]") ||
        trimmed.includes("[Y/n]") ||
        trimmed.includes("enter Confirm") ||
        /^(Allow|Do you want to|Would you like to|Do you trust|Select|Choose|Approve|Permission)/i.test(trimmed);

      // Check if subsequent lines contain structured options like [1], 1., 1)
      let lookaheadHasOptions = false;
      let nextIdx = i + 1;
      while (nextIdx < Math.min(lines.length, i + 6)) {
        const checkLine = lines[nextIdx].trim();
        if (/^(\[?\d+\]?|\(?\d+\)?|[1-9]\.)\s+/.test(checkLine)) {
          lookaheadHasOptions = true;
          break;
        }
        if (checkLine.startsWith("$ ") || checkLine.startsWith("❯ ")) break;
        nextIdx++;
      }

      const isInteractionQuestion =
        hasExplicitChoiceMarker ||
        (trimmed.endsWith("?") && lookaheadHasOptions);

      if (isInteractionQuestion) {
        const question = trimmed;
        const startLine = trimmed;
        i++;
        const optionLines: string[] = [];

        while (i < lines.length) {
          const nextTrimmed = lines[i].trim();
          if (
            nextTrimmed.startsWith("$ ") ||
            nextTrimmed.startsWith("❯ ") ||
            nextTrimmed.startsWith("● ") ||
            nextTrimmed.startsWith("○ ") ||
            nextTrimmed.startsWith("+ Thought") ||
            nextTrimmed.startsWith("Thinking...") ||
            nextTrimmed.startsWith("▸ Thought")
          ) {
            break;
          }
          if (nextTrimmed) {
            optionLines.push(nextTrimmed);
          }
          i++;
        }

        const options = [];
        let cmdPayload = "";

        // Separate possible command block from options
        for (const optLine of optionLines) {
          const match = optLine.match(/^(\[?\d+\]?|\(?\d+\)?|[1-9]\.)[.\s:]+(.+)$/);
          const matchArrow = optLine.match(/^[>*\-]\s*(.+)$/);
          if (match) {
            const num = match[1].replace(/\D/g, "");
            options.push({
              id: `opt_${num}`,
              label: match[2].trim(),
              keyShortcut: num,
            });
          } else if (matchArrow) {
            const optLabel = matchArrow[1].trim();
            const optNum = options.length + 1;
            options.push({
              id: `opt_${optNum}`,
              label: optLabel,
              keyShortcut: "enter",
            });
          } else if (/^(Yes|No)\b/i.test(optLine.trim())) {
            const optNum = options.length + 1;
            const isYes = optLine.toLowerCase().startsWith("yes");
            options.push({
              id: `opt_${optNum}`,
              label: optLine.trim(),
              keyShortcut: isYes ? "enter" : "ctrl+c",
            });
          } else if (!cmdPayload && !optLine.startsWith("[")) {
            cmdPayload = optLine;
          }
        }

        if (options.length === 0) {
          options.push(
            { id: "opt_yes", label: "是，执行", keyShortcut: "y" },
            { id: "opt_no", label: "否，拒绝", keyShortcut: "n" }
          );
        }

        const interactionId = "int_" + createHash("sha256").update(question + i).digest("hex").slice(0, 10);
        const fingerprint = computeInteractionFingerprint(question, optionLines.join("\n"), options);

        const card: InteractionCardData = {
          id: computeCardId("interaction", startLine, cardIdx++),
          kind: "interaction",
          interactionId,
          title: "需要授权",
          question,
          payload: cmdPayload || optionLines.join("\n"),
          fingerprint,
          options,
          fallbackKeys: ["enter", "esc", "up", "down"],
        };

        cards.push(card);
        pendingInteraction = card;
        continue;
      }

      // 5. Natural Language / Markdown Card
      const startLine = trimmed;
      const mdLines: string[] = [line];
      i++;

      while (i < lines.length) {
        const nextTrimmed = lines[i].trim();
        if (
          nextTrimmed.startsWith("$ ") ||
          nextTrimmed.startsWith("❯ ") ||
          nextTrimmed.startsWith("● ") ||
          nextTrimmed.startsWith("○ ") ||
          nextTrimmed.startsWith("diff --git") ||
          nextTrimmed.startsWith("@@ ") ||
          nextTrimmed.startsWith("+ Thought") ||
          nextTrimmed.startsWith("Thinking...") ||
          nextTrimmed.startsWith("▸ Thought") ||
          nextTrimmed.endsWith("?") ||
          nextTrimmed.match(/^(Allow|Do you want to|Select|Choose|\(y\/n\))/i)
        ) {
          break;
        }
        mdLines.push(lines[i]);
        i++;
      }

      const cleanedMdLines = mdLines
        .filter((l) => {
          const t = l.trim();
          if (!t) return false;
          const blockChars = (t.match(/[\u2580-\u259F\u25A0-\u25FF]/g) || []).length;
          const words = t.match(/[a-zA-Z0-9_\u4e00-\u9fa5]{3,}/g) || [];
          return !(blockChars > 0 && words.length === 0);
        })
        .map((l) => l.trim().replace(/^[\s\u2580-\u259F\u25A0-\u25FF╹╻]+/, "").trim())
        .filter((l) => l.length > 0);

      const content = cleanedMdLines.join("\n").trim();
      if (content) {
        cards.push({
          id: computeCardId("markdown", startLine, cardIdx++),
          kind: "markdown",
          content,
        });
      }
    }

    return { cards, pendingInteraction };
  }
}
