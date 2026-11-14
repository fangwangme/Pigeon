import { describe, expect, test } from "bun:test";

// Issue #23 Acceptance, architecture.md §4.1 (test preload): tests never reach outside hosts or the user's home.
describe("test harness isolation", () => {
  test("an unexpected outbound fetch throws while loopback stays reachable", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(/Blocked unexpected outbound fetch/);
    const srv = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      expect(await (await fetch(`http://127.0.0.1:${srv.port}/`)).text()).toBe("ok");
    } finally {
      srv.stop(true);
    }
  });

  test("HOME, XDG and CODEX_HOME point into a temporary directory", () => {
    const home = process.env.HOME!;
    expect(home).toContain("pigeon-test-home-");
    for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "CODEX_HOME"]) {
      expect(process.env[key]!.startsWith(home + "/")).toBe(true);
    }
  });
});
