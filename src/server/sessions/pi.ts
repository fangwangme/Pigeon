import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PastSession } from "../../types/protocol";
import { isObj, JsonlTail, lineDiff, readHeadJsonLines, str, TurnBuilder, tsOf, type SessionRead } from "./common";
import type { PaneFacts, SessionSource } from "./source";

function mtimeOf(path: string | undefined): number | null {
  return path && existsSync(path) ? statSync(path).mtimeMs : null;
}

/** Pi (`agent-session-normalization.md` §2.5). Session ids are file names without `.jsonl`. */
export class PiSource implements SessionSource {
  public readonly agent = "pi";
  private root: string;
  private realRoot: string;
  private paths = new Map<string, string>();
  private readers = new Map<string, { tail: JsonlTail; builder: TurnBuilder }>();

  constructor(home: string) {
    this.root = join(home, ".pi", "agent", "sessions");
    try {
      this.realRoot = realpathSync(this.root);
    } catch {
      this.realRoot = this.root;
    }
  }

  private dirOf(folder: string): string {
    return join(this.root, `--${folder.replace(/^\//, "").replace(/\//g, "-")}--`);
  }

  private files(folder: string): Array<{ id: string; path: string; mtime: number }> {
    const dir = this.dirOf(folder);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ id: f.slice(0, -".jsonl".length), path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  }

  public sessionOfFile(path: string): string | null {
    const inRoot = path.startsWith(this.root + "/") || path.startsWith(this.realRoot + "/");
    if (!inRoot || !path.endsWith(".jsonl")) return null;
    const id = path.slice(path.lastIndexOf("/") + 1, -".jsonl".length);
    this.paths.set(id, path);
    return id;
  }

  public lastWritten(sessionId: string): number | null {
    return mtimeOf(this.paths.get(sessionId));
  }

  public newest(facts: PaneFacts, exclude: Set<string>): string | null {
    if (!facts.cwd) return null;
    const hit = this.files(facts.cwd).find((f) => f.mtime >= facts.createdMs && !exclude.has(f.id));
    if (hit) this.paths.set(hit.id, hit.path);
    return hit?.id ?? null;
  }

  public watchPath(sessionId: string): string | null {
    return this.paths.get(sessionId) ?? null;
  }

  public resumeTarget(sessionId: string, folder: string): string | null {
    const path = this.paths.get(sessionId) ?? join(this.dirOf(folder), `${sessionId}.jsonl`);
    return existsSync(path) ? path : null;
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
    return this.files(folder)
      .slice(0, 50)
      .map((f) => {
        this.paths.set(f.id, f.path);
        let title: string | undefined;
        for (const r of readHeadJsonLines(f.path)) {
          if (isObj(r) && r.type === "message" && r.message?.role === "user") {
            title = blocksText(r.message.content);
            if (title) break;
          }
        }
        return { id: f.id, title: (title || f.id).slice(0, 120), updatedAt: f.mtime };
      });
  }
}

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => isObj(b) && b.type === "text").map((b: any) => b.text).join("\n");
}

function applyRecord(b: TurnBuilder, r: unknown): void {
  // §2.5: the model in use, as `<provider>/<id>` like the model catalog (herdr-adapter.md §7.1).
  if (isObj(r) && r.type === "model_change" && str(r.provider) && str(r.modelId)) b.model = `${r.provider}/${r.modelId}`;
  if (!isObj(r) || r.type !== "message" || !isObj(r.message)) return;
  const m = r.message;
  const ts = tsOf(r.timestamp ?? m.timestamp, Date.now());
  if (m.role === "user") {
    const text = blocksText(m.content);
    if (text) {
      b.prompt(text, ts);
    }
    return;
  }
  if (m.role === "toolResult") {
    const id = str(m.toolCallId);
    if (id) b.toolResult(id, blocksText(m.content), m.isError === true, ts);
    return;
  }
  if (m.role !== "assistant" || !Array.isArray(m.content)) return;
  if (str(m.provider) && str(m.model)) b.model = `${m.provider}/${m.model}`;
  for (const block of m.content) {
    if (!isObj(block)) continue;
    if (block.type === "text") b.text(str(block.text) ?? "", ts);
    else if (block.type === "thinking") b.reasoning(str(block.thinking) ?? "", ts);
    else if (block.type === "toolCall") {
      const id = str(block.id);
      const name = str(block.name);
      if (!id || !name) continue;
      const args = isObj(block.arguments) ? block.arguments : {};
      const path = str(args.path);
      switch (name) {
        case "bash":
          b.toolUse({ id, name, input: args, verb: "run", target: str(args.command), timestamp: ts }, ts);
          break;
        case "edit":
          b.toolUse({ id, name, input: args, verb: "edit", target: path, diffs: path ? [lineDiff(path, str(args.oldText) ?? "", str(args.newText) ?? "", "modified")] : undefined, timestamp: ts }, ts);
          break;
        case "write":
          b.toolUse({ id, name, input: args, verb: "create", target: path, diffs: path ? [lineDiff(path, "", str(args.content) ?? "", "created")] : undefined, timestamp: ts }, ts);
          break;
        case "read":
          b.toolUse({ id, name, input: args, verb: "read", target: path, timestamp: ts }, ts);
          break;
        case "grep":
        case "find":
        case "ls":
          b.toolUse({ id, name, input: args, verb: "search", target: str(args.pattern) ?? path, timestamp: ts }, ts);
          break;
        default:
          b.toolUse({ id, name, input: args, verb: "other", timestamp: ts }, ts);
      }
    }
  }
}
