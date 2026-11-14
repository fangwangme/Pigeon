import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileDiffSummary, TodoItem } from "../../shared/agent-session";
import type { PastSession } from "../../types/protocol";
import { countPatch, isEnoent, isObj, JsonlTail, readFirstJsonLine, readHeadJsonLines, readTailJsonLines, str, todoStatus, TurnBuilder, tsOf, type SessionRead } from "./common";
import type { PaneFacts, SessionSource } from "./source";

const MAX_LISTED_ROLLOUTS = 2000;
const NOT_PROMPT = /^\s*<(environment_context|user_instructions|user_action)/;

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

function mtimeOf(path: string | undefined): number | null {
  return path ? (safeStat(path)?.mtimeMs ?? null) : null;
}

interface CodexParseState {
  pendingExec?: { callId: string; input: Record<string, any>; rawInput: unknown; ts: number };
  lastAgentMessage?: string;
}

/** Codex (`agent-session-normalization.md` §2.4). */
export class CodexSource implements SessionSource {
  public readonly agent = "codex";
  private root: string;
  private realRoot: string;
  private paths = new Map<string, string>();
  private readers = new Map<string, { tail: JsonlTail; builder: TurnBuilder; state: CodexParseState }>();

  constructor(home: string) {
    this.root = join(home, ".codex", "sessions");
    try {
      this.realRoot = realpathSync(this.root);
    } catch {
      this.realRoot = this.root;
    }
  }

  /** Rollout files, newest day first; with `sinceMs`, only days whose folder changed since then. */
  private rollouts(sinceMs?: number): string[] {
    if (!existsSync(this.root)) return [];
    const out: string[] = [];
    const desc = (dir: string): string[] => {
      try {
        return readdirSync(dir).sort().reverse();
      } catch (err) {
        if (isEnoent(err)) return [];
        throw err;
      }
    };
    for (const y of desc(this.root)) {
      const yDir = join(this.root, y);
      if (!safeStat(yDir)?.isDirectory()) continue;
      for (const m of desc(yDir)) {
        const mDir = join(yDir, m);
        if (!safeStat(mDir)?.isDirectory()) continue;
        for (const d of desc(mDir)) {
          const dDir = join(mDir, d);
          const st = safeStat(dDir);
          if (!st?.isDirectory()) continue;
          // A session started after `sinceMs` creates its file, which updates its day folder.
          if (sinceMs !== undefined && st.mtimeMs < sinceMs) continue;
          for (const f of desc(dDir)) if (f.startsWith("rollout-") && f.endsWith(".jsonl")) out.push(join(dDir, f));
        }
      }
    }
    return out;
  }

  private meta(path: string): { id: string; cwd: string } | null {
    const first = readFirstJsonLine(path);
    if (!isObj(first) || first.type !== "session_meta" || !isObj(first.payload)) return null;
    // B18: exclude subagent rollouts (`payload.source: { subagent: ... }`)
    if (isObj(first.payload.source) && "subagent" in first.payload.source) return null;
    const id = str(first.payload.id);
    const cwd = str(first.payload.cwd);
    return id && cwd ? { id, cwd } : null;
  }

  public sessionOfFile(path: string): string | null {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const inRoot = path.startsWith(this.root + "/") || path.startsWith(this.realRoot + "/");
    if (!inRoot || !name.startsWith("rollout-") || !name.endsWith(".jsonl")) return null;
    const meta = this.meta(path);
    if (meta) this.paths.set(meta.id, path);
    return meta?.id ?? null;
  }

  public lastWritten(sessionId: string): number | null {
    return mtimeOf(this.paths.get(sessionId));
  }

  public newest(facts: PaneFacts, exclude: Set<string>): string | null {
    if (!facts.cwd) return null;
    let best: { id: string; path: string; mtime: number } | null = null;
    for (const path of this.rollouts(facts.createdMs)) {
      const mtime = safeStat(path)?.mtimeMs;
      if (mtime === undefined || mtime < facts.createdMs || (best && mtime <= best.mtime)) continue;
      const meta = this.meta(path);
      if (!meta || meta.cwd !== facts.cwd || exclude.has(meta.id)) continue;
      best = { id: meta.id, path, mtime };
    }
    if (best) this.paths.set(best.id, best.path);
    return best?.id ?? null;
  }

  public watchPath(sessionId: string): string | null {
    return this.paths.get(sessionId) ?? null;
  }

  public read(sessionId: string, incremental: boolean): SessionRead {
    const path = this.paths.get(sessionId);
    if (!path) return { turns: [] };
    let reader = this.readers.get(sessionId);
    if (!reader || !incremental) {
      reader = { tail: new JsonlTail(path), builder: new TurnBuilder(), state: {} };
      this.readers.set(sessionId, reader);
    }
    const { records, reset } = reader.tail.read();
    if (reset) {
      reader.builder = new TurnBuilder();
      reader.state = {};
    }
    for (const r of records) applyRecord(reader.builder, r, reader.state);
    return reader.builder.result();
  }

  public forget(sessionId: string): void {
    this.readers.delete(sessionId);
  }

  public list(folder: string): PastSession[] {
    const all = this.rollouts()
      .slice(0, MAX_LISTED_ROLLOUTS)
      .map((path) => ({ path, mtime: safeStat(path)?.mtimeMs ?? 0 }))
      .filter((entry) => entry.mtime > 0)
      .sort((a, b) => b.mtime - a.mtime);
    const out: PastSession[] = [];
    for (const { path, mtime } of all) {
      if (out.length >= 50) break;
      const meta = this.meta(path);
      if (!meta || (meta.cwd !== folder && !meta.cwd.startsWith(folder + "/"))) continue;
      this.paths.set(meta.id, path);
      let title: string | undefined;
      let model: string | undefined;
      const readModelFromRecord = (r: unknown): string | undefined => {
        if (!isObj(r)) return undefined;
        if (r.type === "event_msg" && isObj(r.payload) && r.payload.type === "thread_settings_applied" && isObj(r.payload.thread_settings)) {
          return str(r.payload.thread_settings.model);
        }
        if (r.type === "turn_context") {
          return (isObj(r.payload) ? str(r.payload.model) : undefined) ?? str((r as any).model);
        }
        return undefined;
      };
      for (const r of readHeadJsonLines(path)) {
        const m = readModelFromRecord(r);
        if (m) model = m;
        const p = isObj(r) && r.type === "response_item" ? r.payload : null;
        if (!title && isObj(p) && p.type === "message" && p.role === "user") {
          const t = messageText(p.content);
          if (t && !NOT_PROMPT.test(t)) {
            title = t;
          }
        }
      }
      if ((safeStat(path)?.size ?? 0) > 262_144) {
        for (const r of readTailJsonLines(path)) {
          const m = readModelFromRecord(r);
          if (m) model = m;
        }
      }
      out.push({ id: meta.id, title: (title ?? meta.id).slice(0, 120), updatedAt: mtime, ...(model ? { model } : {}) });
    }
    return out;
  }
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((b) => isObj(b) && (b.type === "input_text" || b.type === "output_text" || b.type === "text"))
    .map((b: any) => b.text)
    .join("\n");
}

function parseArgs(v: unknown): Record<string, any> {
  if (isObj(v)) return v;
  if (typeof v !== "string") return {};
  try {
    const parsed = JSON.parse(v);
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** `*** Add File:` / `*** Update File:` / `*** Delete File:` sections, one diff each. */
function patchDiffs(patch: string): FileDiffSummary[] {
  const out: FileDiffSummary[] = [];
  let cur: { file: string; status: FileDiffSummary["status"]; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const { additions, deletions } = countPatch(cur.lines);
    out.push({ filePath: cur.file, status: cur.status, additions, deletions, patch: cur.lines.join("\n") });
  };
  for (const line of patch.split("\n")) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      flush();
      cur = { file: m[2].trim(), status: m[1] === "Add" ? "created" : m[1] === "Delete" ? "deleted" : "modified", lines: [] };
      continue;
    }
    if (/^\*\*\* (End|Begin) Patch/.test(line)) continue;
    cur?.lines.push(line);
  }
  flush();
  return out;
}

/** Codex shell output is plain text, content block array, or JSON object with `output` and `metadata.exit_code`. */
function shellOutput(v: unknown): { output: string; exitCode?: number } {
  const text = typeof v === "string" ? v : Array.isArray(v) ? messageText(v) : isObj(v) ? JSON.stringify(v) : "";
  const parsed = parseArgs(text);
  if (typeof parsed.output === "string") {
    const code = isObj(parsed.metadata) ? parsed.metadata.exit_code : undefined;
    return { output: parsed.output, ...(typeof code === "number" ? { exitCode: code } : {}) };
  }
  const m = /^Exit code: (\d+)/m.exec(text);
  return { output: text, ...(m ? { exitCode: Number(m[1]) } : {}) };
}

function commandOf(args: Record<string, any>): string | undefined {
  if (typeof args.cmd === "string") return args.cmd;
  if (typeof args.command === "string") return args.command;
  if (Array.isArray(args.command)) {
    const parts = args.command.filter((p: unknown) => typeof p === "string") as string[];
    // ["bash", "-lc", "<script>"] shows as the script.
    if (parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && parts[1].startsWith("-")) return parts[2];
    return parts.join(" ");
  }
  return undefined;
}

function durationMsOf(item: Record<string, any>): number | undefined {
  if (isObj(item.duration) && typeof item.duration.secs === "number") {
    const nanos = typeof item.duration.nanos === "number" ? item.duration.nanos : 0;
    return Math.round(item.duration.secs * 1000 + nanos / 1e6);
  }
  if (typeof item.duration_ms === "number") return item.duration_ms;
  return undefined;
}

function flushPendingExec(b: TurnBuilder, state: CodexParseState): void {
  const pe = state.pendingExec;
  if (!pe) return;
  state.pendingExec = undefined;
  const target = commandOf(pe.input) ?? (typeof pe.rawInput === "string" ? pe.rawInput.trim() : undefined);
  b.toolUse({ id: pe.callId, name: "exec", input: Object.keys(pe.input).length ? pe.input : typeof pe.rawInput === "string" ? pe.rawInput : {}, verb: "run", target, timestamp: pe.ts }, pe.ts);
}

function applyItemCompleted(b: TurnBuilder, item: Record<string, any>, ts: number, state: CodexParseState): void {
  const kind = str(item.type);
  const dur = durationMsOf(item);
  switch (kind) {
    case "CommandExecution": {
      state.pendingExec = undefined; // deduplicate pending `exec` custom_tool_call
      const id = str(item.id) ?? `cmd_${ts}`;
      const cmd = str(item.command) ?? commandOf(item);
      const output = str(item.aggregated_output) ?? str(item.output);
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
      const isError = item.status === "failed" || (exitCode !== undefined && exitCode !== 0);
      b.toolUse({ id, name: "exec", input: { ...(cmd ? { command: cmd } : {}), ...(item.cwd ? { cwd: item.cwd } : {}) }, verb: "run", target: cmd, timestamp: ts }, ts);
      const call = b.toolResult(id, output, isError, ts, exitCode);
      if (call && dur !== undefined) call.durationMs = dur;
      return;
    }
    case "FileChange": {
      flushPendingExec(b, state);
      const id = str(item.id) ?? `fc_${ts}`;
      const diffs: FileDiffSummary[] = [];
      const addChange = (filePath: string, ch: Record<string, any>) => {
        const rawType = (str(ch.type) ?? str(ch.kind) ?? "update").toLowerCase();
        const status: FileDiffSummary["status"] = rawType.startsWith("add") || rawType.startsWith("creat") ? "created" : rawType.startsWith("del") ? "deleted" : "modified";
        const patch = str(ch.unified_diff) ?? str(ch.diff);
        const counts = patch ? countPatch(patch.split("\n")) : { additions: 0, deletions: 0 };
        diffs.push({ filePath, status, ...counts, ...(patch ? { patch } : {}) });
      };
      if (isObj(item.changes)) {
        for (const [filePath, ch] of Object.entries(item.changes)) {
          if (isObj(ch)) addChange(filePath, ch);
        }
      } else if (Array.isArray(item.changes)) {
        for (const ch of item.changes) {
          if (!isObj(ch)) continue;
          const filePath = str(ch.path) ?? str(ch.file_path);
          if (filePath) addChange(filePath, ch);
        }
      }
      const first = diffs[0];
      b.toolUse({ id, name: "file_change", input: item.changes ?? {}, verb: first?.status === "created" ? "create" : "edit", target: first?.filePath, diffs, timestamp: ts }, ts);
      const call = b.toolResult(id, undefined, item.status === "failed", ts);
      if (call && dur !== undefined) call.durationMs = dur;
      return;
    }
    case "McpToolCall": {
      flushPendingExec(b, state);
      const id = str(item.id) ?? `mcp_${ts}`;
      const server = str(item.server);
      const tool = str(item.tool);
      const name = server && tool ? `${server}:${tool}` : (tool ?? server ?? "mcp");
      const output =
        item.result !== undefined
          ? typeof item.result === "string"
            ? item.result
            : JSON.stringify(item.result)
          : item.error !== undefined
          ? typeof item.error === "string"
            ? item.error
            : JSON.stringify(item.error)
          : undefined;
      b.toolUse({ id, name, input: isObj(item.arguments) ? item.arguments : {}, verb: "other", target: tool, timestamp: ts }, ts);
      const call = b.toolResult(id, output, item.status === "failed" || !!item.error, ts);
      if (call && dur !== undefined) call.durationMs = dur;
      return;
    }
    case "ContextCompaction": {
      flushPendingExec(b, state);
      b.compact(str(item.summary) ?? "Context compacted", ts);
      return;
    }
    case "AgentMessage": {
      flushPendingExec(b, state);
      const text = str(item.text) ?? messageText(item.content);
      if (text && text.trim() && state.lastAgentMessage !== text) {
        state.lastAgentMessage = text;
        b.text(text, ts);
      }
      return;
    }
  }
}

function applyRecord(b: TurnBuilder, r: unknown, state: CodexParseState): void {
  if (!isObj(r)) return;
  const ts = tsOf(r.timestamp, Date.now());
  const p = r.payload;
  if (!isObj(p)) return;
  if (r.type === "turn_context") {
    const tm = str(p.model) ?? str((r as any).model);
    if (tm) b.model = tm;
    return;
  }
  if (r.type === "event_msg") {
    if (p.type === "thread_settings_applied" && isObj(p.thread_settings) && str(p.thread_settings.model)) {
      b.model = p.thread_settings.model;
      return;
    }
    if (p.type === "item_completed" && isObj(p.item)) {
      applyItemCompleted(b, p.item, ts, state);
    }
    return;
  }
  if (r.type !== "response_item") return;
  switch (p.type) {
    case "message": {
      const text = messageText(p.content);
      if (p.role === "user") {
        if (text && !NOT_PROMPT.test(text)) {
          flushPendingExec(b, state);
          state.lastAgentMessage = undefined;
          b.prompt(text, ts);
        }
      } else if (p.role === "assistant") {
        flushPendingExec(b, state);
        if (state.lastAgentMessage !== text) {
          state.lastAgentMessage = text;
          b.text(text, ts);
        }
      }
      return;
    }
    case "reasoning": {
      const text = Array.isArray(p.summary) ? p.summary.filter(isObj).map((s: any) => s.text).filter(Boolean).join("\n") : "";
      b.reasoning(text, ts);
      return;
    }
    case "function_call":
    case "custom_tool_call": {
      const id = str(p.call_id);
      const name = str(p.name);
      if (!id || !name) return;
      if (name === "exec" && p.type === "custom_tool_call") {
        flushPendingExec(b, state);
        state.pendingExec = { callId: id, input: parseArgs(p.input), rawInput: p.input, ts };
        return;
      }
      flushPendingExec(b, state);
      if (name === "apply_patch") {
        const patch = p.type === "custom_tool_call" ? str(p.input) ?? "" : str(parseArgs(p.arguments).input) ?? "";
        const diffs = patchDiffs(patch);
        const first = diffs[0];
        b.toolUse({ id, name, input: patch, verb: first?.status === "created" ? "create" : "edit", target: first?.filePath, diffs, timestamp: ts }, ts);
        return;
      }
      const args = p.type === "custom_tool_call" ? parseArgs(p.input) : parseArgs(p.arguments);
      const rawInput = p.type === "custom_tool_call" ? p.input : p.arguments;
      const inputVal: Record<string, unknown> | string =
        Object.keys(args).length > 0 ? args : typeof rawInput === "string" ? rawInput : args;
      if (name === "shell" || name === "exec_command" || name === "local_shell" || name === "write_stdin") {
        const target = commandOf(args) ?? (name === "write_stdin" && typeof rawInput === "string" ? rawInput.trim() : undefined);
        b.toolUse({ id, name, input: inputVal, verb: "run", target, timestamp: ts }, ts);
        return;
      }
      if (name === "update_plan") {
        const todos: TodoItem[] = (Array.isArray(args.plan) ? args.plan : []).filter(isObj).map((s: any) => ({ text: str(s.step) ?? "", status: todoStatus(s.status) }));
        b.toolUse({ id, name, input: args, verb: "other", todos, timestamp: ts }, ts);
        return;
      }
      b.toolUse({ id, name, input: inputVal, verb: "other", timestamp: ts }, ts);
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const id = str(p.call_id);
      if (!id) return;
      if (state.pendingExec?.callId === id) {
        flushPendingExec(b, state);
      }
      const { output, exitCode } = shellOutput(p.output);
      b.toolResult(id, output, exitCode !== undefined && exitCode !== 0, ts, exitCode);
      return;
    }
  }
}
