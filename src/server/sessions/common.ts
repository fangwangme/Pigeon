import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type {
  FileDiffSummary,
  NormalizedToolCall,
  NormalizedTurn,
  SessionStats,
  TodoItem,
  ToolVerb,
} from "../../shared/agent-session";

/** What one read of a session yields (`agent-session-normalization.md` §3). */
export interface SessionRead {
  turns: NormalizedTurn[];
  stats?: SessionStats;
  sessionTitle?: string;
  todos?: TodoItem[];
  model?: string;
}

/** `agent-session-normalization.md` §2.0: path → project slug used by Claude Code. */
export function claudeSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Reads only the bytes appended to a JSONL file since the last call, keeping a trailing partial
 * line until its newline arrives (`agent-session-normalization.md` §4). `reset` is true when the
 * file shrank, so the caller must rebuild from the returned records.
 */
export class JsonlTail {
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);

  constructor(public readonly path: string) {}

  public read(): { records: unknown[]; reset: boolean } {
    if (!existsSync(this.path)) return { records: [], reset: false };
    const size = statSync(this.path).size;
    let reset = false;
    if (size < this.offset) {
      this.offset = 0;
      this.partial = Buffer.alloc(0);
      reset = true;
    }
    if (size === this.offset) return { records: [], reset };
    const buf = Buffer.alloc(size - this.offset);
    const fd = openSync(this.path, "r");
    try {
      readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const combined = this.partial.length > 0 ? Buffer.concat([this.partial, buf]) : buf;
    const lastNl = combined.lastIndexOf(0x0a);
    if (lastNl === -1) {
      this.partial = combined;
      return { records: [], reset };
    }
    const complete = combined.subarray(0, lastNl).toString("utf-8");
    this.partial = combined.subarray(lastNl + 1);
    return { records: parseJsonLines(complete), reset };
  }
}

/** Session records are a trust boundary: a line that is not JSON is skipped (§1). */
function parseJsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // a malformed or foreign line: skipped by contract
    }
  }
  return out;
}

/** Reads the first line of a JSONL file without loading the rest. */
export function readFirstJsonLine(path: string, maxBytes = 65_536): any {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, n).toString("utf-8");
    const nl = text.indexOf("\n");
    return parseJsonLines(nl === -1 ? text : text.slice(0, nl))[0];
  } finally {
    closeSync(fd);
  }
}

/** Reads the head of a file as JSONL records (used for titles in listings). */
export function readHeadJsonLines(path: string, maxBytes = 262_144): unknown[] {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, n).toString("utf-8");
    const nl = n === maxBytes ? text.lastIndexOf("\n") : text.length;
    return parseJsonLines(text.slice(0, Math.max(0, nl)));
  } finally {
    closeSync(fd);
  }
}

export function readTailJsonLines(path: string, maxBytes = 262_144): unknown[] {
  const fd = openSync(path, "r");
  try {
    const stat = statSync(path);
    const len = stat.size;
    const bytesToRead = Math.min(len, maxBytes);
    const start = len - bytesToRead;
    const buf = Buffer.alloc(bytesToRead);
    readSync(fd, buf, 0, bytesToRead, start);
    const text = buf.toString("utf-8");
    const firstNl = start > 0 ? text.indexOf("\n") : -1;
    const slice = firstNl >= 0 ? text.slice(firstNl + 1) : text;
    return parseJsonLines(slice);
  } finally {
    closeSync(fd);
  }
}

export const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A guess of the verb from a tool name, for agents whose tools have no fixed mapping. */
export function verbForName(name: string): ToolVerb {
  const n = name.toLowerCase();
  if (/bash|shell|command|exec|terminal|run/.test(n)) return "run";
  if (/write|create/.test(n)) return "create";
  if (/edit|replace|patch|update_file/.test(n)) return "edit";
  if (/read|view|cat|open/.test(n)) return "read";
  if (/grep|glob|search|find|list|ls|fetch/.test(n)) return "search";
  return "other";
}

/** Extracts a display target (command, file path, search pattern, or URL) from tool arguments. */
export function targetForInput(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  return (
    str(input.command) ??
    str(input.CommandLine) ??
    str(input.cmd) ??
    str(input.filePath) ??
    str(input.file_path) ??
    str(input.path) ??
    str(input.Path) ??
    str(input.pattern) ??
    str(input.query) ??
    str(input.url)
  );
}

const MAX_DIFF_LINES = 2000;

/** Line-based diff of two texts as a unified patch (`agent-session-normalization.md` §3.1). */
export function lineDiff(filePath: string, oldText: string, newText: string, status: FileDiffSummary["status"]): FileDiffSummary {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const ops: Array<[" " | "-" | "+", string]> = [];
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    for (const l of a) ops.push(["-", l]);
    for (const l of b) ops.push(["+", l]);
  } else {
    // LCS table, then walk it front to back.
    const n = a.length;
    const m = b.length;
    const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push([" ", a[i]]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["-", a[i++]]);
      else ops.push(["+", b[j++]]);
    }
    while (i < n) ops.push(["-", a[i++]]);
    while (j < m) ops.push(["+", b[j++]]);
  }
  const additions = ops.filter((o) => o[0] === "+").length;
  const deletions = ops.filter((o) => o[0] === "-").length;
  const header = `--- ${status === "created" ? "/dev/null" : `a/${filePath}`}\n+++ b/${filePath}\n@@ -1,${a.length} +1,${b.length} @@\n`;
  const patch = header + ops.map(([k, l]) => k + l).join("\n");
  return { filePath, status, additions, deletions, patch };
}

/** Counts the `+`/`-` lines of patch hunks. */
export function countPatch(lines: string[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.startsWith("+") && !l.startsWith("+++")) additions++;
    else if (l.startsWith("-") && !l.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

export interface ToolUse {
  id: string;
  name: string;
  verb: ToolVerb;
  input: Record<string, unknown> | string;
  target?: string;
  description?: string;
  diffs?: FileDiffSummary[];
  todos?: TodoItem[];
  timestamp?: number;
}

/**
 * Builds turns from a stream of normalized events; agent parsers feed it record by record, so an
 * incremental read only feeds the new records.
 */
export class TurnBuilder {
  public turns: NormalizedTurn[] = [];
  public title?: string;
  public model?: string;
  public todos?: TodoItem[];
  private calls = new Map<string, { call: NormalizedToolCall; startedAt?: number; diffs?: FileDiffSummary[] }>();
  private fileOrder: string[] = [];

  private current(timestamp: number): NormalizedTurn {
    let turn = this.turns[this.turns.length - 1];
    if (!turn) {
      turn = { turnId: "turn_1", turnNumber: 1, timestamp, updatedAt: timestamp, toolCalls: [], items: [] };
      this.turns.push(turn);
    }
    turn.updatedAt = Math.max(turn.updatedAt ?? turn.timestamp, timestamp);
    return turn;
  }

  public prompt(text: string, timestamp: number, files?: string[]): void {
    const n = this.turns.length + 1;
    this.turns.push({
      turnId: `turn_${n}`,
      turnNumber: n,
      timestamp,
      updatedAt: timestamp,
      userPrompt: { text, ...(files && files.length ? { files } : {}) },
      toolCalls: [],
      items: [],
    });
  }

  public reasoning(text: string, timestamp: number): void {
    if (!text.trim()) return;
    const turn = this.current(timestamp);
    turn.reasoning = { text: turn.reasoning ? `${turn.reasoning.text}\n\n${text}` : text };
    turn.updatedAt = Math.max(turn.updatedAt ?? turn.timestamp, timestamp);
  }

  public text(markdown: string, timestamp: number): void {
    if (!markdown.trim()) return;
    const turn = this.current(timestamp);
    turn.items!.push({ kind: "text", markdown });
    turn.assistantResponse = { markdown };
    turn.updatedAt = Math.max(turn.updatedAt ?? turn.timestamp, timestamp);
  }

  public error(errorKind: string, text: string, timestamp: number): void {
    const turn = this.current(timestamp);
    turn.items!.push({ kind: "error", errorKind, text });
    turn.updatedAt = Math.max(turn.updatedAt ?? turn.timestamp, timestamp);
  }

  /** agent-session-normalization.md §3: a compaction, on the agent's side of the current turn. */
  public compact(summary: string, timestamp: number): void {
    const turn = this.current(timestamp);
    turn.items!.push({ kind: "compact", summary });
    turn.updatedAt = Math.max(turn.updatedAt ?? turn.timestamp, timestamp);
  }

  public touch(timestamp: number): void {
    const turn = this.turns[this.turns.length - 1];
    if (turn) turn.updatedAt = Math.max(turn.updatedAt ?? turn.timestamp, timestamp);
  }

  public toolUse(use: ToolUse, timestamp: number): void {
    const turn = this.current(timestamp);
    turn.updatedAt = Math.max(turn.updatedAt ?? turn.timestamp, timestamp);
    const call: NormalizedToolCall = {
      id: use.id,
      name: use.name,
      verb: use.verb,
      input: use.input,
      status: "running",
      ...(use.target ? { target: use.target } : {}),
      ...(use.description ? { description: use.description } : {}),
      ...(use.diffs && use.diffs[0] ? { diff: use.diffs[0] } : {}),
    };
    turn.toolCalls!.push(call);
    turn.items!.push({ kind: "tool", call });
    this.calls.set(use.id, { call, startedAt: use.timestamp, diffs: use.diffs });
    if (use.todos) {
      this.todos = use.todos;
      turn.items!.push({ kind: "todo", done: use.todos.filter((t) => t.status === "completed").length, total: use.todos.length });
    }
  }

  /** Attaches a result; `verb`/`diffStatus` let the result refine what the call did. */
  public toolResult(id: string, output: string | undefined, isError: boolean, timestamp?: number, exitCode?: number): NormalizedToolCall | undefined {
    const entry = this.calls.get(id);
    if (!entry) return undefined;
    const { call } = entry;
    if (output !== undefined) call.output = output;
    call.status = isError ? "failed" : "completed";
    if (exitCode !== undefined) call.exitCode = exitCode;
    if (timestamp !== undefined && entry.startedAt !== undefined && timestamp >= entry.startedAt) call.durationMs = timestamp - entry.startedAt;
    if (timestamp !== undefined) {
      const turn = this.turns.find((t) => t.toolCalls?.some((c) => c.id === id));
      if (turn) turn.updatedAt = Math.max(turn.updatedAt ?? turn.timestamp, timestamp);
    }
    if (!isError && entry.diffs) for (const d of entry.diffs) if (!this.fileOrder.includes(d.filePath)) this.fileOrder.push(d.filePath);
    return call;
  }

  public setDiffs(id: string, diffs: FileDiffSummary[]): void {
    const entry = this.calls.get(id);
    if (!entry) return;
    entry.diffs = diffs;
    entry.call.diff = diffs[0];
  }

  /** The session as the protocol carries it, with pending prompts and per-file changes. */
  public result(pendingQuestionTool?: string, pendingPlanTool?: string): SessionRead {
    const last = this.turns[this.turns.length - 1];
    for (const t of this.turns) {
      delete t.pendingQuestion;
      delete t.pendingPlan;
    }
    if (last) {
      for (const c of last.toolCalls || []) {
        if (c.status !== "running" || !isObj(c.input)) continue;
        if (c.name === pendingQuestionTool && Array.isArray(c.input.questions)) {
          last.pendingQuestion = {
            id: c.id,
            questions: (c.input.questions as any[]).filter(isObj).map((q) => ({
              question: str(q.question) ?? "",
              ...(str(q.header) ? { header: q.header } : {}),
              ...(typeof q.multiSelect === "boolean" ? { multiSelect: q.multiSelect } : {}),
              options: (Array.isArray(q.options) ? q.options : []).filter(isObj).map((o: any) => ({
                label: str(o.label) ?? "",
                ...(str(o.description) ? { description: o.description } : {}),
              })),
            })),
          };
        }
        if (c.name === pendingPlanTool && str(c.input.plan)) last.pendingPlan = { markdown: c.input.plan as string };
      }
    }
    // Per-file sums over completed edits, in first-touched order (§3.1).
    const perFile = new Map<string, FileDiffSummary>();
    for (const { call, diffs } of this.calls.values()) {
      if (call.status !== "completed" || !diffs) continue;
      for (const d of diffs) {
        const acc = perFile.get(d.filePath);
        if (!acc) perFile.set(d.filePath, { ...d });
        else {
          acc.additions += d.additions;
          acc.deletions += d.deletions;
          acc.patch = [acc.patch, d.patch].filter(Boolean).join("\n");
          if (d.status === "deleted") acc.status = "deleted";
        }
      }
    }
    const diffs = this.fileOrder.map((f) => perFile.get(f)).filter((d): d is FileDiffSummary => !!d);
    const stats: SessionStats | undefined = diffs.length
      ? {
          filesModified: diffs.length,
          additions: diffs.reduce((n, d) => n + d.additions, 0),
          deletions: diffs.reduce((n, d) => n + d.deletions, 0),
          diffs,
        }
      : undefined;
    return {
      turns: this.turns,
      ...(stats ? { stats } : {}),
      ...(this.title ? { sessionTitle: this.title } : {}),
      ...(this.todos ? { todos: this.todos } : {}),
      ...(this.model ? { model: this.model } : {}),
    };
  }
}

export function tsOf(v: unknown, fallback = 0): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return fallback;
}

/** Maps a todo status word to the model's three states. */
export function todoStatus(v: unknown): TodoItem["status"] {
  if (v === "completed" || v === "done") return "completed";
  if (v === "in_progress" || v === "active") return "in_progress";
  return "pending";
}
