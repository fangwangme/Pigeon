import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PricingManager } from "../src/server/usage/pricing";
import { UsageStore } from "../src/server/usage/store";
import { tempDir } from "./helpers/fixtures";

// Issue #39. quota-and-usage.md §3.3 Price periods and Reprice; §4 Interfaces.

function claudeLine(timestamp: string, model: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: "assistant", timestamp, message: { model, usage } }) + "\n";
}

function anthropicPricing(dir: string, name: string, clock: () => number, cost: Record<string, number>): PricingManager {
  return new PricingManager({
    cachePath: join(dir, `${name}.json`),
    now: clock,
    fetch: (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.includes("models.dev")) return new Response("Not Found", { status: 404 });
      return Response.json({ anthropic: { models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6", cost } } } });
    }) as unknown as typeof fetch,
  });
}

function dump(db: Database): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const table of ["usage_records", "model_price_periods", "scan_file_state", "model_releases", "usage_meta"]) {
    out[table] = db.query(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
  }
  return out;
}

describe("price periods and reprice (quota-and-usage.md §3.3)", () => {
  test("a price change on a day with ingested records recomputes them, by close/open and by in-place update", async () => {
    const dir = tempDir("reprice-sameday");
    const dbPath = join(dir, "usage.db");
    const home = join(dir, "home");
    const projDir = join(home, ".claude", "projects", "-tmp-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "s1.jsonl"), claudeLine("2026-11-14T12:00:00Z", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));

    const clock = Date.parse("2026-11-14T13:00:00Z");
    const store = new UsageStore({ dbPath, home, now: () => clock, discoverLs: async () => null });
    const db = new Database(dbPath, { readonly: true });
    const cost = () => (db.query("SELECT cost FROM usage_records").get() as any).cost;

    const pm1 = anthropicPricing(dir, "p1", () => clock, { input: 3, output: 15 });
    await pm1.initialize();
    await store.scanIncremental(pm1);
    expect(cost()).toBeCloseTo(3, 9);

    // Active period starts at 0000-01-01: closed yesterday, new one opens today.
    const pm2 = anthropicPricing(dir, "p2", () => clock, { input: 6, output: 15 });
    await pm2.initialize();
    await store.scanIncremental(pm2);
    expect(cost()).toBeCloseTo(6, 9);

    // Active period starts today: updated in place.
    const pm3 = anthropicPricing(dir, "p3", () => clock, { input: 9, output: 15 });
    await pm3.initialize();
    await store.scanIncremental(pm3);
    expect(cost()).toBeCloseTo(9, 9);

    db.close();
    store.close();
  });

  test("dry run writes nothing; apply replaces every period, recomputes cost from unchanged tokens, and refuses a stale fingerprint", async () => {
    const dir = tempDir("reprice-apply");
    const dbPath = join(dir, "usage.db");
    const home = join(dir, "home");
    const projDir = join(home, ".claude", "projects", "-tmp-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, "s1.jsonl"),
      claudeLine("2026-11-10T12:00:00Z", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000 }) +
        claudeLine("2026-11-12T12:00:00Z", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000 }) +
        claudeLine("2026-11-12T13:00:00Z", "mystery-model-1", { input_tokens: 500, output_tokens: 5 })
    );

    const clock = Date.parse("2026-11-20T10:00:00Z");
    const store = new UsageStore({ dbPath, home, now: () => clock, discoverLs: async () => null });
    const offline = new PricingManager({
      cachePath: join(dir, "offline.json"),
      now: () => clock,
      fetch: (async () => new Response("err", { status: 500 })) as unknown as typeof fetch,
    });
    await store.scanIncremental(offline);

    // Dirty history left by the old selection, including a model no record uses.
    const rw = new Database(dbPath);
    rw.run(`INSERT INTO model_price_periods (model, effective_from, effective_to, input_rate, output_rate, cache_read_rate, cache_write_rate)
            VALUES ('claude-sonnet-4-6', '0000-01-01', '2026-11-11', 1, 5, NULL, NULL),
                   ('claude-sonnet-4-6', '2026-11-12', NULL, 2, 7, 0.5, NULL),
                   ('ghost-model', '0000-01-01', '2026-11-01', 9, 9, NULL, NULL),
                   ('ghost-model', '2026-11-02', NULL, 8, 8, NULL, NULL)`);
    rw.run("INSERT OR REPLACE INTO model_releases (model, release_date) VALUES ('gemini-9-flash', '2026-01-01')");
    rw.close();

    const pm = anthropicPricing(dir, "catalog", () => clock, { input: 3, output: 15 });
    await pm.initialize();

    const db = new Database(dbPath, { readonly: true });
    const before = dump(db);

    const report = await store.reprice(pm, { apply: false });
    expect(dump(db)).toEqual(before);
    expect(report.applied).toBe(false);
    expect(typeof report.fingerprint).toBe("string");
    const sonnet = report.models.find((m: any) => m.model === "claude-sonnet-4-6")!;
    expect(sonnet).toMatchObject({ records: 2, tier: "official-global", source: "anthropic" });
    // Cache read has no published rate: 0.1 × input. Per record 1M × 3 + 1M × 0.3 = $3.30.
    expect(sonnet.newCost).toBeCloseTo(6.6, 9);
    expect(report.unpricedModels).toContain("mystery-model-1");

    await expect(Promise.resolve().then(() => store.reprice(pm, { apply: true, expectFingerprint: "stale" }))).rejects.toThrow();
    expect(dump(db)).toEqual(before);

    const applied = await store.reprice(pm, { apply: true, expectFingerprint: report.fingerprint });
    expect(applied.applied).toBe(true);
    expect(existsSync(applied.backupPath!)).toBe(true);

    expect(db.query("SELECT model, effective_from, effective_to, input_rate, tier, source FROM model_price_periods ORDER BY model").all()).toEqual([
      { model: "claude-sonnet-4-6", effective_from: "0000-01-01", effective_to: null, input_rate: 3, tier: "official-global", source: "anthropic" },
    ]);

    const tokenColumns = "agent, message_key, date, canonical_model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens";
    const after = dump(db);
    expect(db.query(`SELECT ${tokenColumns} FROM usage_records ORDER BY 1, 2`).all()).toEqual(
      (before.usage_records as any[]).map((r) => ({
        agent: r.agent,
        message_key: r.message_key,
        date: r.date,
        canonical_model_id: r.canonical_model_id,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        total_tokens: r.total_tokens,
      }))
    );
    expect(after.scan_file_state).toEqual(before.scan_file_state);
    expect(after.model_releases).toEqual(before.model_releases);

    const priced = db.query("SELECT date, cost, unpriced FROM usage_records WHERE canonical_model_id = 'claude-sonnet-4-6' ORDER BY date").all() as any[];
    expect(priced.map((r) => r.unpriced)).toEqual([0, 0]);
    for (const r of priced) expect(r.cost).toBeCloseTo(3.3, 9);
    expect(db.query("SELECT cost, unpriced FROM usage_records WHERE canonical_model_id = 'mystery-model-1'").get()).toEqual({ cost: 0, unpriced: 1 });

    db.close();
    store.close();
  });
});
