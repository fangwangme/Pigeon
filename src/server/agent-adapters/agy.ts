import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  NormalizedTurn,
  NormalizedToolCall,
  SessionStats,
} from "../../shared/agent-session";

export interface AgyAdapterOptions {
  baseBrainDir?: string;
}

export class AgyAdapter {
  private baseBrainDir: string;
  private byteOffsets = new Map<string, number>();
  private partialLineBuffers = new Map<string, string>();
  private cachedTurns = new Map<string, NormalizedTurn[]>();

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

  public getSessionTitle(sessionId: string): string | null {
    try {
      const annotPath = join(
        homedir(),
        ".gemini",
        "antigravity-cli",
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
    } catch {}
    return null;
  }

  public getTurns(
    sessionId: string,
    incremental = false
  ): { turns: NormalizedTurn[]; stats?: SessionStats; sessionTitle?: string } {
    const title = this.getSessionTitle(sessionId) || undefined;
    const logPath = this.getSessionLogPath(sessionId);
    if (!existsSync(logPath)) {
      return { turns: [], sessionTitle: title };
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
          this.partialLineBuffers.delete(sessionId);
        }
      }

      if (startOffset === totalBytes && this.cachedTurns.has(sessionId)) {
        return { turns: this.cachedTurns.get(sessionId)! };
      }

      const bytesToRead = totalBytes - startOffset;
      const buffer = Buffer.alloc(bytesToRead);

      fd = openSync(logPath, "r");
      readSync(fd, buffer, 0, bytesToRead, startOffset);

      const chunkStr = buffer.toString("utf-8");
      const prevPartial = this.partialLineBuffers.get(sessionId) || "";
      const fullText = prevPartial + chunkStr;

      // Find the last newline to avoid parsing a truncated incomplete JSON line at EOF
      const lastNewlineIdx = fullText.lastIndexOf("\n");
      if (lastNewlineIdx === -1) {
        // Entire chunk is incomplete, wait for newline
        this.partialLineBuffers.set(sessionId, fullText);
        return { turns: this.cachedTurns.get(sessionId) || [] };
      }

      const completeChunk = fullText.slice(0, lastNewlineIdx);
      const trailingUnfinished = fullText.slice(lastNewlineIdx + 1);

      this.partialLineBuffers.set(sessionId, trailingUnfinished);
      this.byteOffsets.set(sessionId, startOffset + bytesToRead - Buffer.byteLength(trailingUnfinished, "utf-8"));

      const lines = completeChunk.split("\n");
      const turns: NormalizedTurn[] = incremental
        ? [...(this.cachedTurns.get(sessionId) || [])]
        : [];

      let currentTurn: NormalizedTurn | null =
        turns.length > 0 ? turns[turns.length - 1] : null;
      let turnCounter = turns.length;

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

        const recType = record.type;
        const timestamp = record.created_at
          ? new Date(record.created_at).getTime()
          : Date.now();

        if (recType === "USER_INPUT") {
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
            for (const tc of record.tool_calls) {
              currentTurn.toolCalls.push({
                id: `tc_${Date.now()}_${Math.random()}`,
                name: tc.name || "tool",
                input: tc.args || {},
                status: "completed",
              });
            }
          }

          if (record.content) {
            currentTurn.assistantResponse = {
              markdown: currentTurn.assistantResponse?.markdown
                ? currentTurn.assistantResponse.markdown + "\n" + record.content
                : record.content,
              isStreaming: false,
            };
          }
        } else if (recType === "GENERIC") {
          // Output of tools or command execution
          if (currentTurn?.toolCalls && currentTurn.toolCalls.length > 0) {
            const lastTc = currentTurn.toolCalls[currentTurn.toolCalls.length - 1];
            if (!lastTc.output && record.content) {
              lastTc.output = record.content;
            }
          }
        }
      }

      this.cachedTurns.set(sessionId, turns);
      return { turns, sessionTitle: title };
    } catch {
      return { turns: [], sessionTitle: title };
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
    }
  }

  public resetCache(sessionId?: string): void {
    if (sessionId) {
      this.byteOffsets.delete(sessionId);
      this.partialLineBuffers.delete(sessionId);
      this.cachedTurns.delete(sessionId);
    } else {
      this.byteOffsets.clear();
      this.partialLineBuffers.clear();
      this.cachedTurns.clear();
    }
  }
}
