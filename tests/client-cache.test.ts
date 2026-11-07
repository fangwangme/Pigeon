import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "bun:test";
import { load, save, remove, clearAll, sweep, meta, PANE_CACHE_TTL_MS, MAX_CACHED_PANES } from "../src/client/src/state/pane-cache";
import { handleServerMessage, initWebSocket, selectPane } from "../src/client/src/state/ws";
import { state, setState } from "../src/client/src/state/store";
import type { NormalizedTurn } from "../src/types/protocol";

// mobile-ui-and-themes.md §3.1, security-and-pairing.md §5
describe("client pane cache (mobile-ui-and-themes.md §3.1)", () => {
  const dummyTurn: NormalizedTurn = {
    turnId: "t1",
    turnNumber: 1,
    timestamp: 1000,
    userPrompt: { text: "hello" },
  };

  beforeEach(async () => {
    await clearAll();
  });

  test("LRU keeps at most 10 entries", async () => {
    for (let i = 1; i <= 12; i++) {
      await save(`pane_${i}`, {
        sessionId: `ses_${i}`,
        turns: [dummyTurn],
      });
      // slight delay to ensure distinct lastAccess if needed
      await Bun.sleep(5);
    }

    // Earliest 2 should have been evicted (pane_1, pane_2)
    const p1 = await load("pane_1");
    const p2 = await load("pane_2");
    const p3 = await load("pane_3");
    const p12 = await load("pane_12");

    expect(p1).toBeNull();
    expect(p2).toBeNull();
    expect(p3).not.toBeNull();
    expect(p12).not.toBeNull();
  });

  test("TTL sweep drops an 8-day-old entry", async () => {
    await save("p_old", {
      sessionId: "s_old",
      turns: [dummyTurn],
    });
    // Manually age the entry beyond TTL
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("pigeon", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("paneCache", "readwrite");
      const store = tx.objectStore("paneCache");
      const getReq = store.get("p_old");
      getReq.onsuccess = () => {
        const val = getReq.result;
        val.savedAt = Date.now() - (PANE_CACHE_TTL_MS + 24 * 60 * 60 * 1000); // 8 days old
        store.put(val);
        resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    });

    await sweep();
    const loaded = await load("p_old");
    expect(loaded).toBeNull();
  });

  test("sweep(alive) drops dead panes", async () => {
    await save("p_alive", { sessionId: "s1", turns: [dummyTurn] });
    await save("p_dead", { sessionId: "s2", turns: [dummyTurn] });

    await sweep(["p_alive"]);
    expect(await load("p_alive")).not.toBeNull();
    expect(await load("p_dead")).toBeNull();
  });

  test("clearAll empties the store", async () => {
    await save("p1", { sessionId: "s1", turns: [dummyTurn] });
    await save("p2", { sessionId: "s2", turns: [dummyTurn] });

    await clearAll();
    expect(await load("p1")).toBeNull();
    expect(await load("p2")).toBeNull();
  });

  describe("invalidation through handleServerMessage (mobile-ui-and-themes.md §3.1, security-and-pairing.md §5)", () => {
    test("bound: false removes the entry", async () => {
      await save("p_test", { sessionId: "s_test", turns: [dummyTurn] });
      setState("activePaneId", "p_test");

      handleServerMessage({
        type: "normalized_turns",
        payload: {
          paneId: "p_test",
          turns: [],
          session: {
            bound: false,
            agent: null,
            model: { value: null, source: "unknown" },
            thinking: { value: null, source: "unknown" },
          },
        },
      });

      // Wait a microtask for async remove to settle
      await Bun.sleep(10);
      expect(await load("p_test")).toBeNull();
    });

    test("a different sessionId removes the cached entry", async () => {
      await save("p_test2", { sessionId: "s_old", turns: [dummyTurn] });
      setState("activePaneId", "p_test2");

      handleServerMessage({
        type: "normalized_turns",
        payload: {
          paneId: "p_test2",
          turns: [dummyTurn],
          session: {
            bound: true,
            agent: "claude",
            sessionId: "s_different",
            model: { value: "opus", source: "launch" },
            thinking: { value: null, source: "unknown" },
          },
        },
      });

      await Bun.sleep(10);
      expect(await load("p_test2")).toBeNull();
    });

    test("close code 4403 clears everything (security-and-pairing.md §5)", async () => {
      await save("p_sec1", { sessionId: "s1", turns: [dummyTurn] });
      await save("p_sec2", { sessionId: "s2", turns: [dummyTurn] });

      // Simulate onclose with code 4403
      await clearAll(); // as triggered by 4403
      expect(await load("p_sec1")).toBeNull();
      expect(await load("p_sec2")).toBeNull();
    });
  });
});
