import { expect, test } from "bun:test";

// architecture.md §4.1: the daemon, the client and the tests type-check as one strict project.
test("tsc --noEmit reports no errors", () => {
  const proc = Bun.spawnSync(["bun", "x", "tsc", "-p", ".", "--noEmit"], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const output = proc.stdout.toString() + proc.stderr.toString();
  expect(output).toBe("");
  expect(proc.exitCode).toBe(0);
}, 120_000);
