import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentRecipe } from "../src/server/agent-recipes";
import { SkillScanner } from "../src/server/skill-scanner";
import { tempDir } from "./helpers/fixtures";

// herdr-adapter.md §5 (launch arguments) and §8.3 (skills and commands per pane).
describe("launch arguments (herdr-adapter.md §5)", () => {
  test.each([
    ["claude", ["--model", "opus", "--effort", "high"]],
    ["codex", ["--no-daemon", "-m", "opus", "-c", 'model_reasoning_effort="high"']],
    ["agy", ["--model", "opus", "--effort", "high"]],
    ["pi", ["--model", "opus", "--thinking", "high"]],
    ["opencode", []],
  ])("%s", (kind, args) => {
    expect(getAgentRecipe(kind as string)!.launchArgs({ modelId: "opus", thinking: "high" })).toEqual(args as string[]);
  });

  test("agents are interrupted with Esc, a plain terminal with Ctrl+C", () => {
    expect(getAgentRecipe("claude")!.interruptKeys).toEqual(["esc"]);
    expect(getAgentRecipe("terminal")!.interruptKeys).toEqual(["ctrl+c"]);
  });
});

function skill(dir: string, name: string, description: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: "${description}"\n---\nbody\n`);
}

const userEntries = <T extends { source: string }>(entries: T[]) => entries.filter((e) => e.source !== "builtin");

describe("skills per pane (herdr-adapter.md §8.3)", () => {
  test("each agent reads its own directories and gets its own invocation syntax", () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    skill(join(proj, ".claude", "skills"), "review", "Review code");
    skill(join(home, ".pi", "agent", "skills"), "plan", "Plan work");
    skill(join(proj, ".agents", "skills"), "ship", "Ship it");
    skill(join(home, ".gemini", "antigravity-cli", "builtin", "skills"), "guide", "Builtin guide");
    const scanner = new SkillScanner(home);
    expect(userEntries(scanner.listSkills("claude", proj))).toEqual([{ name: "review", description: "Review code", source: "project", kind: "skill", invocation: "/review" }]);
    expect(userEntries(scanner.listSkills("pi", proj)).map((s: any) => s.invocation)).toEqual(["/skill:plan"]);
    expect(userEntries(scanner.listSkills("codex", proj)).map((s: any) => s.invocation)).toEqual(["$ship"]);
    expect(scanner.listSkills("agy", proj).map((s: any) => [s.invocation, s.source])).toEqual([
      ["/ship", "project"],
      ["/guide", "builtin"],
    ]);
  });

  test("a project skill shadows a user skill of the same name", () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    skill(join(home, ".claude", "skills"), "review", "user copy");
    skill(join(proj, ".claude", "skills"), "review", "project copy");
    expect(userEntries(new SkillScanner(home).listSkills("claude", proj))).toEqual([{ name: "review", description: "project copy", source: "project", kind: "skill", invocation: "/review" }]);
  });

  test("a plain terminal has no skills", () => {
    expect(new SkillScanner(tempDir("home")).listSkills(null, "/")).toEqual([]);
  });

  test("project entries are found at the git root above the pane's folder", () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    mkdirSync(join(proj, ".git"));
    mkdirSync(join(proj, "src", "deep"), { recursive: true });
    skill(join(proj, ".claude", "skills"), "review", "Review code");
    expect(userEntries(new SkillScanner(home).listSkills("claude", join(proj, "src", "deep"))).map((s: any) => s.name)).toEqual(["review"]);
  });

  test("custom commands, with a subfolder as namespace, are commands", () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    mkdirSync(join(proj, ".claude", "commands", "git"), { recursive: true });
    writeFileSync(join(proj, ".claude", "commands", "ship.md"), "---\ndescription: Ship it\n---\nbody\n");
    writeFileSync(join(proj, ".claude", "commands", "git", "sync.md"), "Sync with main\n");
    mkdirSync(join(home, ".codex", "prompts"), { recursive: true });
    writeFileSync(join(home, ".codex", "prompts", "triage.md"), "Triage issues\n");
    const scanner = new SkillScanner(home);
    const claude = userEntries(scanner.listSkills("claude", proj));
    expect(claude.map((s: any) => [s.invocation, s.kind, s.source, s.description])).toEqual([
      ["/git:sync", "command", "project", "Sync with main"],
      ["/ship", "command", "project", "Ship it"],
    ]);
    expect(userEntries(scanner.listSkills("codex", proj)).map((s: any) => s.invocation)).toEqual(["/prompts:triage"]);
  });

  test("Claude plugin skills are namespaced by the plugin", () => {
    const home = tempDir("home");
    const install = join(home, "plugin-cache", "warp");
    skill(join(install, "skills"), "notify", "Send a note");
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "warp@market": [{ scope: "user", installPath: install }], "gone@market": [{ scope: "user", installPath: join(home, "missing") }] } })
    );
    expect(userEntries(new SkillScanner(home).listSkills("claude", tempDir("proj")))).toEqual([
      { name: "warp:notify", description: "Send a note", source: "plugin", kind: "skill", invocation: "/warp:notify" },
    ]);
  });

  test("each agent offers its short list of built-in commands, without /model", () => {
    const builtins = new SkillScanner(tempDir("home")).listSkills("claude", tempDir("proj")).filter((s) => s.source === "builtin");
    expect(builtins.map((s) => [s.invocation, s.kind])).toEqual([
      ["/compact", "command"],
      ["/clear", "command"],
      ["/init", "command"],
    ]);
  });

  test("built-in commands carry a description id and an English description (herdr-adapter.md §8.3, protocol.md §5.7)", () => {
    const scanner = new SkillScanner(tempDir("home"));
    const ids = (agent: string) => scanner.listSkills(agent, tempDir("proj")).filter((s) => s.source === "builtin").map((s) => [s.name, s.descriptionId]);
    expect(ids("claude")).toEqual([["compact", "compact"], ["clear", "clear"], ["init", "init_claude_md"]]);
    expect(ids("codex")).toEqual([["compact", "compact"], ["new", "new"], ["init", "init_agents_md"], ["review", "review"]]);
    for (const s of scanner.listSkills("codex", tempDir("proj")).filter((s) => s.source === "builtin")) expect(s.description).toMatch(/^[\x20-\x7e]+$/);
  });
});
