import { describe, expect, test } from "bun:test";
import { handleServerMessage, initWebSocket, selectPane } from "../src/client/src/state/ws";
import { setState, setUnread, state } from "../src/client/src/state/store";
import type { PaneStatePayload } from "../src/types/protocol";

// protocol.md §2.2 (reconnecting), §3.2 (buildId), §3.3 (cached state on (re)selection),
// §5.4 (revision filter), §6.3 (config versions).
function paneState(paneId: string, revision: number, screen: string): PaneStatePayload {
  return { paneId, workspaceId: "w1", tabId: "t1", agentStatus: "idle", cards: [], pendingInteraction: null, rawScreen: screen, revision };
}
const welcome = (buildId = "build_a") =>
  handleServerMessage({
    type: "welcome",
    replyTo: "h1",
    payload: { protocolVersion: "1.0.0", serverVersion: "0.1.0", buildId, deviceId: "d", clientConfig: {} as any, recipes: {} },
  });

describe("daemon rebuilds (protocol.md §3.2)", () => {
  test("a welcome with the page's own build offers no update; a different build does", () => {
    setState("updateAvailable", false);
    welcome("build_a"); // the page's first welcome names the bundle it was loaded with
    welcome("build_a"); // reconnect to a restarted daemon with the same build
    expect(state.updateAvailable).toBe(false);
    welcome("build_b"); // the daemon was rebuilt
    expect(state.updateAvailable).toBe(true);
  });
});

describe("reconnecting (protocol.md §2.2)", () => {
  test("a pairing check that cannot reach the daemon is retried 3 seconds later", async () => {
    const original = globalThis.fetch;
    let checks = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request)?.url ?? "";
      if (url.includes("/api/auth/status")) {
        checks++;
        if (checks === 1) throw new TypeError("Failed to fetch"); // daemon restarting
        return Response.json({ authenticated: false }); // not paired: ends the loop without a socket
      }
      return original(input, init);
    }) as unknown as typeof fetch;
    try {
      await initWebSocket();
      expect(checks).toBe(1);
      const start = Date.now();
      while (checks < 2 && Date.now() - start < 4500) {
        await Bun.sleep(100);
      }
      expect(checks).toBe(2);
      expect(state.paired).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  }, 6000);
});

describe("client pane state (protocol.md §5.4)", () => {
  test("an older or replayed revision is dropped", () => {
    selectPane("p1");
    handleServerMessage({ type: "pane_state", payload: paneState("p1", 5, "new") });
    handleServerMessage({ type: "pane_state", payload: paneState("p1", 4, "old") });
    handleServerMessage({ type: "pane_state", payload: paneState("p1", 5, "replay") });
    expect(state.rawScreen).toBe("new");
  });

  test("returning to a pane shows its cached state even though the revision did not change (§3.3)", () => {
    selectPane("a");
    handleServerMessage({ type: "pane_state", payload: paneState("a", 7, "screen A") });
    selectPane("b");
    expect(state.rawScreen).toBe("");
    selectPane("a");
    handleServerMessage({ type: "pane_state", payload: paneState("a", 7, "screen A") });
    expect(state.rawScreen).toBe("screen A");
  });

  test("after a daemon restart, lower revisions from the new server are accepted", () => {
    selectPane("r");
    handleServerMessage({ type: "pane_state", payload: paneState("r", 40, "before restart") });
    welcome();
    handleServerMessage({ type: "pane_state", payload: paneState("r", 1, "after restart") });
    expect(state.rawScreen).toBe("after restart");
  });
});

describe("client config versions (protocol.md §6.3)", () => {
  test("a late, older config broadcast is ignored", () => {
    welcome();
    handleServerMessage({ type: "config_updated", payload: { version: 3, client: { themeMode: "dark", accent: "green" } } });
    handleServerMessage({ type: "config_updated", payload: { version: 2, client: { themeMode: "dark", accent: "pink" } } });
    expect(state.accent).toBe("green");
  });

  test("after a daemon restart, the new server's low versions are accepted", () => {
    handleServerMessage({ type: "config_updated", payload: { version: 9, client: { themeMode: "dark", accent: "orange" } } });
    welcome();
    handleServerMessage({ type: "config_updated", payload: { version: 2, client: { themeMode: "dark", accent: "purple" } } });
    expect(state.accent).toBe("purple");
  });
});

describe("queue and session info (protocol.md §5.6, §5.8)", () => {
  test("the viewed pane's queue is shown; another pane's is ignored", () => {
    selectPane("q1");
    handleServerMessage({ type: "prompt_queue", payload: { paneId: "q1", items: [{ queueId: "q_a", text: "later", attachments: [], createdAt: 1 }] } });
    handleServerMessage({ type: "prompt_queue", payload: { paneId: "other", items: [] } });
    expect(state.queue.map((i) => i.text)).toEqual(["later"]);
    selectPane("q2");
    expect(state.queue).toEqual([]);
  });

  test("todos and the session's model come with the turns", () => {
    selectPane("t1");
    handleServerMessage({
      type: "normalized_turns",
      payload: { paneId: "t1", turns: [], todos: [{ text: "Ship", status: "pending" }], session: { bound: true, agent: "claude", sessionId: "s", model: { value: "opus", source: "launch" }, thinking: { value: null, source: "unknown" } } },
    });
    expect(state.todos).toEqual([{ text: "Ship", status: "pending" }]);
    expect(state.session?.model).toEqual({ value: "opus", source: "launch" });
  });
});

describe("unread marks (mobile-ui-and-themes.md §2.1, issue #3)", () => {
  test("viewing a pane clears its unread mark", () => {
    setUnread("u1", true);
    expect(state.unread.u1).toBe(true);
    selectPane("u1");
    expect("u1" in state.unread).toBe(false);
  });

  test("a closed pane's unread mark is dropped", () => {
    setUnread("gone", true);
    handleServerMessage({ type: "snapshot_update", payload: { workspaces: [], workingAgents: [] } } as any);
    expect("gone" in state.unread).toBe(false);
  });
});

describe("pane loading and screen card fallback (mobile-ui-and-themes.md §3.6)", () => {
  test("paneLoaded is false on selectPane and becomes true when pane_state arrives", () => {
    selectPane("p_load");
    expect(state.paneLoaded).toBe(false);
    expect(state.cards).toHaveLength(0);

    // Initial pane_state arrives with no cards (unbound session, empty cards)
    handleServerMessage({ type: "pane_state", payload: paneState("p_load", 1, "raw screen output") });
    expect(state.paneLoaded).toBe(true);
    expect(state.cards).toHaveLength(0);
    expect(state.session?.bound).toBeFalsy();
  });

  test("normalized_turns alone leaves paneLoaded false until pane_state arrives", () => {
    selectPane("p_norm");
    expect(state.paneLoaded).toBe(false);

    handleServerMessage({
      type: "normalized_turns",
      payload: {
        paneId: "p_norm",
        turns: [],
        session: { bound: false, agent: "claude", model: { value: null, source: "unknown" }, thinking: { value: null, source: "unknown" } },
      },
    });
    expect(state.paneLoaded).toBe(false);

    handleServerMessage({ type: "pane_state", payload: paneState("p_norm", 1, "raw screen output") });
    expect(state.paneLoaded).toBe(true);
  });
});
