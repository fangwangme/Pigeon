import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileDiffSummary, SubagentInfo, TodoItem } from "../../shared/agent-session";
import type { PastSession } from "../../types/protocol";
import { claudeSlug, countPatch, extractBlocksText, fileFallbackTs, isEnoent, isObj, JsonlTail, lineDiff, readHeadJsonLines, readListingJsonLines, str, todoStatus, TurnBuilder, type SessionRead } from "./common";
import type { PaneFacts, SessionSource } from "./source";

/** Claude Code (`agent-session-normalization.md` §2.3). */
export class ClaudeSource implements SessionSource {
  public readonly agent = "claude";
  private root: string;
  private paths = new Map<string, string>();
  private readers = new Map<string, { tail: JsonlTail; builder: TurnBuilder; subagents: ClaudeSubagents }>();

  constructor(home: string) {
    this.root = join(home, ".claude");
  }

  private projectDir(cwd: string): string {
    return join(this.root, "projects", claudeSlug(cwd));
  }

  public exact(facts: PaneFacts): string | null {
    if (!facts.pid) return null;
    const file = join(this.root, "sessions", `${facts.pid}.json`);
    if (!existsSync(file)) return null;
    // §1: another program's file; Claude may be mid-write, so an unreadable map is skipped.
    let data: any;
    try {
      data = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
    const sessionId = str(data.sessionId);
    const cwd = str(data.cwd) ?? facts.cwd;
    if (!sessionId || !cwd) return null;
    this.paths.set(sessionId, join(this.projectDir(cwd), `${sessionId}.jsonl`));
    return sessionId;
  }

  public lastWritten(sessionId: string): number | null {
    const path = this.paths.get(sessionId);
    if (!path) return null;
    try {
      return statSync(path).mtimeMs;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  public newest(facts: PaneFacts, exclude: Set<string>): string | null {
    if (!facts.cwd) return null;
    const dir = this.projectDir(facts.cwd);
    if (!existsSync(dir)) return null;
    let best: { id: string; mtime: number } | null = null;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (exclude.has(id)) continue;
      let mtime: number;
      try {
        mtime = statSync(join(dir, name)).mtimeMs;
      } catch (err) {
        if (isEnoent(err)) continue;
        throw err;
      }
      if (mtime < facts.createdMs) continue;
      if (!best || mtime > best.mtime) best = { id, mtime };
    }
    if (best) this.paths.set(best.id, join(dir, `${best.id}.jsonl`));
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
      reader = { tail: new JsonlTail(path), builder: new TurnBuilder(fileFallbackTs(path)), subagents: new ClaudeSubagents() };
      this.readers.set(sessionId, reader);
    }
    const { records, reset } = reader.tail.read();
    if (reset) {
      reader.builder = new TurnBuilder(fileFallbackTs(path));
      reader.subagents = new ClaudeSubagents();
    }
    for (const r of records) applyRecord(reader.builder, r, false, reader.subagents);
    const out = reader.builder.result("AskUserQuestion", "ExitPlanMode");
    const subs = reader.subagents.list();
    if (subs.length > 0) out.subagents = subs;
    return out;
  }

  public readSubagent(parentSessionId: string, subagentId: string): SessionRead {
    const parentPath = this.paths.get(parentSessionId);
    if (!parentPath) return { turns: [] };
    const subPath = parentPath.replace(/\.jsonl$/, `/subagents/agent-${subagentId}.jsonl`);
    if (!existsSync(subPath)) return { turns: [] };
    const tail = new JsonlTail(subPath);
    const builder = new TurnBuilder(fileFallbackTs(subPath));
    for (const r of tail.read().records) applyRecord(builder, r, true);
    return builder.result("AskUserQuestion", "ExitPlanMode");
  }

  public forget(sessionId: string): void {
    this.readers.delete(sessionId);
  }

  public list(folder: string): PastSession[] {
    const projects = join(this.root, "projects");
    if (!existsSync(projects)) return [];
    const prefix = claudeSlug(folder);
    const out: Array<PastSession & { path: string; size: number }> = [];
    for (const dirName of readdirSync(projects)) {
      if (!dirName.startsWith(prefix)) continue;
      const dir = join(projects, dirName);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (err) {
        if (isEnoent(err)) continue;
        throw err;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        try {
          const st = statSync(path);
          out.push({ id: name.slice(0, -".jsonl".length), title: "", updatedAt: st.mtimeMs, path, size: st.size });
        } catch (err) {
          if (!isEnoent(err)) throw err;
        }
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    const result: PastSession[] = [];
    for (const s of out) {
      if (result.length >= 50) break;
      const records = readListingJsonLines(s.path, s.size);
      // The slug is lossy (`-` stands for many characters); the records' cwd confirms the folder.
      const cwd = records.map((r: any) => (isObj(r) ? str(r.cwd) : undefined)).find(Boolean);
      if (cwd && cwd !== folder && !cwd.startsWith(folder + "/")) continue;
      let title: string | undefined;
      let firstPrompt: string | undefined;
      let model: string | undefined;
      for (const r of records) {
        if (!isObj(r)) continue;
        if (r.type === "custom-title" || r.type === "ai-title") title = str(r.customTitle) ?? str(r.aiTitle) ?? title;
        if (!firstPrompt && r.type === "user") firstPrompt = promptText(r) ?? undefined;
        if (r.type === "assistant" && isObj(r.message) && typeof r.message.model === "string" && r.message.model && r.message.model !== "<synthetic>") {
          model = r.message.model;
        }
      }
      this.paths.set(s.id, s.path);
      result.push({
        id: s.id,
        title: (title ?? firstPrompt ?? s.id).slice(0, 120),
        updatedAt: s.updatedAt,
        ...(model ? { model } : {}),
      });
    }
    return result;
  }
}

const NOT_PROMPT = /^\s*<(command-|local-command-|system-reminder)/;

/** The prompt text of a `user` record, or null when it is a tool result or meta line. */
function promptText(r: Record<string, any>): string | null {
  if (r.isMeta === true || r.isCompactSummary === true) return null;
  if (isObj(r.origin) && r.origin.kind === "task-notification") return null;
  const content = r.message?.content;
  if (typeof content === "string") return NOT_PROMPT.test(content) ? null : content;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => isObj(b) && b.type === "tool_result")) return null;
  const text = content.filter((b) => isObj(b) && b.type === "text").map((b) => b.text).join("\n");
  if (!text || NOT_PROMPT.test(text)) return null;
  return text;
}

function editDiffs(name: string, input: Record<string, any>): FileDiffSummary[] | undefined {
  const file = str(input.file_path) ?? str(input.notebook_path);
  if (!file) return undefined;
  if (name === "Edit") return [lineDiff(file, str(input.old_string) ?? "", str(input.new_string) ?? "", "modified")];
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const parts = input.edits.filter(isObj).map((e: any) => lineDiff(file, str(e.old_string) ?? "", str(e.new_string) ?? "", "modified"));
    return [
      {
        filePath: file,
        status: "modified",
        additions: parts.reduce((n, p) => n + p.additions, 0),
        deletions: parts.reduce((n, p) => n + p.deletions, 0),
        patch: parts.map((p) => p.patch).join("\n"),
      },
    ];
  }
  if (name === "Write") return [lineDiff(file, "", str(input.content) ?? "", "created")];
  if (name === "NotebookEdit") return [lineDiff(file, "", str(input.new_source) ?? "", "modified")];
  return undefined;
}

function describeTool(name: string, input: Record<string, any>) {
  switch (name) {
    case "Bash":
      return { verb: "run" as const, target: str(input.command), description: str(input.description) };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { verb: "edit" as const, target: str(input.file_path) ?? str(input.notebook_path) };
    case "Write":
      return { verb: "create" as const, target: str(input.file_path) };
    case "Read":
      return { verb: "read" as const, target: str(input.file_path) };
    case "Grep":
    case "Glob":
      return { verb: "search" as const, target: str(input.pattern) };
    case "WebSearch":
      return { verb: "search" as const, target: str(input.query) };
    case "WebFetch":
      return { verb: "read" as const, target: str(input.url) };
    default:
      return { verb: "other" as const, target: undefined, description: str(input.description) };
  }
}

class ClaudeSubagents {
  private ordered: SubagentInfo[] = [];
  private byCall = new Map<string, SubagentInfo>();
  private byId = new Map<string, SubagentInfo>();

  public addCall(callId: string, info: SubagentInfo): void {
    this.ordered.push(info);
    this.byCall.set(callId, info);
    this.byId.set(info.id, info);
  }

  public toolResult(callId: string, isError: boolean, result: unknown): void {
    const info = this.byCall.get(callId);
    if (!info) return;
    if (isObj(result)) {
      const agentId = str(result.agentId);
      if (agentId) {
        info.id = agentId;
        this.byId.set(agentId, info);
      }
      const resolvedModel = str(result.resolvedModel);
      if (resolvedModel) info.model = resolvedModel;
      if (str(result.status) === "async_launched") {
        info.status = "running";
        return;
      }
    }
    info.status = isError ? "failed" : "completed";
  }

  public taskNotification(text: string): void {
    const idMatch = /<task-id>([^<]+)<\/task-id>/.exec(text);
    const statusMatch = /<status>([^<]+)<\/status>/.exec(text);
    if (!idMatch) return;
    const info = this.byId.get(idMatch[1].trim());
    if (!info) return;
    info.status = statusMatch?.[1]?.trim() === "completed" ? "completed" : "failed";
  }

  public list(): SubagentInfo[] {
    return this.ordered.map((s) => ({ ...s }));
  }
}

function applyRecord(b: TurnBuilder, r: unknown, allowSidechain = false, subagents?: ClaudeSubagents): void {
  if (!isObj(r) || (!allowSidechain && r.isSidechain === true)) return;
  const ts = b.resolveTs(r.timestamp);
  if (r.type === "custom-title" || r.type === "ai-title") {
    b.title = str(r.customTitle) ?? str(r.aiTitle) ?? b.title;
    return;
  }
  if (r.type === "user") {
    const content = r.message?.content;
    if (r.isCompactSummary === true) {
      b.compact(extractBlocksText(content), ts);
      return;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isObj(block) || block.type !== "tool_result") continue;
        const id = str(block.tool_use_id);
        if (!id) continue;
        const output = extractBlocksText(block.content);
        const exit = /^Exit code (\d+)/.exec(output);
        const call = b.toolResult(id, output, block.is_error === true, ts, exit ? Number(exit[1]) : undefined);
        subagents?.toolResult(id, block.is_error === true, r.toolUseResult);
        // Write reports whether it created or replaced the file; structured patches are exact.
        const result = r.toolUseResult;
        if (call && isObj(result)) {
          if (call.name === "Write" && result.type === "update") {
            call.verb = "edit";
            if (call.diff) call.diff.status = "modified";
          }
          if (Array.isArray(result.structuredPatch) && call.diff) {
            const lines: string[] = result.structuredPatch.flatMap((h: any) => (Array.isArray(h?.lines) ? h.lines : []));
            const { additions, deletions } = countPatch(lines);
            const header = `--- a/${call.diff.filePath}\n+++ b/${call.diff.filePath}\n`;
            const hunks = result.structuredPatch
              .filter(isObj)
              .map((h: any) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${(h.lines || []).join("\n")}`)
              .join("\n");
            b.setDiffs(id, [{ ...call.diff, additions, deletions, patch: header + hunks }]);
          }
        }
      }
    }
    if (subagents && isObj(r.origin) && r.origin.kind === "task-notification") {
      subagents.taskNotification(extractBlocksText(content));
    }
    const text = promptText(r);
    if (text !== null) {
      const files = Array.isArray(content) ? content.filter((x) => isObj(x) && x.type === "image").map(() => "image") : [];
      b.prompt(text, ts, files);
    }
    return;
  }
  if (r.type === "assistant") {
    const msg = r.message;
    if (!isObj(msg)) return;
    if (r.isApiErrorMessage === true) {
      const errText = Array.isArray(msg.content)
        ? msg.content.filter(isObj).map((b: any) => b.text || "").join("\n")
        : typeof msg.content === "string" ? msg.content : "";
      const errKind = str(r.error) || "unknown";
      b.error(errKind, errText, ts);
      return;
    }
    if (str(msg.model) && msg.model !== "<synthetic>") b.model = msg.model;
    if (!Array.isArray(msg.content)) return;
    for (const block of msg.content) {
      if (!isObj(block)) continue;
      if (block.type === "thinking") b.reasoning(str(block.thinking) ?? "", ts);
      else if (block.type === "text") b.text(str(block.text) ?? "", ts);
      else if (block.type === "tool_use") {
        const id = str(block.id);
        const name = str(block.name);
        if (!id || !name) continue;
        const input = isObj(block.input) ? block.input : {};
        if (subagents && (name === "Agent" || name === "Task")) {
          const type = str(input.subagent_type);
          const model = str(input.model);
          subagents.addCall(id, {
            id,
            title: str(input.description) ?? name,
            ...(type ? { type } : {}),
            ...(model ? { model } : {}),
            status: "running",
          });
        }
        const todos: TodoItem[] | undefined =
          name === "TodoWrite" && Array.isArray(input.todos)
            ? input.todos.filter(isObj).map((t: any) => ({ text: str(t.content) ?? "", status: todoStatus(t.status) }))
            : undefined;
        b.toolUse({ id, name, input, ...describeTool(name, input), diffs: editDiffs(name, input), todos, timestamp: ts }, ts);
      }
    }
  }
}
