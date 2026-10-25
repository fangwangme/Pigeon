import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  NormalizedTurn,
  NormalizedToolCall,
  FileDiffSummary,
  SessionStats,
} from "../../shared/agent-session";

export interface OpenCodeAdapterOptions {
  dbPath?: string;
}

export class OpenCodeAdapter {
  private dbPath: string;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.dbPath =
      options.dbPath ||
      join(homedir(), ".local", "share", "opencode", "opencode.db");
  }

  public getDbPath(): string {
    return this.dbPath;
  }

  public isAvailable(): boolean {
    return existsSync(this.dbPath);
  }

  public getTurns(sessionId: string): {
    turns: NormalizedTurn[];
    stats?: SessionStats;
  } {
    if (!this.isAvailable()) {
      return { turns: [] };
    }

    let db: Database | null = null;
    try {
      db = new Database(this.dbPath, { readonly: true });
      db.run("PRAGMA query_only = ON;");
      db.run("PRAGMA busy_timeout = 2000;");

      // 1. Fetch Session stats if available
      let stats: SessionStats | undefined;
      const sessionRow: any = db
        .query(
          "SELECT summary_additions, summary_deletions, summary_files, summary_diffs FROM session_v2 WHERE id = ? LIMIT 1"
        )
        .get(sessionId);

      if (sessionRow) {
        let diffs: FileDiffSummary[] | undefined;
        if (sessionRow.summary_diffs) {
          try {
            const rawDiffs = JSON.parse(sessionRow.summary_diffs);
            if (Array.isArray(rawDiffs)) {
              diffs = rawDiffs.map((d: any) => ({
                filePath: d.filePath || d.path || d.file || "unknown",
                status: d.status || "modified",
                additions: d.additions || 0,
                deletions: d.deletions || 0,
                patch: d.patch,
              }));
            }
          } catch {}
        }

        stats = {
          filesModified: sessionRow.summary_files || diffs?.length || 0,
          additions: sessionRow.summary_additions || 0,
          deletions: sessionRow.summary_deletions || 0,
          diffs,
        };
      }

      // 2. Fetch messages for the session
      const messages: any[] = db
        .query(
          "SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq ASC, time_created ASC"
        )
        .all(sessionId);

      const turns: NormalizedTurn[] = [];
      let currentTurn: NormalizedTurn | null = null;
      let turnCounter = 0;

      for (const msg of messages) {
        let data: any = {};
        try {
          data = JSON.parse(msg.data);
        } catch {
          continue;
        }

        const msgType = msg.type || data.role;
        const timestamp = msg.time_created || data.time?.created || Date.now();

        if (msgType === "user") {
          // Commit previous turn if exists
          if (currentTurn) {
            turns.push(currentTurn);
          }

          turnCounter++;
          const userText = data.text || (typeof data.content === "string" ? data.content : "");
          const userFiles = Array.isArray(data.files)
            ? data.files.map((f: any) => (typeof f === "string" ? f : f.path || f.name))
            : undefined;

          currentTurn = {
            turnId: msg.id || `turn_${turnCounter}`,
            turnNumber: turnCounter,
            timestamp,
            userPrompt: {
              text: userText,
              files: userFiles,
            },
            toolCalls: [],
          };
        } else if (msgType === "assistant") {
          if (!currentTurn) {
            turnCounter++;
            currentTurn = {
              turnId: msg.id || `turn_${turnCounter}`,
              turnNumber: turnCounter,
              timestamp,
              toolCalls: [],
            };
          }

          // Process parts / content array in assistant message
          const contentList: any[] = Array.isArray(data.content)
            ? data.content
            : Array.isArray(data.parts)
            ? data.parts
            : [];

          let assistantMarkdown = "";

          for (const item of contentList) {
            if (!item || typeof item !== "object") continue;

            if (item.type === "reasoning") {
              const reasoningText = item.text || item.reasoning || "";
              if (reasoningText) {
                currentTurn.reasoning = {
                  text: currentTurn.reasoning?.text
                    ? currentTurn.reasoning.text + "\n" + reasoningText
                    : reasoningText,
                  durationMs:
                    item.time?.completed && item.time?.created
                      ? item.time.completed - item.time.created
                      : undefined,
                };
              }
            } else if (item.type === "tool") {
              const toolState = item.state || {};
              const statusRaw = toolState.status || item.status;
              const status: "running" | "completed" | "failed" =
                statusRaw === "completed" || statusRaw === "done"
                  ? "completed"
                  : statusRaw === "error" || statusRaw === "failed"
                  ? "failed"
                  : "running";

              let outputStr = "";
              if (typeof toolState.output === "string") {
                outputStr = toolState.output;
              } else if (Array.isArray(toolState.content)) {
                outputStr = toolState.content
                  .map((c: any) => (typeof c === "string" ? c : c.text || JSON.stringify(c)))
                  .join("\n");
              }

              const toolCall: NormalizedToolCall = {
                id: item.id || item.callID || `tool_${msg.id}_${currentTurn.toolCalls?.length ?? 0}`,
                name: item.name || item.tool || "tool",
                input: toolState.input || item.input || {},
                output: outputStr || undefined,
                exitCode: toolState.exitCode,
                status,
                durationMs:
                  item.time?.completed && item.time?.ran
                    ? item.time.completed - item.time.ran
                    : undefined,
              };

              currentTurn.toolCalls = currentTurn.toolCalls || [];
              currentTurn.toolCalls.push(toolCall);
            } else if (item.type === "text") {
              const textChunk = item.text || item.content || "";
              if (textChunk) {
                assistantMarkdown = assistantMarkdown
                  ? assistantMarkdown + "\n" + textChunk
                  : textChunk;
              }
            }
          }

          if (assistantMarkdown) {
            currentTurn.assistantResponse = {
              markdown: currentTurn.assistantResponse?.markdown
                ? currentTurn.assistantResponse.markdown + "\n" + assistantMarkdown
                : assistantMarkdown,
              isStreaming: false,
            };
          }
        }
      }

      if (currentTurn) {
        turns.push(currentTurn);
      }

      return { turns, stats };
    } finally {
      db?.close();
    }
  }
}
