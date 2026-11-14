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
import { targetForInput, verbForName } from "../sessions/common";

export interface OpenCodeAdapterOptions {
  dbPath?: string;
}

export const OPENCODE_PLACEHOLDER_TITLE = /^New session - \d{4}-\d{2}-\d{2}T/;

interface CachedOpenCodeSession {
  /** The session row's and its messages' update marks; OpenCode updates message rows without touching the session row. */
  changeKey: string | null;
  turns: NormalizedTurn[];
  stats?: SessionStats;
  sessionTitle?: string;
  model?: string;
}

export class OpenCodeAdapter {
  private dbPath: string;
  private cache = new Map<string, CachedOpenCodeSession>();

  constructor(options: OpenCodeAdapterOptions = {}) {
    if (options.dbPath) {
      this.dbPath = options.dbPath;
    } else {
      const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
      this.dbPath = join(dataHome, "opencode", "opencode.db");
    }
  }

  public getDbPath(): string {
    return this.dbPath;
  }

  public isAvailable(): boolean {
    return existsSync(this.dbPath);
  }

  /** Opens a single read-only SQLite connection to detect schema (`session_v2` vs legacy `session`). */
  public withDb<T>(fn: (db: Database, sessionTable: "session_v2" | "session") => T): T | null {
    if (!this.isAvailable()) return null;
    const db = new Database(this.dbPath, { readonly: true });
    try {
      db.run("PRAGMA query_only = ON;");
      db.run("PRAGMA busy_timeout = 2000;");
      const row = db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session') ORDER BY CASE name WHEN 'session_v2' THEN 0 ELSE 1 END LIMIT 1"
        )
        .get() as { name?: string } | null;
      const table: "session_v2" | "session" = row?.name === "session" ? "session" : "session_v2";
      return fn(db, table);
    } finally {
      db.close();
    }
  }

  public getTurns(
    sessionId: string,
    incremental = false
  ): {
    turns: NormalizedTurn[];
    stats?: SessionStats;
    sessionTitle?: string;
    model?: string;
  } {
    if (!this.isAvailable()) {
      return { turns: [] };
    }
    if (!incremental) this.cache.delete(sessionId);

    return (
      this.withDb((db, sessionTable) => {
        const sessionSelect =
          sessionTable === "session_v2"
            ? "SELECT title, time_updated, summary_additions, summary_deletions, summary_files, summary_diffs FROM session_v2 WHERE id = ? LIMIT 1"
            : "SELECT title, time_updated FROM session WHERE id = ? LIMIT 1";
        const sessionRow: any = db.query(sessionSelect).get(sessionId);

        const timeUpdated: number | null = typeof sessionRow?.time_updated === "number" ? sessionRow.time_updated : null;
        const marks = db
          .query("SELECT COUNT(*) AS n, MAX(time_updated) AS t FROM session_message WHERE session_id = ?")
          .get(sessionId) as { n: number; t: number | null } | null;
        const changeKey = timeUpdated === null ? null : `${timeUpdated}|${marks?.n ?? 0}|${marks?.t ?? ""}`;
        const cached = this.cache.get(sessionId);
        if (incremental && cached && changeKey !== null && cached.changeKey === changeKey) {
          return {
            turns: cached.turns,
            stats: cached.stats,
            sessionTitle: cached.sessionTitle,
            ...(cached.model ? { model: cached.model } : {}),
          };
        }

        // 1. Fetch Session stats if available
        let stats: SessionStats | undefined;
        if (sessionRow && sessionTable === "session_v2") {
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
            } catch {
              // ignore corrupt summary_diffs JSON
            }
          }

          stats = {
            filesModified: sessionRow.summary_files || diffs?.length || 0,
            additions: sessionRow.summary_additions || 0,
            deletions: sessionRow.summary_deletions || 0,
            diffs,
          };
        }

        // 2. Fetch messages for the session inside the same DB connection
        const messages: any[] = db
          .query(
            "SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq ASC, time_created ASC"
          )
          .all(sessionId);

        const turns: NormalizedTurn[] = [];
        let currentTurn: NormalizedTurn | null = null;
        let turnCounter = 0;
        let model: string | undefined;
        let lastTs = typeof sessionRow?.time_updated === "number" ? sessionRow.time_updated : 0;

        for (const msg of messages) {
          let data: any = {};
          try {
            data = JSON.parse(msg.data);
          } catch {
            continue;
          }

          const msgType = msg.type || data.role;
          const rawTs = msg.time_created || data.time?.created;
          const timestamp = typeof rawTs === "number" && rawTs > 0 ? rawTs : lastTs;
          if (typeof rawTs === "number" && rawTs > 0) lastTs = rawTs;

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
              updatedAt: timestamp,
              userPrompt: {
                text: userText,
                files: userFiles,
              },
              toolCalls: [],
              items: [],
            };
          } else if (msgType === "assistant") {
            if (typeof data?.model?.providerID === "string" && typeof data?.model?.id === "string") {
              model = `${data.model.providerID}/${data.model.id}`;
            }
            if (!currentTurn) {
              turnCounter++;
              currentTurn = {
                turnId: msg.id || `turn_${turnCounter}`,
                turnNumber: turnCounter,
                timestamp,
                updatedAt: timestamp,
                toolCalls: [],
                items: [],
              };
            }
            currentTurn.updatedAt = Math.max(currentTurn.updatedAt ?? currentTurn.timestamp, timestamp);

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

                const toolInput = toolState.input || item.input || {};
                const target = targetForInput(toolInput);
                const description = typeof toolInput?.description === "string" ? toolInput.description : undefined;
                const toolCall: NormalizedToolCall = {
                  id: item.id || item.callID || `tool_${msg.id}_${currentTurn.toolCalls?.length ?? 0}`,
                  name: item.name || item.tool || "tool",
                  verb: verbForName(item.name || item.tool || ""),
                  ...(target ? { target } : {}),
                  ...(description ? { description } : {}),
                  input: toolInput,
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
                currentTurn.items = currentTurn.items || [];
                currentTurn.items.push({ kind: "tool", call: toolCall });
              } else if (item.type === "text") {
                const textChunk = item.text || item.content || "";
                if (textChunk) {
                  currentTurn.items = currentTurn.items || [];
                  currentTurn.items.push({ kind: "text", markdown: textChunk });
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

        const isPlaceholder = typeof sessionRow?.title === "string" && OPENCODE_PLACEHOLDER_TITLE.test(sessionRow.title);
        const sessionTitle = typeof sessionRow?.title === "string" && sessionRow.title && !isPlaceholder ? sessionRow.title : undefined;
        const result = { turns, stats, sessionTitle, ...(model ? { model } : {}) };
        this.cache.set(sessionId, { changeKey, ...result });
        return result;
      }) ?? { turns: [] }
    );
  }
}
