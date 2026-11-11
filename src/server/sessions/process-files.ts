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
 * `agent-session-normalization.md` §2.0 rule 1: the files a process and its descendants hold open.
 * Linux: read from `/proc/<pid>/fd` and descendants from `/proc/<pid>/task/.../children`.
 * macOS: read from `lsof -p <pid> -Fn` and descendants from `pgrep -P`.
 */
export function openFilesOf(pid: number): string[] {
  const files: string[] = [];
  const visited = new Set<number>();

  if (process.platform === "darwin") {
    const getChildren = (p: number): number[] => {
      try {
        const res = Bun.spawnSync(["pgrep", "-P", String(p)], { timeout: 1000, stderr: "ignore" });
        if (res.exitCode === 0 && res.stdout) {
          return res.stdout
            .toString()
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(Number)
            .filter((n) => !isNaN(n));
        }
      } catch {}
      return [];
    };

    const visit = (p: number) => {
      if (visited.has(p)) return;
      visited.add(p);
      try {
        const res = Bun.spawnSync(["lsof", "-p", String(p), "-Fn"], { timeout: 1000, stderr: "ignore" });
        if (res.exitCode === 0 && res.stdout) {
          for (const line of res.stdout.toString().split("\n")) {
            if (line.startsWith("n/")) {
              files.push(line.slice(1));
            }
          }
        }
      } catch {}
      for (const child of getChildren(p)) {
        visit(child);
      }
    };

    visit(pid);
    return files;
  }

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
