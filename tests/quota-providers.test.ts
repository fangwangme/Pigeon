import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AntigravityQuotaProvider } from "../src/server/quota/antigravity";
import { ClaudeQuotaProvider } from "../src/server/quota/claude";
import { CodexQuotaProvider } from "../src/server/quota/codex";
import type { CredentialSource } from "../src/server/quota/credentials";
import { QuotaService } from "../src/server/quota/index";
import { DEFAULT_CLIENT_CONFIG } from "../src/shared/defaults";
import type { ClientConfig } from "../src/types/protocol";
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
    const keychain: CredentialSource = { read: () => JSON.stringify({ claudeAiOauth: { accessToken: "live", expiresAt: NOW + 3600_000 } }) };
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

  test("maps limits[] array and extra_usage dynamically from usage response", async () => {
    const keychain: CredentialSource = { read: () => JSON.stringify({ claudeAiOauth: { accessToken: "live", expiresAt: NOW + 3600_000 } }) };
    acceptedToken = "live";
    usageBody = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "claude-usage-limits.json"), "utf-8"));
    const snap = await provider(keychain).fetch();
    expect(snap.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["5h", 33],
      ["7d", 43],
      ["7d · Fable", 71],
    ]);
    expect(snap.extraUsage).toEqual({ used: 0, limit: 50, currency: "USD" });
  });
});

describe("antigravity & codex quota providers (quota-and-usage.md §2.2, §2.3)", () => {
  const servers: Array<ReturnType<typeof Bun.serve>> = [];
  afterEach(() => {
    while (servers.length) servers.pop()!.stop(true);
  });

  test("Antigravity preserves API group order, uses Claude/GPT and bucket.id, and reads onboarding username", async () => {
    const dir = tempDir("quota-agy");
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "agy-usage-groups.json"), "utf-8"));
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/RetrieveUserQuotaSummary")) return Response.json(fixture);
        if (url.pathname.endsWith("/GetUserStatus")) return Response.json({ userStatus: { tierName: "Pro", email: "" } });
        return Response.json({});
      },
    });
    servers.push(srv);

    const agyCliDir = join(dir, ".gemini", "antigravity-cli");
    mkdirSync(join(agyCliDir, "daemon"), { recursive: true });
    writeFileSync(join(agyCliDir, "daemon", "ls.json"), JSON.stringify({ pid: process.pid, httpPort: srv.port, csrfToken: "csrf-test" }), "utf-8");
    writeFileSync(join(agyCliDir, "app_storage.json"), JSON.stringify({ "agy.onboarding.lastLoginUsername": "alice@example.com" }), "utf-8");

    const provider = new AntigravityQuotaProvider({ home: dir, now: () => 1_700_000_000_000 });
    const qs = new QuotaService({ autoScan: false, antigravity: provider, claude: { fetch: async () => ({ provider: "claude", windows: [], credits: [], fetchedAt: 1 }) } as any, codex: { fetch: async () => ({ provider: "codex", windows: [], credits: [], fetchedAt: 1 }) } as any });
    const res = await qs.getQuota({ ...DEFAULT_CLIENT_CONFIG, quotaProviders: { claude: false, codex: false, antigravity: true } });
    const snap = res.providers.find((p) => p.provider === "antigravity")!.snapshot!;
    expect(snap.account).toBe("alice@example.com");
    expect(snap.plan).toBe("Pro");
    // §2.1: groups keep the API's order; within each, 5h comes before 7d although the API lists weekly first.
    expect(snap.windows.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
      ["gemini-5h", "Gemini · 5h", 10],
      ["gemini-weekly", "Gemini · 7d", 40],
      ["3p-5h", "Claude/GPT · 5h", 15],
      ["3p-weekly", "Claude/GPT · 7d", 60],
      ["gemini-argon-wtu-weekly", "Gemini 4 Argon · 7d", 25],
    ]);
  });

  test("every provider's windows are grouped by category, then 5h before 7d before windows without a period (§2.1)", async () => {
    const H = 3_600_000;
    const w = (id: string, periodMs: number | null, family?: string) => ({ id, label: id, usedPercent: 0, periodMs, resetsAt: null, ...(family ? { family } : {}) });
    const qs = new QuotaService({
      autoScan: false,
      claude: { fetch: async () => ({ provider: "claude", windows: [w("7d", 168 * H), w("7d-fable", 168 * H, "Fable"), w("5h", 5 * H), w("5h-fable", 5 * H, "Fable")], credits: [], fetchedAt: 1 }) } as any,
      codex: { fetch: async () => ({ provider: "codex", windows: [w("other", null), w("weekly", 168 * H), w("primary", 5 * H)], credits: [], fetchedAt: 1 }) } as any,
      antigravity: { fetch: async () => ({ provider: "antigravity", windows: [], credits: [], fetchedAt: 1 }) } as any,
    });
    const res = await qs.getQuota(DEFAULT_CLIENT_CONFIG);
    const ids = (p: string) => res.providers.find((x) => x.provider === p)!.snapshot!.windows.map((x) => x.id);
    expect(ids("claude")).toEqual(["5h", "7d", "5h-fable", "7d-fable"]);
    expect(ids("codex")).toEqual(["primary", "weekly", "other"]);
  });

  test("Codex and Antigravity expired credentials fail with login expired without mutating credential files", async () => {
    const dir = tempDir("quota-ro");
    let tokenEndpointCalled = false;
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname.includes("token")) tokenEndpointCalled = true;
        return new Response("Unauthorized", { status: 401 });
      },
    });
    servers.push(srv);

    mkdirSync(join(dir, ".codex"), { recursive: true });
    const expiredJwtPayload = Buffer.from(JSON.stringify({ exp: 1_000 })).toString("base64url");
    const authContent = JSON.stringify({
      tokens: {
        access_token: `hdr.${expiredJwtPayload}.sig`,
        refresh_token: "rt_should_not_refresh",
      },
    });
    const authPath = join(dir, ".codex", "auth.json");
    writeFileSync(authPath, authContent, "utf-8");

    const codex = new CodexQuotaProvider({
      home: dir,
      usageUrl: `http://127.0.0.1:${srv.port}/usage`,
      creditsUrl: `http://127.0.0.1:${srv.port}/credits`,
      tokenUrl: `http://127.0.0.1:${srv.port}/token`,
      env: { ...process.env, CODEX_HOME: join(dir, ".codex") },
      now: () => 1_700_000_000_000,
    });
    await expect(codex.fetch()).rejects.toThrow(/login expired/i);
    expect(readFileSync(authPath, "utf-8")).toBe(authContent);
    expect(tokenEndpointCalled).toBe(false);

    mkdirSync(join(dir, ".gemini", "antigravity-cli"), { recursive: true });
    const agyTokPath = join(dir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    const agyTokContent = JSON.stringify({
      access_token: "old",
      refresh_token: "rt",
      expiry_date: 1_000,
    });
    writeFileSync(agyTokPath, agyTokContent, "utf-8");

    const agy = new AntigravityQuotaProvider({ home: dir, now: () => 1_700_000_000_000, agyUsageCommand: ["sh", "-c", "exit 1"] });
    await expect(agy.fetch()).rejects.toThrow(/login expired/i);
    expect(readFileSync(agyTokPath, "utf-8")).toBe(agyTokContent);
  });

  test("Antigravity still asks the agy CLI when its token file has expired (the CLI refreshes its own login)", async () => {
    const dir = tempDir("quota-agy-cli");
    mkdirSync(join(dir, ".gemini", "antigravity-cli"), { recursive: true });
    const agyTokPath = join(dir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    const agyTokContent = JSON.stringify({ access_token: "old", refresh_token: "rt", expiry_date: 1_000 });
    writeFileSync(agyTokPath, agyTokContent, "utf-8");
    const fixturePath = join(import.meta.dir, "fixtures", "agy-usage-groups.json");

    const agy = new AntigravityQuotaProvider({ home: dir, now: () => 1_700_000_000_000, agyUsageCommand: ["cat", fixturePath] });
    const snap = await agy.fetch();
    expect(snap.windows.map((w) => w.id)).toContain("3p-weekly");
    expect(readFileSync(agyTokPath, "utf-8")).toBe(agyTokContent);
  });

  test("the Antigravity account is the CLI's own sign-in when the CLI answers, never the desktop app's (§2.2)", async () => {
    const dir = tempDir("quota-agy-account");
    mkdirSync(join(dir, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(dir, ".gemini", "antigravity-cli", "cli.log"),
      "I1114 server_oauth.go:226] OAuth: authenticated successfully as old@example.com\nI1114 server_oauth.go:226] OAuth: authenticated successfully as cli@example.com\n",
      "utf-8"
    );
    mkdirSync(join(dir, ".config", "Antigravity"), { recursive: true });
    writeFileSync(join(dir, ".config", "Antigravity", "app_storage.json"), JSON.stringify({ "agy.onboarding.lastLoginUsername": "desktop@example.com" }), "utf-8");
    const fixturePath = join(import.meta.dir, "fixtures", "agy-usage-groups.json");

    const agy = new AntigravityQuotaProvider({ home: dir, now: () => 1_700_000_000_000, agyUsageCommand: ["cat", fixturePath] });
    expect((await agy.fetch()).account).toBe("cli@example.com");

    rmSync(join(dir, ".gemini", "antigravity-cli", "cli.log"));
    expect((await agy.fetch()).account).toBeUndefined();
  });

  test("QuotaService defaults omitted quotaProviders entries to enabled while honoring false", async () => {
    const partialCfg: ClientConfig = {
      ...DEFAULT_CLIENT_CONFIG,
      quotaProviders: { claude: false } as any,
    };
    const qs = new QuotaService({
      autoScan: false,
      claude: { fetch: async () => ({ provider: "claude", windows: [], credits: [], fetchedAt: 1 }) } as any,
      codex: { fetch: async () => ({ provider: "codex", windows: [], credits: [], fetchedAt: 1 }) } as any,
      antigravity: { fetch: async () => ({ provider: "antigravity", windows: [], credits: [], fetchedAt: 1 }) } as any,
    });
    const res = await qs.getQuota(partialCfg);
    expect(res.providers.find((p) => p.provider === "claude")?.enabled).toBe(false);
    expect(res.providers.find((p) => p.provider === "codex")?.enabled).toBe(true);
    expect(res.providers.find((p) => p.provider === "antigravity")?.enabled).toBe(true);
  });
});
