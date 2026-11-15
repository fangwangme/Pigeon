import { Database } from "bun:sqlite";
import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  FileDiffSummary,
  NormalizedQuestion,
  NormalizedToolCall,
  NormalizedTurn,
  SessionStats,
  SubagentInfo,
  ToolVerb,
} from "../../shared/agent-session";
import { lineDiff, pushFoldedError, targetForInput, verbForName } from "../sessions/common";

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

function parseAgyQuestions(id: string, raw: unknown): NormalizedQuestion | undefined {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(list)) return undefined;
  const questions = list
    .filter((q: any): q is Record<string, any> => q && typeof q === "object" && typeof q.question === "string")
    .map((q) => ({
      question: q.question,
      ...(typeof q.is_multi_select === "boolean" ? { multiSelect: q.is_multi_select } : {}),
      options: Array.isArray(q.options)
        ? q.options
            .map((o: any) =>
              typeof o === "string"
                ? { label: o }
                : o && typeof o.label === "string"
                ? { label: o.label, ...(typeof o.description === "string" ? { description: o.description } : {}) }
                : null
            )
            .filter((x): x is { label: string; description?: string } => x !== null)
        : [],
    }));
  return questions.length > 0 ? { id, questions } : undefined;
}

/** agent-session-normalization.md §2.2: the label a "Model Selection" settings change names, if any. */
export function agyModelSetting(content: string): string | undefined {
  const m = content.match(/The user changed setting `Model Selection` from .*? to `?(.+?)`?\.(?:\s+No need|\s*<\/USER_SETTINGS_CHANGE>|$)/);
  const raw = m?.[1]?.replace(/^`+|`+$/g, "").trim();
  return raw && raw !== "None" ? raw : undefined;
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

  private withSummariesDb<T>(fallback: T, fn: (db: Database) => T): T {
    const dbPath = join(dirname(this.baseBrainDir), "conversation_summaries.db");
    if (!existsSync(dbPath)) return fallback;
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        db.run("PRAGMA query_only = ON;");
        db.run("PRAGMA busy_timeout = 2000;");
        return fn(db);
      } finally {
        db.close();
      }
    } catch {
      return fallback;
    }
  }

  /** `agent-session-normalization.md` §2.2: child conversations with `parent_conversation_id` are never bound to a pane. */
  public getChildConversationIds(): Set<string> {
    return this.withSummariesDb(new Set<string>(), (db) => {
      const rows = db
        .query("SELECT conversation_id FROM conversation_summaries WHERE parent_conversation_id IS NOT NULL AND parent_conversation_id != ''")
        .all() as Array<{ conversation_id: string }>;
      return new Set(rows.map((r) => r.conversation_id));
    });
  }

  /** `agent-session-normalization.md` §2.2 & §3.4: sub-agents started by `sessionId`, ordered by `last_user_input_time`. */
  public getSubagents(sessionId: string): SubagentInfo[] {
    return this.withSummariesDb([], (db) => {
      const rows = db
        .query(
          "SELECT conversation_id, title, agent_name, status, killed FROM conversation_summaries WHERE parent_conversation_id = ? ORDER BY last_user_input_time ASC"
        )
        .all(sessionId) as Array<{
          conversation_id: string;
          title: string | null;
          agent_name: string | null;
          status: string | null;
          killed: number | null;
        }>;
      return rows.map((r) => {
        const status: SubagentInfo["status"] =
          Number(r.killed) === 1
            ? "failed"
            : !r.status || r.status === "CASCADE_RUN_STATUS_IDLE"
            ? "completed"
            : "running";
        return {
          id: r.conversation_id,
          title: r.title || r.agent_name || r.conversation_id,
          ...(r.agent_name ? { type: r.agent_name } : {}),
          status,
        };
      });
    });
  }

  public getTurns(
    sessionId: string,
    incremental = false,
    includeSubagents = true
  ): { turns: NormalizedTurn[]; stats?: SessionStats; sessionTitle?: string; model?: string; subagents?: SubagentInfo[] } {
    const title = this.getSessionTitle(sessionId) || undefined;
    const subagents = includeSubagents ? this.getSubagents(sessionId) : [];
    const subField = subagents.length > 0 ? { subagents } : {};
    const logPath = this.getSessionLogPath(sessionId);
    if (!incremental) this.resetCache(sessionId);
    const model = this.cachedModels.get(sessionId);
    if (!existsSync(logPath)) {
      return { turns: [], sessionTitle: title, ...(model ? { model } : {}), ...subField };
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
        return { turns: this.cachedTurns.get(sessionId)!, sessionTitle: title, ...(model ? { model } : {}), ...subField };
      }

      const bytesToRead = totalBytes - startOffset;
      const buffer = Buffer.alloc(bytesToRead);

      fd = openSync(logPath, "r");
      readSync(fd, buffer, 0, bytesToRead, startOffset);

      // agent-session-normalization.md §4.2: only whole lines are parsed. The offset stops after the
      // last newline, so a half-written line (and any split UTF-8 character) is read again in full.
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline === -1) return { turns: this.cachedTurns.get(sessionId) || [], sessionTitle: title, ...(model ? { model } : {}), ...subField };
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
      let lastTs = stat.birthtimeMs || stat.mtimeMs || 0;
      let pendingAttachmentFiles: string[] = [];

      const ensureTurn = (timestamp: number): NormalizedTurn => {
        if (!currentTurn) {
          turnCounter++;
          currentTurn = {
            turnId: `turn_${turnCounter}`,
            turnNumber: turnCounter,
            timestamp,
            updatedAt: timestamp,
            ...(pendingAttachmentFiles.length > 0 ? { userPrompt: { text: "", files: pendingAttachmentFiles } } : {}),
            toolCalls: [],
            items: [],
          };
          pendingAttachmentFiles = [];
          turns.push(currentTurn);
        }
        currentTurn.updatedAt = Math.max(currentTurn.updatedAt ?? currentTurn.timestamp, timestamp);
        return currentTurn;
      };

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
        const parsedTs = record.created_at ? new Date(record.created_at).getTime() : NaN;
        const timestamp = Number.isFinite(parsedTs) ? parsedTs : lastTs;
        if (Number.isFinite(parsedTs)) lastTs = parsedTs;

        const rawContent = record.content || "";
        const model = agyModelSetting(rawContent);
        if (model) this.cachedModels.set(sessionId, model);

        if (recType === "USER_INPUT") {
          // Clean prompt: extract content from <USER_REQUEST> if wrapped
          let promptText = record.content || "";
          const match = promptText.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          if (match) {
            promptText = match[1].trim();
          }

          const files: string[] = [...pendingAttachmentFiles];
          pendingAttachmentFiles = [];
          const keptLines: string[] = [];
          const rawLines = promptText.split("\n");
          let end = rawLines.length;
          while (end > 0) {
            const candidate = rawLines[end - 1].trim();
            if (!candidate) {
              end--;
              continue;
            }
            const uploadTag = /^\[Pigeon user uploaded attachment:\s*(.+?)\]$/.exec(candidate);
            if (uploadTag) {
              files.push(uploadTag[1].trim());
              end--;
              continue;
            }
            const uploadPath = /^@?(\/[^\s]*(?:\/uploads\/[^\s]+|up_[0-9a-f]{16}[^\s]*))$/.exec(candidate);
            if (uploadPath) {
              files.push(uploadPath[1]);
              end--;
              continue;
            }
            break;
          }
          for (let li = 0; li < end; li++) {
            const candidate = rawLines[li].trim();
            const uploadTag = /^\[Pigeon user uploaded attachment:\s*(.+?)\]$/.exec(candidate);
            if (uploadTag) {
              files.push(uploadTag[1].trim());
            } else {
              keptLines.push(rawLines[li]);
            }
          }
          const cleanText = keptLines.join("\n").trim();

          if (Array.isArray(record.media)) {
            for (const m of record.media) {
              if (m && typeof m.uri === "string" && m.uri) files.push(m.uri);
            }
          }

          if (!cleanText && files.length > 0) {
            pendingAttachmentFiles.push(...files);
            continue;
          }

          turnCounter++;
          currentTurn = {
            turnId: `turn_${turnCounter}`,
            turnNumber: turnCounter,
            timestamp,
            updatedAt: timestamp,
            userPrompt: {
              text: cleanText,
              ...(files.length > 0 ? { files } : {}),
            },
            toolCalls: [],
            items: [],
          };
          turns.push(currentTurn);
        } else if (recType === "PLANNER_RESPONSE") {
          const turn = ensureTurn(timestamp);

          if (record.thinking) {
            turn.reasoning = {
              text: turn.reasoning?.text
                ? turn.reasoning.text + "\n" + record.thinking
                : record.thinking,
            };
          }

          if (Array.isArray(record.tool_calls)) {
            turn.toolCalls = turn.toolCalls || [];
            turn.items = turn.items || [];
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
                id: `tc_${turn.turnNumber}_${turn.toolCalls.length}`,
                name: tc.name || "tool",
                verb,
                ...(target ? { target } : {}),
                ...(description ? { description } : {}),
                input: cleanedArgs,
                status: "running",
                ...(diffInfo?.diff ? { diff: diffInfo.diff } : {}),
              };
              turn.toolCalls.push(call);
              turn.items.push({ kind: "tool", call });
            }
          }

          if (record.content) {
            turn.items = turn.items || [];
            turn.items.push({ kind: "text", markdown: record.content });
            turn.assistantResponse = {
              markdown: turn.assistantResponse?.markdown
                ? turn.assistantResponse.markdown + "\n" + record.content
                : record.content,
              isStreaming: false,
            };
          }
        } else if (recType === "GENERIC") {
          const pending = currentTurn?.toolCalls?.find((tc) => tc.output === undefined);
          if (pending) {
            const out = typeof record.content === "string" ? record.content : "";
            pending.output = out;
            if (record.status === "RUNNING") {
              pending.status = "running";
            } else {
              const exitMatch = /^Command exited with code (\d+)/m.exec(out);
              const failedByExit = exitMatch !== null && Number(exitMatch[1]) !== 0;
              pending.status = record.status === "ERROR" || failedByExit ? "failed" : "completed";
            }
          }
        } else if (recType === "SYSTEM_MESSAGE") {
          const content = typeof record.content === "string" ? record.content : "";
          const taskMatch = /Task id "([^"]+)" (finished|was canceled) with result:/.exec(content);
          if (taskMatch) {
            const taskId = taskMatch[1];
            const outcome = taskMatch[2] === "finished" ? "completed" : "failed";
            const sender = typeof record.sender === "string" ? record.sender : "";
            if (!sender || sender === taskId) {
              for (let ti = turns.length - 1; ti >= 0; ti--) {
                const matchCall = [...(turns[ti].toolCalls ?? [])].reverse().find((tc) => {
                  if (tc.status !== "running" || typeof tc.output !== "string") return false;
                  const idMatch = /task id:\s*([^\s.,;)]+)/i.exec(tc.output);
                  return idMatch?.[1] === taskId;
                });
                if (matchCall) {
                  matchCall.status = outcome;
                  turns[ti].updatedAt = Math.max(turns[ti].updatedAt ?? turns[ti].timestamp, timestamp);
                  break;
                }
              }
            }
          }
        } else if (recType === "ERROR_MESSAGE") {
          const turn = ensureTurn(timestamp);
          turn.items = turn.items || [];
          const errText =
            typeof record.error === "string" && record.error
              ? record.error
              : typeof record.content === "string"
              ? record.content
              : "";
          const errKind =
            typeof record.error_code === "string" && record.error_code ? record.error_code : "unknown";
          pushFoldedError(turn.items, errKind, errText);
        } else if (recType === "CHECKPOINT") {
          const turn = ensureTurn(timestamp);
          turn.items = turn.items || [];
          turn.items.push({ kind: "compact", summary: typeof record.content === "string" ? record.content : "" });
        }
      }

      for (const t of turns) {
        delete t.pendingQuestion;
        delete t.pendingPlan;
      }
      const last = turns[turns.length - 1];
      if (last?.toolCalls) {
        const qCall = [...last.toolCalls].reverse().find((c) => c.name === "ask_question" && c.status === "running" && c.output === undefined);
        if (qCall && typeof qCall.input === "object" && qCall.input !== null) {
          const parsed = parseAgyQuestions(qCall.id, (qCall.input as Record<string, any>).questions);
          if (parsed) last.pendingQuestion = parsed;
        }
        const pCall = [...last.toolCalls].reverse().find((c) => c.name === "exit_plan_mode" && c.status === "running" && c.output === undefined);
        const plan = pCall && typeof pCall.input === "object" && pCall.input !== null ? (pCall.input as Record<string, any>).plan : undefined;
        if (typeof plan === "string" && plan) last.pendingPlan = { markdown: plan };
      }

      const stats = computeSessionStats(turns);
      this.cachedTurns.set(sessionId, turns);
      const finalModel = this.cachedModels.get(sessionId);
      return { turns, stats, sessionTitle: title, ...(finalModel ? { model: finalModel } : {}), ...subField };
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
