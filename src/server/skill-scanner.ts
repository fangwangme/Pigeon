import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { SkillEntry } from "../types/protocol";
import { findGitRoot } from "./git-branch";

export type { SkillEntry };

type Source = SkillEntry["source"];

interface Layout {
  skills: (home: string, root?: string) => Array<{ dir: string; source: Source }>;
  skillInvocation: string;
  commands?: (home: string, root?: string) => Array<{ dir: string; source: Source }>;
  commandInvocation?: string;
  /** `[name, descriptionId, English description]` (`herdr-adapter.md` §8.3). */
  builtins?: Array<[string, string, string]>;
  plugins?: boolean;
}

/** `herdr-adapter.md` §8.3. `{name}` in an invocation is replaced by the entry's name. */
const LAYOUTS: Record<string, Layout> = {
  claude: {
    skills: (home, root) => [
      ...(root ? [{ dir: join(root, ".claude", "skills"), source: "project" as const }] : []),
      { dir: join(home, ".claude", "skills"), source: "user" },
    ],
    skillInvocation: "/{name}",
    commands: (home, root) => [
      ...(root ? [{ dir: join(root, ".claude", "commands"), source: "project" as const }] : []),
      { dir: join(home, ".claude", "commands"), source: "user" },
    ],
    commandInvocation: "/{name}",
    builtins: [
      ["compact", "compact", "Compact the context"],
      ["clear", "clear", "Clear the conversation and start over"],
      ["init", "init_claude_md", "Write CLAUDE.md for this project"],
    ],
    plugins: true,
  },
  codex: {
    skills: (home, root) => [
      ...(root ? [{ dir: join(root, ".agents", "skills"), source: "project" as const }] : []),
      { dir: join(home, ".agents", "skills"), source: "user" },
      { dir: join(home, ".codex", "skills"), source: "user" },
    ],
    skillInvocation: "${name}",
    commands: (home) => [{ dir: join(home, ".codex", "prompts"), source: "user" }],
    commandInvocation: "/prompts:{name}",
    builtins: [
      ["compact", "compact", "Compact the context"],
      ["new", "new", "Start a new session"],
      ["init", "init_agents_md", "Write AGENTS.md for this project"],
      ["review", "review", "Review the current changes"],
    ],
  },
  pi: {
    skills: (home, root) => [
      ...(root ? [{ dir: join(root, ".pi", "skills"), source: "project" as const }] : []),
      { dir: join(home, ".pi", "agent", "skills"), source: "user" },
    ],
    skillInvocation: "/skill:{name}",
    commands: (home, root) => [
      ...(root ? [{ dir: join(root, ".pi", "prompts"), source: "project" as const }] : []),
      { dir: join(home, ".pi", "agent", "prompts"), source: "user" },
    ],
    commandInvocation: "/{name}",
    builtins: [
      ["compact", "compact", "Compact the context"],
      ["new", "new", "Start a new session"],
    ],
  },
  agy: {
    skills: (home, root) => [
      ...(root ? [{ dir: join(root, ".agents", "skills"), source: "project" as const }] : []),
      { dir: join(home, ".gemini", "antigravity-cli", "skills"), source: "user" },
      { dir: join(home, ".gemini", "antigravity", "builtin", "skills"), source: "builtin" },
    ],
    skillInvocation: "/{name}",
  },
  opencode: {
    skills: (home, root) => [
      ...(root ? [{ dir: join(root, ".opencode", "skills"), source: "project" as const }] : []),
      { dir: join(home, ".config", "opencode", "skills"), source: "user" },
    ],
    skillInvocation: "/{name}",
    commands: (home, root) => [
      ...(root ? [{ dir: join(root, ".opencode", "command"), source: "project" as const }] : []),
      { dir: join(home, ".config", "opencode", "command"), source: "user" },
    ],
    commandInvocation: "/{name}",
    builtins: [
      ["compact", "compact", "Compact the context"],
      ["new", "new", "Start a new session"],
      ["init", "init_agents_md", "Write AGENTS.md for this project"],
    ],
  },
};

/** The front matter `description:`, else (for commands) the first non-empty body line. Untrusted text. */
function readDescription(file: string, bodyFallback: boolean): string {
  if (!existsSync(file)) return "";
  const content = readFileSync(file, "utf-8");
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  const desc = fm && /^description:\s*(.+)$/m.exec(fm[1]);
  if (desc) return desc[1].trim().replace(/^["']|["']$/g, "").slice(0, 300);
  if (!bodyFallback) return "";
  const body = fm ? content.slice(fm[0].length) : content;
  return (body.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 300);
}

function skillDirs(dir: string): Array<{ name: string; file: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; file: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (existsSync(file)) out.push({ name: entry.name, file });
  }
  return out;
}

/** `.md` files below `dir`; a file in a subfolder `a/b.md` is named `a:b`. */
function commandFiles(dir: string): Array<{ name: string; file: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; file: string }> = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(p).isDirectory())) walk(p);
      else if (entry.name.endsWith(".md")) out.push({ name: relative(dir, p).slice(0, -3).split("/").join(":"), file: p });
    }
  };
  walk(dir);
  return out;
}

export class SkillScanner {
  private cache = new Map<string, { at: number; entries: SkillEntry[] }>();
  private ttlMs = 15_000;

  constructor(private home: string = homedir()) {}

  /** Entries for one agent kind in one project; empty for agents without a known layout. */
  public listSkills(agentKind: string | null, cwd?: string | null): SkillEntry[] {
    const layout = agentKind ? LAYOUTS[agentKind.toLowerCase()] : undefined;
    if (!layout) return [];
    const key = `${agentKind}|${cwd || ""}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.entries;

    const root = cwd ? findGitRoot(cwd) ?? cwd : undefined;
    const groups: Record<Source, SkillEntry[]> = { project: [], user: [], plugin: [], builtin: [] };
    const seen = new Set<string>();
    const add = (entry: SkillEntry) => {
      if (seen.has(entry.invocation)) return;
      seen.add(entry.invocation);
      groups[entry.source].push(entry);
    };
    // Earlier sources win on a clash: project, then user (herdr-adapter.md §8.3).
    for (const source of ["project", "user", "builtin"] as const) {
      for (const { dir, source: s } of layout.skills(this.home, root)) {
        if (s !== source) continue;
        for (const { name, file } of skillDirs(dir)) {
          add({ name, description: readDescription(file, false), source: s, kind: "skill", invocation: layout.skillInvocation.replace("{name}", name) });
        }
      }
      if (source === "builtin" || !layout.commands) continue;
      for (const { dir, source: s } of layout.commands(this.home, root)) {
        if (s !== source) continue;
        for (const { name, file } of commandFiles(dir)) {
          add({ name, description: readDescription(file, true), source: s, kind: "command", invocation: layout.commandInvocation!.replace("{name}", name) });
        }
      }
    }
    if (layout.plugins) for (const e of this.claudePlugins()) add(e);
    for (const g of [groups.project, groups.user, groups.plugin, groups.builtin]) g.sort((a, b) => a.invocation.localeCompare(b.invocation));
    for (const [name, descriptionId, description] of layout.builtins ?? []) add({ name, description, descriptionId, source: "builtin", kind: "command", invocation: `/${name}` });

    const entries = [...groups.project, ...groups.user, ...groups.plugin, ...groups.builtin];
    this.cache.set(key, { at: Date.now(), entries });
    return entries;
  }

  /** Claude plugins from `installed_plugins.json`, namespaced `/<plugin>:<name>`. */
  private claudePlugins(): SkillEntry[] {
    const file = join(this.home, ".claude", "plugins", "installed_plugins.json");
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, "utf-8"));
    const out: SkillEntry[] = [];
    for (const [key, installs] of Object.entries<any>(data.plugins ?? {})) {
      const plugin = key.split("@")[0];
      for (const install of Array.isArray(installs) ? installs : [installs]) {
        const path = typeof install?.installPath === "string" ? install.installPath : null;
        if (!path || !existsSync(path)) continue;
        for (const { name, file: f } of skillDirs(join(path, "skills"))) {
          out.push({ name: `${plugin}:${name}`, description: readDescription(f, false), source: "plugin", kind: "skill", invocation: `/${plugin}:${name}` });
        }
        for (const { name, file: f } of commandFiles(join(path, "commands"))) {
          out.push({ name: `${plugin}:${name}`, description: readDescription(f, true), source: "plugin", kind: "command", invocation: `/${plugin}:${name}` });
        }
      }
    }
    return out;
  }
}
