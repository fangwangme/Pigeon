import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/** A process that exits while it is read, or one this user cannot inspect, simply has no entries. */
const GONE = new Set(["ENOENT", "ESRCH", "EACCES", "EPERM"]);

function orElse<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch (err) {
    if (GONE.has((err as NodeJS.ErrnoException).code ?? "")) return fallback;
    throw err;
  }
}

/**
 * `agent-session-normalization.md` §2.0 rule 1: the files a process and its descendants hold open,
 * read from Linux `/proc`. Descendants count because an agent's command is often a launcher whose
 * child does the work.
 */
export function openFilesOf(pid: number): string[] {
  const files: string[] = [];
  const visited = new Set<number>();
  const visit = (p: number) => {
    if (visited.has(p)) return;
    visited.add(p);
    for (const fd of orElse(() => readdirSync(`/proc/${p}/fd`), [] as string[])) {
      const target = orElse(() => readlinkSync(`/proc/${p}/fd/${fd}`), "");
      if (target.startsWith("/")) files.push(target);
    }
    for (const tid of orElse(() => readdirSync(`/proc/${p}/task`), [] as string[])) {
      for (const child of orElse(() => readFileSync(`/proc/${p}/task/${tid}/children`, "utf-8"), "").split(" ")) {
        if (child.trim()) visit(Number(child));
      }
    }
  };
  visit(pid);
  return files;
}
