import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeQuotaProvider } from "../src/server/quota/claude";
import type { CredentialSource } from "../src/server/quota/credentials";
import { tempDir } from "./helpers/fixtures";

// quota-and-usage.md §2.2, §2.3, §4: the Claude provider's Keychain source and its family windows.

const NOW = Date.parse("2026-11-09T10:00:00Z");

describe("claude quota provider sources and windows (quota-and-usage.md §2.2, §2.3)", () => {
  let home: string;
  let server: ReturnType<typeof Bun.serve>;
  let usageBody: Record<string, unknown>;
  let acceptedToken: string;

  beforeEach(() => {
    home = tempDir("quota-providers");
    usageBody = {};
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/token") return Response.json({ access_token: "refreshed", refresh_token: "rt-new", expires_in: 3600 });
        if (req.headers.get("authorization") !== `Bearer ${acceptedToken}`) return new Response("{}", { status: 401 });
        return Response.json(usageBody);
      },
    });
  });

  afterEach(() => server.stop(true));

  const provider = (keychain: CredentialSource | false) =>
    new ClaudeQuotaProvider({
      home,
      usageUrl: `http://127.0.0.1:${server.port}/usage`,
      keychain,
      now: () => NOW,
    });

  test("without the credential file the Keychain item is used", async () => {
    const keychain = { read: () => JSON.stringify({ claudeAiOauth: { accessToken: "kc", expiresAt: NOW + 3600_000, subscriptionType: "max" } }) } as CredentialSource;
    acceptedToken = "kc";
    const snap = await provider(keychain).fetch();
    expect(snap.plan).toBe("max");
    expect(existsSync(join(home, ".claude", ".credentials.json"))).toBe(false);
  });

  test("without a credential file or Keychain item the provider fails naming the cause", async () => {
    await expect(provider(false).fetch()).rejects.toThrow(/Claude credentials not found/);
  });

  test("seven_day_<family> becomes a 7-day window of that family; null and unknown entries are not windows", async () => {
    const keychain: CredentialSource = { read: () => JSON.stringify({ claudeAiOauth: { accessToken: "live", expiresAt: NOW + 3600_000 } }), write: () => {} };
    acceptedToken = "live";
    usageBody = {
      five_hour: { utilization: 10, resets_at: null },
      seven_day: { utilization: 20, resets_at: null },
      seven_day_opus: null,
      seven_day_oauth_apps: { utilization: 30, resets_at: "2026-11-14T00:00:00Z" },
      extra_usage: { is_enabled: false },
    };
    const snap = await provider(keychain).fetch();
    expect(snap.windows.map((w) => w.id)).toEqual(["five_hour", "seven_day", "seven_day_oauth_apps"]);
    expect(snap.windows[2]).toMatchObject({ label: "7d · Oauth Apps", family: "Oauth Apps", usedPercent: 30, periodMs: 7 * 24 * 3600_000 });
  });
});
