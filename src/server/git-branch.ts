import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The nearest folder at or above `start` that contains `.git`, or null. */
export function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * `herdr-adapter.md` §3.1: the checked-out branch of the repository holding `folder`, following a
 * worktree's `.git` file to its git dir. A detached HEAD or no repository gives null.
 */
export function readGitBranch(folder: string): string | null {
  const root = findGitRoot(folder);
  if (!root) return null;
  const dotGit = join(root, ".git");
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf-8"));
    if (!m) return null;
    gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(root, m[1].trim());
  }
  const headPath = join(gitDir, "HEAD");
  if (!existsSync(headPath)) return null;
  const m = /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(headPath, "utf-8"));
  return m ? m[1].trim() : null;
}
