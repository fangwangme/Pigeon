import { describe, expect, test } from "bun:test";
import { handleServerMessage, initWebSocket, selectPane } from "../src/client/src/state/ws";
import { setState, state } from "../src/client/src/state/store";
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
    globalThis.fetch = (async () => {
      checks++;
      if (checks === 1) throw new TypeError("Failed to fetch"); // daemon restarting
      return Response.json({ authenticated: false }); // not paired: ends the loop without a socket
    }) as unknown as typeof fetch;
    try {
      await initWebSocket();
      expect(checks).toBe(1);
      await Bun.sleep(3200);
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
    handleServerMessage({ type: "config_updated", payload: { version: 3, client: { showMacroDock: false } as any } });
    handleServerMessage({ type: "config_updated", payload: { version: 2, client: { showMacroDock: true } as any } });
    expect(state.showMacroDock).toBe(false);
  });

  test("after a daemon restart, the new server's low versions are accepted", () => {
    handleServerMessage({ type: "config_updated", payload: { version: 9, client: { showScrollControls: false } as any } });
    welcome();
    handleServerMessage({ type: "config_updated", payload: { version: 2, client: { showScrollControls: true } as any } });
    expect(state.showScrollControls).toBe(true);
  });
});
