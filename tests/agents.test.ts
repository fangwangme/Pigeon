import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentRecipe } from "../src/server/agent-recipes";
import { SkillScanner } from "../src/server/skill-scanner";
import { tempDir } from "./helpers/fixtures";

// herdr-adapter.md §5 (launch arguments) and protocol.md §5.10 (skills per pane).
describe("launch arguments (herdr-adapter.md §5)", () => {
  test.each([
    ["claude", ["--model", "opus", "--effort", "high"]],
    ["codex", ["-m", "opus", "-c", 'model_reasoning_effort="high"']],
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

describe("skills per pane (protocol.md §5.10)", () => {
  test("each agent reads its own directories and gets its own invocation syntax", () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    skill(join(proj, ".claude", "skills"), "review", "Review code");
    skill(join(home, ".pi", "agent", "skills"), "plan", "Plan work");
    skill(join(proj, ".agents", "skills"), "ship", "Ship it");
    const scanner = new SkillScanner(home);
    expect(scanner.listSkills("claude", proj)).toEqual([{ name: "review", description: "Review code", source: "project", invocation: "/review" }]);
    expect(scanner.listSkills("pi", proj).map((s) => s.invocation)).toEqual(["/skill:plan"]);
    expect(scanner.listSkills("codex", proj).map((s) => s.invocation)).toEqual(["$ship"]);
  });

  test("a project skill shadows a user skill of the same name", () => {
    const home = tempDir("home");
    const proj = tempDir("proj");
    skill(join(home, ".claude", "skills"), "review", "user copy");
    skill(join(proj, ".claude", "skills"), "review", "project copy");
    expect(new SkillScanner(home).listSkills("claude", proj)).toEqual([{ name: "review", description: "project copy", source: "project", invocation: "/review" }]);
  });

  test("a plain terminal has no skills", () => {
    expect(new SkillScanner(tempDir("home")).listSkills(null, "/")).toEqual([]);
  });
});
