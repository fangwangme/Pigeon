import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SkillEntry {
  name: string;
  description: string;
  source: "builtin" | "user" | "project";
  path?: string;
}

export class SkillScanner {
  private cache: SkillEntry[] | null = null;
  private lastScanTime = 0;
  private ttlMs = 15000; // Cache for 15s

  public listSkills(projectRoot?: string): SkillEntry[] {
    const now = Date.now();
    if (this.cache && now - this.lastScanTime < this.ttlMs) {
      return this.cache;
    }

    const home = process.env.HOME || "";
    const searchDirs: Array<{ path: string; source: "builtin" | "user" | "project" }> = [
      { path: join(home, ".gemini/antigravity/builtin/skills"), source: "builtin" },
      { path: join(home, ".gemini/config/skills"), source: "user" },
      { path: join(home, ".claude/skills"), source: "user" },
    ];

    if (projectRoot) {
      searchDirs.push(
        { path: join(projectRoot, ".agents/skills"), source: "project" },
        { path: join(projectRoot, "skills"), source: "project" }
      );
    }

    const results = new Map<string, SkillEntry>();

    for (const { path: dir, source } of searchDirs) {
      if (!existsSync(dir)) continue;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillName = entry.name;
          if (results.has(skillName)) continue;

          let description = "";
          const skillMdPath = join(dir, skillName, "SKILL.md");
          if (existsSync(skillMdPath)) {
            try {
              const content = readFileSync(skillMdPath, "utf-8");
              // Parse yaml frontmatter description if present
              const descMatch = content.match(/description:\s*([^\r\n]+)/i);
              if (descMatch) {
                description = descMatch[1].trim().replace(/^["']|["']$/g, "");
              } else {
                // Fallback to first non-heading paragraph
                const lines = content.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
                if (lines.length > 0) {
                  description = lines[0].substring(0, 100);
                }
              }
            } catch {}
          }

          results.set(skillName, {
            name: skillName,
            description: description || `Skill ${skillName}`,
            source,
            path: skillMdPath,
          });
        }
      } catch {}
    }

    this.cache = Array.from(results.values()).sort((a, b) => a.name.localeCompare(b.name));
    this.lastScanTime = now;
    return this.cache;
  }
}
