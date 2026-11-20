import { describe, expect, test } from "bun:test";
import { parsePortArg, parseRepriceArgs } from "../src/cli/index";

// Issue #39 review: `--port=<n>` must not silently fall back to the production admin socket.
describe("admin CLI argument parsing (architecture.md §4.6)", () => {
  test("accepts --port <n> and --port=<n>", () => {
    expect(parsePortArg(["reprice", "--port", "4101"])).toBe(4101);
    expect(parsePortArg(["reprice", "--port=4101"])).toBe(4101);
    expect(parsePortArg(["reprice", "--json", "--port=4101"])).toBe(4101);
    expect(parsePortArg(["reprice"])).toBeUndefined();
    expect(() => parsePortArg(["reprice", "--port=0"])).toThrow("Invalid --port");
    expect(() => parsePortArg(["reprice", "--port"])).toThrow("Invalid --port");
  });

  test("reprice accepts --expect=<fp>, and both port forms, and rejects unknown options", () => {
    expect(parseRepriceArgs(["reprice", "--apply", "--yes", "--expect=abc", "--port=4101"])).toEqual({
      apply: true,
      yes: true,
      json: false,
      expectFingerprint: "abc",
    });
    expect(parseRepriceArgs(["reprice", "--apply", "--yes", "--expect", "abc", "--port", "4101"])).toMatchObject({
      apply: true,
      expectFingerprint: "abc",
    });
    expect(parseRepriceArgs(["reprice", "--json", "--port=4101"])).toEqual({
      apply: false,
      yes: false,
      json: true,
    });
    expect(() => parseRepriceArgs(["reprice", "--port=4101", "--bogus"])).toThrow("Unknown option for reprice");
    expect(() => parseRepriceArgs(["reprice", "--apply", "--yes"])).toThrow("--expect");
    expect(() => parseRepriceArgs(["reprice", "--expect"])).toThrow("--expect");
  });
});
