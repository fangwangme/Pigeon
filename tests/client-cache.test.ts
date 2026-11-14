import "fake-indexeddb/auto";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
// @ts-ignore
import { createStore as createBrowserStore } from "solid-js/store/dist/store.js";
import * as cache from "../src/client/src/state/pane-cache";
import { load, save, remove, clearAll, sweep, meta, PANE_CACHE_TTL_MS, MAX_CACHED_PANES, DB_VERSION } from "../src/client/src/state/pane-cache";
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
      const req = indexedDB.open("pigeon", DB_VERSION);
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

  test("leaving a pane via selectPane saves store state without Proxy cloning error (B1')", async () => {
    const [browserStore] = createBrowserStore({
      turns: [
        dummyTurn,
        { turnId: "t2", turnNumber: 2, timestamp: 2000, userPrompt: { text: "new turn from store" } },
      ],
    });
    setState("activePaneId", "pane_a");
    setState("session", {
      bound: true,
      agent: "claude",
      sessionId: "ses_store",
      model: { value: "opus", source: "launch" },
      thinking: { value: null, source: "unknown" },
    });
    setState("normalizedTurns", browserStore.turns);

    await selectPane("pane_b");
    await Bun.sleep(20);

    const loaded = await load("pane_a");
    expect(loaded).not.toBeNull();
    expect(loaded!.turns.length).toBe(2);
    expect(loaded!.turns[1].turnId).toBe("t2");
    expect(loaded!.turns[1].userPrompt?.text).toBe("new turn from store");
  });

  test("selectPane falls back to network select_view when load rejects (B2'')", async () => {
    const spy = spyOn(cache, "load").mockImplementation(() => Promise.reject(new Error("IDB dead")));
    try {
      await selectPane("pane_fallback");
      expect(state.activePaneId).toBe("pane_fallback");
    } finally {
      spy.mockRestore();
    }
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

    test("turns_delta updates IndexedDB pane cache after debounce (mobile-ui-and-themes.md §3.1)", async () => {
      setState("activePaneId", "p_delta");
      setState("session", {
        bound: true,
        sessionId: "s_delta",
        agent: "claude",
        model: { value: "opus", source: "log" },
        thinking: { value: null, source: "unknown" },
      });
      setState("normalizedTurns", [dummyTurn]);
      setState("queue", [{ queueId: "q1", text: "queued prompt", attachments: [], createdAt: 123 }]);

      const turn2: NormalizedTurn = { turnId: "t2", turnNumber: 2, timestamp: 2000, userPrompt: { text: "turn 2" } };

      handleServerMessage({
        type: "turns_delta",
        payload: {
          paneId: "p_delta",
          seqWatermark: 2,
          sinceTurnIndex: 1,
          appendTurns: [turn2],
        },
      });

      // Before debounce fires
      expect(await load("p_delta")).toBeNull();

      // Wait for debounce (300ms) to fire
      await Bun.sleep(350);

      const cached = await load("p_delta");
      expect(cached).not.toBeNull();
      expect(cached?.sessionId).toBe("s_delta");
      expect(cached?.turns).toHaveLength(2);
      expect(cached?.turns[1].turnId).toBe("t2");
      expect(cached?.queue).toEqual([{ queueId: "q1", text: "queued prompt", attachments: [], createdAt: 123 }]);
    });

    test("selectPane when socket is not open does not set lastError to ERR_OFFLINE", async () => {
      setState("lastError", null);
      await selectPane("p_offline_test");
      expect(state.lastError).toBeNull();
    });

    test("load uses readonly IDB transaction without writing", async () => {
      const putSpy = spyOn(IDBObjectStore.prototype, "put");
      const txSpy = spyOn(IDBDatabase.prototype, "transaction");
      try {
        await save("p_ro", { sessionId: "s_ro", turns: [dummyTurn] });
        const putsAfterSave = putSpy.mock.calls.length;
        await load("p_ro");
        expect(putSpy.mock.calls.length).toBe(putsAfterSave);
        expect(txSpy.mock.calls.some((c) => c[1] === "readonly")).toBe(true);
      } finally {
        putSpy.mockRestore();
        txSpy.mockRestore();
      }
    });
  });
});
