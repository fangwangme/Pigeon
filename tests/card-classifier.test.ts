import { describe, expect, test } from "bun:test";
import { CardClassifier, buildUnrecognizedPrompt } from "../src/server/card-classifier";

// herdr-adapter.md §8 (screen parse rules) and protocol.md §4.1 (answering prompts).
const classifier = new CardClassifier();
const classify = (screen: string) => classifier.classifyScreen(screen);

describe("screen cards (herdr-adapter.md §8)", () => {
  test("a `$ cmd` block becomes a tool_call card with its output and exit code", () => {
    const { cards } = classify("$ bun test\nall good\nexit code: 0\n");
    const tool = cards.find((c) => c.kind === "tool_call") as any;
    expect(tool.command).toBe("bun test");
    expect(tool.exitCode).toBe(0);
    expect(tool.status).toBe("done");
  });

  test("a tool call without a visible exit code leaves exitCode unknown", () => {
    const { cards } = classify("$ ls\nREADME.md\n");
    expect((cards[0] as any).exitCode).toBeUndefined();
  });

  test("`● Name(args)` is a tool call, `● plain text` is not", () => {
    const { cards } = classify("● Bash(git status)\nclean\n● I checked the tree.\n");
    const tools = cards.filter((c) => c.kind === "tool_call") as any[];
    expect(tools.map((t) => [t.title, t.command])).toEqual([["Bash", "git status"]]);
  });

  test("a unified diff becomes a diff card with line counts", () => {
    const { cards } = classify("diff --git a/src/auth.ts b/src/auth.ts\n@@ -1,3 +1,3 @@\n-const exp = 100;\n+const exp = 200;\n");
    const diff = cards.find((c) => c.kind === "diff") as any;
    expect(diff.filePath).toBe("src/auth.ts");
    expect([diff.additions, diff.deletions]).toEqual([1, 1]);
  });

  test("identical blocks get distinct card ids", () => {
    const { cards } = classify("$ ls\na\n$ ls\na\n");
    expect(cards).toHaveLength(2);
    expect(cards[0].id).not.toBe(cards[1].id);
  });
});

describe("pending prompts (protocol.md §4.1)", () => {
  test("numbered options at the screen tail become choices keyed by their digit", () => {
    const { pendingInteraction } = classify("Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No\n\nEsc to cancel\n");
    expect(pendingInteraction).not.toBeNull();
    expect(pendingInteraction!.options.map((o) => [o.keyShortcut, o.label])).toEqual([
      ["1", "Yes"],
      ["2", "Yes, and don't ask again"],
      ["3", "No"],
    ]);
  });

  test("an arrow-cursor menu without numbers is pending but offers no structured choices", () => {
    const { pendingInteraction } = classify("Select a model\n❯ Opus\n  Sonnet\n");
    expect(pendingInteraction).not.toBeNull();
    expect(pendingInteraction!.options).toEqual([]);
    expect(pendingInteraction!.fallbackKeys).toContain("enter");
  });

  test("a y/n prompt offers no structured choices and a y/n key pad", () => {
    const { pendingInteraction } = classify("Overwrite file? (y/n)\n");
    expect(pendingInteraction!.options).toEqual([]);
    expect(pendingInteraction!.fallbackKeys).toEqual(["y", "n", "enter", "esc"]);
  });

  test("a prompt with output after it is history, not pending", () => {
    const { pendingInteraction } = classify("Do you want to proceed?\n1. Yes\n2. No\n$ bun test\nok\n");
    expect(pendingInteraction).toBeNull();
  });

  test("a prompt directly after a diff is still detected", () => {
    const screen = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-x\n+y\nDo you want to make this edit?\n1. Yes\n2. No\n";
    const { cards, pendingInteraction } = classify(screen);
    expect(cards.some((c) => c.kind === "diff")).toBe(true);
    expect(pendingInteraction?.question).toBe("Do you want to make this edit?");
  });

  test("a prompt inside a TUI box border is detected", () => {
    const { pendingInteraction } = classify("╭────────╮\n│ Do you want to proceed? │\n│ 1. Yes │\n│ 2. No │\n╰────────╯\n");
    expect(pendingInteraction?.options.map((o) => o.keyShortcut)).toEqual(["1", "2"]);
  });

  test("interactionId and fingerprint stay the same as earlier output scrolls away", () => {
    const prompt = "Do you want to proceed?\n1. Yes\n2. No\n";
    const a = classify(`$ ls\nfile\n${prompt}`).pendingInteraction!;
    const b = classify(`file\n${prompt}`).pendingInteraction!;
    expect(b.interactionId).toBe(a.interactionId);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  test("a different prompt gets a different interactionId", () => {
    const a = classify("Do you want to proceed?\n1. Yes\n2. No\n").pendingInteraction!;
    const b = classify("Do you want to delete it?\n1. Yes\n2. No\n").pendingInteraction!;
    expect(b.interactionId).not.toBe(a.interactionId);
  });
});

describe("what is a prompt (herdr-adapter.md §8.2)", () => {
  test("plain text and the input line are not a cursor menu (B5)", () => {
    const idle = [
      "● I updated the parser and the tests pass.",
      "",
      "Select a file to review next, or ask me to continue.",
      "",
      "╭──────────────────────────────────────────╮",
      "│ >                                        │",
      "╰──────────────────────────────────────────╯",
      "",
    ].join("\n");
    expect(classify(idle).pendingInteraction).toBeNull();
  });

  test("buildUnrecognizedPrompt filters status lines and extracts error dialog cleanly", () => {
    const screen = [
      "╭───────────────────────────────────────────╮",
      "│ No capacity available for model gemini-3. │",
      "│ 8-flash-medium on the server)             │",
      "│ Error ID: 56ffdbc0-8965-4219-8736-d0eb    │",
      "╰───────────────────────────────────────────╯",
      ">",
      "Pigeon main ctx:14%/1M token:672k Gemini 3.8 Flash (Medium) mode:auto",
    ].join("\n");
    const prompt = buildUnrecognizedPrompt(screen);
    expect(prompt.title).toBe("Agent Error");
    expect(prompt.question).toContain("No capacity available");
    expect(prompt.question).not.toContain("mode:auto");
    expect(prompt.payload).toContain("Error ID: 56ffdbc0");
    expect(prompt.payload).not.toContain("mode:auto");
    expect(prompt.options).toHaveLength(0);
  });
});

describe("question menus (herdr-adapter.md §8.2)", () => {
  const classifier = new CardClassifier();

  test("Claude's multi-select menu: question, options with descriptions, its own entries left out", () => {
    const screen = [
      "←  ☐ Toppings  ☐ Size  ✔ Submit  →",
      "Pick toppings",
      "❯ 1. [ ] Cheese",
      "         Cheese topping",
      "  2. [✔] Ham",
      "         Ham topping",
      "  3. [ ] Type something",
      "     Next",
      "────────────",
      "  4. Chat about this",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ].join("\n");
    const p = classifier.classifyScreen(screen).pendingInteraction!;
    expect(p.question).toBe("Pick toppings");
    expect(p.multiSelect).toBe(true);
    expect(p.options.map((o) => [o.id, o.label, o.description, o.keyShortcut])).toEqual([
      ["opt_1", "Cheese", "Cheese topping", "1"],
      ["opt_2", "Ham", "Ham topping", "2"],
    ]);
  });

  test("a single-select menu without a question mark is a single-select question", () => {
    const screen = "Pick a size\n❯ 1. Small\n     Small size\n  2. Large\n  3. Type something.\nEnter to select · ↑/↓ to navigate · Esc to cancel";
    const p = classifier.classifyScreen(screen).pendingInteraction!;
    expect([p.question, p.multiSelect, p.options.map((o) => o.label)]).toEqual(["Pick a size", false, ["Small", "Large"]]);
  });
});
