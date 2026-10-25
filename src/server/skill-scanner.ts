import { readdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillEntry } from "../types/protocol";

export type { SkillEntry };

interface SkillSource {
  dir: string;
  source: SkillEntry["source"];
}

/**
 * Where each agent looks for skills, and how a skill is invoked from its prompt.
 * `{name}` in `invocation` is replaced by the skill name. Paths under `cwd` are the project's.
 */
const AGENT_SKILL_LAYOUT: Record<string, { sources: (home: string, cwd?: string) => SkillSource[]; invocation: string }> = {
  claude: {
    sources: (home, cwd) => [
      ...(cwd ? [{ dir: join(cwd, ".claude", "skills"), source: "project" as const }] : []),
      { dir: join(home, ".claude", "skills"), source: "user" },
    ],
    invocation: "/{name}",
  },
  codex: {
    sources: (home, cwd) => [
      ...(cwd ? [{ dir: join(cwd, ".agents", "skills"), source: "project" as const }] : []),
      { dir: join(home, ".agents", "skills"), source: "user" },
      { dir: join(home, ".codex", "skills"), source: "user" },
    ],
    invocation: "${name}",
  },
  pi: {
    sources: (home, cwd) => [
      ...(cwd ? [{ dir: join(cwd, ".pi", "skills"), source: "project" as const }] : []),
      { dir: join(home, ".pi", "agent", "skills"), source: "user" },
    ],
    invocation: "/skill:{name}",
  },
  agy: {
    sources: (home, cwd) => [
      ...(cwd ? [{ dir: join(cwd, ".agents", "skills"), source: "project" as const }] : []),
      { dir: join(home, ".gemini", "antigravity-cli", "skills"), source: "user" },
      { dir: join(home, ".gemini", "antigravity", "builtin", "skills"), source: "builtin" },
    ],
    invocation: "/{name}",
  },
  opencode: {
    sources: (home, cwd) => [
      ...(cwd ? [{ dir: join(cwd, ".opencode", "skills"), source: "project" as const }] : []),
      { dir: join(home, ".config", "opencode", "skills"), source: "user" },
    ],
    invocation: "/{name}",
  },
};

/** Reads `description:` from SKILL.md front matter; file content is untrusted and rendered as text. */
function readDescription(skillMd: string): string {
  if (!existsSync(skillMd)) return "";
  const content = readFileSync(skillMd, "utf-8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(content);
  const desc = fm && /^description:\s*(.+)$/m.exec(fm[1]);
  return desc ? desc[1].trim().replace(/^["']|["']$/g, "").slice(0, 300) : "";
}

export class SkillScanner {
  private cache = new Map<string, { at: number; entries: SkillEntry[] }>();
  private ttlMs = 15_000;

  constructor(private home: string = homedir()) {}

  /** Skills for one agent kind in one project; empty for agents without a known layout. */
  public listSkills(agentKind: string | null, cwd?: string | null): SkillEntry[] {
    const layout = agentKind ? AGENT_SKILL_LAYOUT[agentKind.toLowerCase()] : undefined;
    if (!layout) return [];
    const key = `${agentKind}|${cwd || ""}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.entries;

    const results = new Map<string, SkillEntry>();
    // Earlier sources win on a name clash, so project skills shadow user skills.
    for (const { dir, source } of layout.sources(this.home, cwd || undefined)) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!(entry.isDirectory() || entry.isSymbolicLink()) || results.has(entry.name)) continue;
        const skillMd = join(dir, entry.name, "SKILL.md");
        if (!existsSync(skillMd)) continue;
        results.set(entry.name, {
          name: entry.name,
          description: readDescription(skillMd),
          source,
          invocation: layout.invocation.replace("{name}", entry.name),
        });
      }
    }
    const entries = Array.from(results.values()).sort((a, b) => a.name.localeCompare(b.name));
    this.cache.set(key, { at: Date.now(), entries });
    return entries;
  }
}
