import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileDiffSummary, TodoItem } from "../../shared/agent-session";
import type { PastSession } from "../../types/protocol";
import { countPatch, isObj, JsonlTail, readFirstJsonLine, readHeadJsonLines, str, todoStatus, TurnBuilder, tsOf, type SessionRead } from "./common";
import type { PaneFacts, SessionSource } from "./source";

const MAX_LISTED_ROLLOUTS = 2000;
const NOT_PROMPT = /^\s*<(environment_context|user_instructions|user_action)/;

/** Codex (`agent-session-normalization.md` §2.4). */
export class CodexSource implements SessionSource {
  public readonly agent = "codex";
  private root: string;
  private paths = new Map<string, string>();
  private readers = new Map<string, { tail: JsonlTail; builder: TurnBuilder }>();

  constructor(home: string) {
    this.root = join(home, ".codex", "sessions");
  }

  /** Rollout files, newest day first; with `sinceMs`, only days whose folder changed since then. */
  private rollouts(sinceMs?: number): string[] {
    if (!existsSync(this.root)) return [];
    const out: string[] = [];
    const desc = (dir: string) => readdirSync(dir).sort().reverse();
    for (const y of desc(this.root)) {
      const yDir = join(this.root, y);
      if (!statSync(yDir).isDirectory()) continue;
      for (const m of desc(yDir)) {
        const mDir = join(yDir, m);
        if (!statSync(mDir).isDirectory()) continue;
        for (const d of desc(mDir)) {
          const dDir = join(mDir, d);
          const st = statSync(dDir);
          if (!st.isDirectory()) continue;
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
    const id = str(first.payload.id);
    const cwd = str(first.payload.cwd);
    return id && cwd ? { id, cwd } : null;
  }

  public newest(facts: PaneFacts, exclude: Set<string>): string | null {
    if (!facts.cwd) return null;
    let best: { id: string; path: string; mtime: number } | null = null;
    for (const path of this.rollouts(facts.createdMs)) {
      const mtime = statSync(path).mtimeMs;
      if (mtime < facts.createdMs || (best && mtime <= best.mtime)) continue;
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
      reader = { tail: new JsonlTail(path), builder: new TurnBuilder() };
      this.readers.set(sessionId, reader);
    }
    const { records, reset } = reader.tail.read();
    if (reset) reader.builder = new TurnBuilder();
    for (const r of records) applyRecord(reader.builder, r);
    return reader.builder.result();
  }

  public forget(sessionId: string): void {
    this.readers.delete(sessionId);
  }

  public list(folder: string): PastSession[] {
    const all = this.rollouts()
      .slice(0, MAX_LISTED_ROLLOUTS)
      .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const out: PastSession[] = [];
    for (const { path, mtime } of all) {
      if (out.length >= 50) break;
      const meta = this.meta(path);
      if (!meta || (meta.cwd !== folder && !meta.cwd.startsWith(folder + "/"))) continue;
      this.paths.set(meta.id, path);
      let title: string | undefined;
      for (const r of readHeadJsonLines(path)) {
        const p = isObj(r) && r.type === "response_item" ? r.payload : null;
        if (isObj(p) && p.type === "message" && p.role === "user") {
          const t = messageText(p.content);
          if (t && !NOT_PROMPT.test(t)) {
            title = t;
            break;
          }
        }
      }
      out.push({ id: meta.id, title: (title ?? meta.id).slice(0, 120), updatedAt: mtime });
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

/** Codex shell output is plain text or a JSON object with `output` and `metadata.exit_code`. */
function shellOutput(v: unknown): { output: string; exitCode?: number } {
  const text = typeof v === "string" ? v : isObj(v) ? JSON.stringify(v) : "";
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

function applyRecord(b: TurnBuilder, r: unknown): void {
  if (!isObj(r)) return;
  const ts = tsOf(r.timestamp, Date.now());
  const p = r.payload;
  if (!isObj(p)) return;
  if (r.type === "event_msg" && p.type === "thread_settings_applied" && isObj(p.thread_settings) && str(p.thread_settings.model)) {
    b.model = p.thread_settings.model;
    return;
  }
  if (r.type !== "response_item") return;
  switch (p.type) {
    case "message": {
      const text = messageText(p.content);
      if (p.role === "user") {
        if (text && !NOT_PROMPT.test(text)) b.prompt(text, ts);
      } else if (p.role === "assistant") b.text(text, ts);
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
      if (name === "apply_patch") {
        const patch = p.type === "custom_tool_call" ? str(p.input) ?? "" : str(parseArgs(p.arguments).input) ?? "";
        const diffs = patchDiffs(patch);
        const first = diffs[0];
        b.toolUse({ id, name, input: patch, verb: first?.status === "created" ? "create" : "edit", target: first?.filePath, diffs, timestamp: ts }, ts);
        return;
      }
      const args = p.type === "custom_tool_call" ? parseArgs(p.input) : parseArgs(p.arguments);
      if (name === "shell" || name === "exec_command" || name === "local_shell") {
        b.toolUse({ id, name, input: args, verb: "run", target: commandOf(args), timestamp: ts }, ts);
        return;
      }
      if (name === "update_plan") {
        const todos: TodoItem[] = (Array.isArray(args.plan) ? args.plan : []).filter(isObj).map((s: any) => ({ text: str(s.step) ?? "", status: todoStatus(s.status) }));
        b.toolUse({ id, name, input: args, verb: "other", todos, timestamp: ts }, ts);
        return;
      }
      b.toolUse({ id, name, input: args, verb: "other", timestamp: ts }, ts);
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const id = str(p.call_id);
      if (!id) return;
      const { output, exitCode } = shellOutput(p.output);
      b.toolResult(id, output, exitCode !== undefined && exitCode !== 0, ts, exitCode);
      return;
    }
  }
}
