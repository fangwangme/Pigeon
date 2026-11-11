import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  FileDiffSummary,
  NormalizedToolCall,
  NormalizedTurn,
  SessionStats,
  ToolVerb,
} from "../../shared/agent-session";
import { lineDiff, targetForInput, verbForName } from "../sessions/common";

function cleanArgValue(val: unknown): any {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
      try {
        const parsed = JSON.parse(trimmed);
        return parsed;
      } catch {
        return val;
      }
    }
    return val;
  }
  if (Array.isArray(val)) return val.map(cleanArgValue);
  if (typeof val === "object" && val !== null) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) out[k] = cleanArgValue(v);
    return out;
  }
  return val;
}

function boolArg(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    return s === "true" || s === "1";
  }
  return false;
}

function extractAgyDiff(name: string, args: Record<string, any>): { diff?: FileDiffSummary; verb?: ToolVerb } | undefined {
  const filePath = (args.Path || args.path || args.filePath || args.file_path) as string | undefined;
  if (!filePath || typeof filePath !== "string") return undefined;

  const n = name.toLowerCase();
  if (n.includes("edit") || n.includes("replace") || n.includes("patch")) {
    const target = (args.Target ?? args.target ?? args.old_string ?? args.oldText ?? "") as string;
    const replacement = (args.Replacement ?? args.replacement ?? args.new_string ?? args.newText ?? "") as string;
    return {
      verb: "edit",
      diff: lineDiff(filePath, typeof target === "string" ? target : "", typeof replacement === "string" ? replacement : "", "modified"),
    };
  }

  if (n.includes("write")) {
    const content = (args.Content ?? args.content ?? "") as string;
    const overwrite = boolArg(args.Overwrite ?? args.overwrite);
    const append = boolArg(args.Append ?? args.append);
    const isEdit = overwrite || append;
    return {
      verb: isEdit ? "edit" : "create",
      diff: lineDiff(filePath, "", typeof content === "string" ? content : "", isEdit ? "modified" : "created"),
    };
  }

  return undefined;
}

function computeSessionStats(turns: NormalizedTurn[]): SessionStats {
  const fileOrder: string[] = [];
  const perFile = new Map<string, FileDiffSummary>();
  for (const t of turns) {
    for (const c of t.toolCalls || []) {
      if (!c.diff) continue;
      const d = c.diff;
      if (!fileOrder.includes(d.filePath)) fileOrder.push(d.filePath);
      const cur = perFile.get(d.filePath);
      if (!cur) {
        perFile.set(d.filePath, { ...d });
      } else {
        cur.additions += d.additions;
        cur.deletions += d.deletions;
        if (d.patch) cur.patch = (cur.patch ? cur.patch + "\n" : "") + d.patch;
      }
    }
  }
  const diffs = fileOrder.map((f) => perFile.get(f)).filter((d): d is FileDiffSummary => !!d);
  return {
    filesModified: diffs.length,
    additions: diffs.reduce((n, d) => n + d.additions, 0),
    deletions: diffs.reduce((n, d) => n + d.deletions, 0),
    diffs,
  };
}

export interface AgyAdapterOptions {
  baseBrainDir?: string;
}

export class AgyAdapter {
  private baseBrainDir: string;
  private byteOffsets = new Map<string, number>();
  private cachedTurns = new Map<string, NormalizedTurn[]>();
  private cachedModels = new Map<string, string>();

  constructor(options: AgyAdapterOptions = {}) {
    this.baseBrainDir =
      options.baseBrainDir ||
      join(homedir(), ".gemini", "antigravity-cli", "brain");
  }

  public getSessionLogPath(sessionId: string): string {
    return join(
      this.baseBrainDir,
      sessionId,
      ".system_generated",
      "logs",
      "transcript.jsonl"
    );
  }

  public isAvailable(sessionId: string): boolean {
    return existsSync(this.getSessionLogPath(sessionId));
  }

  private getSessionTitle(sessionId: string): string | null {
    const annotPath = join(
      dirname(this.baseBrainDir),
      "annotations",
      `${sessionId}.pbtxt`
    );
    if (existsSync(annotPath)) {
      const content = readFileSync(annotPath, "utf-8");
      const match = content.match(/title:\s*"([^"]+)"/);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }

  /** Reads `transcript_full.jsonl` on demand when `transcript.jsonl` reports `truncated_fields` (§2.2). */
  private loadFullRecords(sessionId: string): Map<number, any> {
    const map = new Map<number, any>();
    const fullPath = join(
      this.baseBrainDir,
      sessionId,
      ".system_generated",
      "logs",
      "transcript_full.jsonl"
    );
    if (!existsSync(fullPath)) return map;
    const lines = readFileSync(fullPath, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t);
        const key = typeof parsed.step_index === "number" ? parsed.step_index : i;
        map.set(key, parsed);
      } catch {
        // Skip malformed record
      }
    }
    return map;
  }

  public getTurns(
    sessionId: string,
    incremental = false
  ): { turns: NormalizedTurn[]; stats?: SessionStats; sessionTitle?: string; model?: string } {
    const title = this.getSessionTitle(sessionId) || undefined;
    const logPath = this.getSessionLogPath(sessionId);
    if (!incremental) this.resetCache(sessionId);
    const model = this.cachedModels.get(sessionId);
    if (!existsSync(logPath)) {
      return { turns: [], sessionTitle: title, ...(model ? { model } : {}) };
    }

    let fd: number | null = null;
    try {
      const stat = statSync(logPath);
      const totalBytes = stat.size;

      let startOffset = 0;
      if (incremental && this.byteOffsets.has(sessionId)) {
        startOffset = this.byteOffsets.get(sessionId)!;
        if (startOffset > totalBytes) {
          // File truncated or rotated, reset offset
          startOffset = 0;
          this.cachedTurns.delete(sessionId);
        }
      }

      if (startOffset === totalBytes && this.cachedTurns.has(sessionId)) {
        return { turns: this.cachedTurns.get(sessionId)!, sessionTitle: title, ...(model ? { model } : {}) };
      }

      const bytesToRead = totalBytes - startOffset;
      const buffer = Buffer.alloc(bytesToRead);

      fd = openSync(logPath, "r");
      readSync(fd, buffer, 0, bytesToRead, startOffset);

      // agent-session-normalization.md §4.2: only whole lines are parsed. The offset stops after the
      // last newline, so a half-written line (and any split UTF-8 character) is read again in full.
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline === -1) return { turns: this.cachedTurns.get(sessionId) || [], sessionTitle: title, ...(model ? { model } : {}) };
      const completeChunk = buffer.subarray(0, lastNewline).toString("utf-8");
      this.byteOffsets.set(sessionId, startOffset + lastNewline + 1);

      const lines = completeChunk.split("\n");
      const turns: NormalizedTurn[] = incremental
        ? [...(this.cachedTurns.get(sessionId) || [])]
        : [];

      let currentTurn: NormalizedTurn | null =
        turns.length > 0 ? turns[turns.length - 1] : null;
      let turnCounter = turns.length;
      let fullRecords: Map<number, any> | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let record: any;
        try {
          record = JSON.parse(trimmed);
        } catch {
          // Skip malformed record
          continue;
        }

        if (Array.isArray(record.truncated_fields) && record.truncated_fields.length > 0) {
          fullRecords ??= this.loadFullRecords(sessionId);
          const full = typeof record.step_index === "number" ? fullRecords.get(record.step_index) : undefined;
          if (full) record = full;
        }

        const recType = record.type;
        const timestamp = record.created_at
          ? new Date(record.created_at).getTime()
          : Date.now();

        const rawContent = record.content || "";
        const modelMatch = rawContent.match(
          /The user changed setting `Model Selection` from .*? to `?(.+?)`?\.(?:\s+No need|\s*<\/USER_SETTINGS_CHANGE>|$)/
        );
        if (modelMatch && modelMatch[1]) {
          const raw = modelMatch[1].replace(/^`+|`+$/g, "").trim();
          if (raw && raw !== "None") this.cachedModels.set(sessionId, raw);
        }

        if (recType === "USER_INPUT") {
          // Clean prompt: extract content from <USER_REQUEST> if wrapped
          let promptText = record.content || "";
          const match = promptText.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          if (match) {
            promptText = match[1].trim();
          }

          turnCounter++;
          // Extract attachment files from promptText if any
          const files: string[] = [];
          const uploadRegex = /(?:^|\s)(@?(\/[^\s]+?\.(?:png|jpg|jpeg|webp|gif|svg|pdf|txt|md|json)|@?\/[^\s]+?\/up_[0-9a-f]{16}[^\s]*))/gi;
          let cleanText = promptText;
          let m: RegExpExecArray | null;
          while ((m = uploadRegex.exec(promptText)) !== null) {
            const rawPath = m[1].replace(/^@/, "");
            files.push(rawPath);
            cleanText = cleanText.replace(m[0], " ").trim();
          }

          currentTurn = {
            turnId: `turn_${turnCounter}`,
            turnNumber: turnCounter,
            timestamp,
            updatedAt: timestamp,
            userPrompt: {
              text: cleanText || promptText,
              ...(files.length > 0 ? { files } : {}),
            },
            toolCalls: [],
            items: [],
          };
          turns.push(currentTurn);
        } else if (recType === "PLANNER_RESPONSE") {
          if (!currentTurn) {
            turnCounter++;
            currentTurn = {
              turnId: `turn_${turnCounter}`,
              turnNumber: turnCounter,
              timestamp,
              updatedAt: timestamp,
              toolCalls: [],
              items: [],
            };
            turns.push(currentTurn);
          }
          currentTurn.updatedAt = Math.max(currentTurn.updatedAt ?? currentTurn.timestamp, timestamp);

          if (record.thinking) {
            currentTurn.reasoning = {
              text: currentTurn.reasoning?.text
                ? currentTurn.reasoning.text + "\n" + record.thinking
                : record.thinking,
            };
          }

          if (Array.isArray(record.tool_calls)) {
            currentTurn.toolCalls = currentTurn.toolCalls || [];
            currentTurn.items = currentTurn.items || [];
            for (const tc of record.tool_calls) {
              const cleanedArgs = cleanArgValue(tc.args || {});
              const target = targetForInput(cleanedArgs);
              const description =
                typeof cleanedArgs.toolSummary === "string"
                  ? cleanedArgs.toolSummary
                  : typeof cleanedArgs.description === "string"
                  ? cleanedArgs.description
                  : undefined;
              const diffInfo = extractAgyDiff(tc.name || "", cleanedArgs);
              const verb: ToolVerb = diffInfo?.verb ?? verbForName(tc.name || "");
              const call: NormalizedToolCall = {
                id: `tc_${currentTurn.turnNumber}_${currentTurn.toolCalls.length}`,
                name: tc.name || "tool",
                verb,
                ...(target ? { target } : {}),
                ...(description ? { description } : {}),
                input: cleanedArgs,
                status: "completed",
                ...(diffInfo?.diff ? { diff: diffInfo.diff } : {}),
              };
              currentTurn.toolCalls.push(call);
              currentTurn.items.push({ kind: "tool", call });
            }
          }

          if (record.content) {
            currentTurn.items = currentTurn.items || [];
            currentTurn.items.push({ kind: "text", markdown: record.content });
            currentTurn.assistantResponse = {
              markdown: currentTurn.assistantResponse?.markdown
                ? currentTurn.assistantResponse.markdown + "\n" + record.content
                : record.content,
              isStreaming: false,
            };
          }
        } else if (recType === "GENERIC") {
          // Tool outputs arrive in call order; attach each to the first call still without output.
          const pending = currentTurn?.toolCalls?.find((tc) => tc.output === undefined);
          if (pending && record.content) {
            pending.output = record.content;
          }
        }
      }

      const stats = computeSessionStats(turns);
      this.cachedTurns.set(sessionId, turns);
      const finalModel = this.cachedModels.get(sessionId);
      return { turns, stats, sessionTitle: title, ...(finalModel ? { model: finalModel } : {}) };
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  public resetCache(sessionId?: string): void {
    if (sessionId) {
      this.byteOffsets.delete(sessionId);
      this.cachedTurns.delete(sessionId);
      this.cachedModels.delete(sessionId);
    } else {
      this.byteOffsets.clear();
      this.cachedTurns.clear();
      this.cachedModels.clear();
    }
  }
}
