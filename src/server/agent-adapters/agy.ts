import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  NormalizedToolCall,
  NormalizedTurn,
  SessionStats,
} from "../../shared/agent-session";
import { targetForInput, verbForName } from "../sessions/common";

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

  private normalizeModelId(raw: string): string | undefined {
    if (!raw || raw === "None") return undefined;
    if (/^[a-z0-9._-]+$/.test(raw)) return raw;
    return raw
      .toLowerCase()
      .replace(/[()]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/opus-(\d+)\.(\d+)/g, "opus-$1-$2")
      .replace(/sonnet-(\d+)\.(\d+)/g, "sonnet-$1-$2");
  }

  private getDefaultModel(): string | undefined {
    const settingsPath = join(dirname(this.baseBrainDir), "settings.json");
    if (existsSync(settingsPath)) {
      try {
        const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
        if (typeof data.model === "string" && data.model) {
          return this.normalizeModelId(data.model.trim());
        }
      } catch {}
    }
    return undefined;
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
    const model = () => this.cachedModels.get(sessionId) || this.getDefaultModel();
    const logPath = this.getSessionLogPath(sessionId);
    if (!incremental) this.resetCache(sessionId);
    if (!existsSync(logPath)) {
      return { turns: [], sessionTitle: title, ...(model() ? { model: model() } : {}) };
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
        return { turns: this.cachedTurns.get(sessionId)!, sessionTitle: title, ...(model() ? { model: model() } : {}) };
      }

      const bytesToRead = totalBytes - startOffset;
      const buffer = Buffer.alloc(bytesToRead);

      fd = openSync(logPath, "r");
      readSync(fd, buffer, 0, bytesToRead, startOffset);

      // agent-session-normalization.md §4.2: only whole lines are parsed. The offset stops after the
      // last newline, so a half-written line (and any split UTF-8 character) is read again in full.
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline === -1) return { turns: this.cachedTurns.get(sessionId) || [], sessionTitle: title, ...(model() ? { model: model() } : {}) };
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

        if (recType === "USER_INPUT") {
          // Detect model change in <USER_SETTINGS_CHANGE>
          const rawContent = record.content || "";
          const modelMatch = rawContent.match(
            /The user changed setting `Model Selection` from .*? to (.+?)\.(?:\s+No need|\s*<\/USER_SETTINGS_CHANGE>|$)/
          );
          if (modelMatch && modelMatch[1]) {
            const norm = this.normalizeModelId(modelMatch[1].trim());
            if (norm) this.cachedModels.set(sessionId, norm);
          }

          // Clean prompt: extract content from <USER_REQUEST> if wrapped
          let promptText = record.content || "";
          const match = promptText.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          if (match) {
            promptText = match[1].trim();
          }

          turnCounter++;
          currentTurn = {
            turnId: `turn_${turnCounter}`,
            turnNumber: turnCounter,
            timestamp,
            userPrompt: {
              text: promptText,
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
              toolCalls: [],
              items: [],
            };
            turns.push(currentTurn);
          }

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
              const args = tc.args || {};
              const target = targetForInput(args);
              const description =
                typeof args.toolSummary === "string"
                  ? args.toolSummary
                  : typeof args.description === "string"
                  ? args.description
                  : undefined;
              const call: NormalizedToolCall = {
                id: `tc_${currentTurn.turnNumber}_${currentTurn.toolCalls.length}`,
                name: tc.name || "tool",
                verb: verbForName(tc.name || ""),
                ...(target ? { target } : {}),
                ...(description ? { description } : {}),
                input: args,
                status: "completed",
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

      this.cachedTurns.set(sessionId, turns);
      return { turns, sessionTitle: title, ...(model() ? { model: model() } : {}) };
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
