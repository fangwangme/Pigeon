// Worker entrypoint for off-event-loop usage scanning and rebuilds (quota-and-usage.md §3.7).
import { PricingManager } from "./pricing";
import { UsageStore } from "./store";

export interface ScanWorkerRequest {
  kind: "scan" | "rebuild";
  dbPath?: string;
  cachePath?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  blockNonLoopbackFetch?: boolean;
}

export type ScanWorkerResponse =
  | {
      ok: true;
      kind: "scan";
      scannedFiles: number;
      recordsAdded: number;
      scannedAt: number;
      pricesAvailable: boolean;
    }
  | {
      ok: true;
      kind: "rebuild";
      scannedFiles: number;
      recordsAdded: number;
      recordCount: number;
      totalTokens: number;
      totalCost: number;
      scannedAt: number;
      pricesAvailable: boolean;
    }
  | { ok: false; error: string };

declare var self: Worker;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const offlineGuardedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(urlStr)) {
    const parsed = new URL(urlStr);
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new Error(`Blocked unexpected outbound fetch in tests: ${urlStr}`);
    }
  }
  return fetch(input, init);
}) as typeof fetch;

self.onmessage = async (event: MessageEvent<ScanWorkerRequest>) => {
  const req = event.data;
  const pricing = new PricingManager({
    cachePath: req.cachePath,
    ...(req.blockNonLoopbackFetch ? { fetch: offlineGuardedFetch } : {}),
  });
  let store: UsageStore | null = new UsageStore({ dbPath: req.dbPath, home: req.home, env: req.env });
  let reply: ScanWorkerResponse;
  try {
    await pricing.initialize();
    if (req.kind === "rebuild") {
      const res = await store.rebuildAll(pricing);
      const totals = store.getTotalsSummary();
      reply = {
        ok: true,
        kind: "rebuild",
        scannedFiles: res.scannedFiles,
        recordsAdded: res.recordsAdded,
        recordCount: totals.recordCount,
        totalTokens: totals.totalTokens,
        totalCost: totals.totalCost,
        scannedAt: store.getLastScannedAt(),
        pricesAvailable: pricing.arePricesAvailable(),
      };
    } else {
      const res = await store.scanIncremental(pricing);
      reply = {
        ok: true,
        kind: "scan",
        scannedFiles: res.scannedFiles,
        recordsAdded: res.recordsAdded,
        scannedAt: store.getLastScannedAt(),
        pricesAvailable: pricing.arePricesAvailable(),
      };
    }
  } catch (err) {
    reply = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (store) {
      try {
        store.close();
      } catch {}
      store = null;
    }
  }
  self.postMessage(reply);
};
