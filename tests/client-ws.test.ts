import { describe, expect, jest, test } from "bun:test";
import { handleServerMessage, handleVisibilityChange, initWebSocket, request, selectPane } from "../src/client/src/state/ws";
import { setState, setUnread, state } from "../src/client/src/state/store";
import { dropCachedShell } from "../src/client/src/state/shell";
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

  test("a page that carries its own build id compares it with the first welcome", () => {
    const origDoc = (globalThis as any).document;
    const meta = { content: "build_page", getAttribute: (n: string) => (n === "content" ? "build_page" : null) };
    (globalThis as any).document = {
      visibilityState: "visible",
      addEventListener() {},
      documentElement: { setAttribute() {}, style: { setProperty() {} } },
      querySelector: (sel: string) => (sel.includes("pigeon-build") ? meta : null),
    };
    try {
      setState("updateAvailable", false);
      welcome("build_page"); // the daemon serves the build this page was loaded with
      expect(state.updateAvailable).toBe(false);
      welcome("build_newer"); // a cached shell older than the daemon's client
      expect(state.updateAvailable).toBe(true);
    } finally {
      (globalThis as any).document = origDoc;
    }
  });
});

describe("update reload (architecture.md §4.1)", () => {
  test("dropping the cached shell removes it from every cache and keeps the other entries", async () => {
    const stores = new Map<string, Map<string, string>>([
      ["pigeon-cache-v4", new Map([["/", "old shell"], ["/icon.svg", "icon"]])],
      ["pigeon-settings", new Map([["/__locale", "zh"]])],
    ]);
    const origCaches = (globalThis as any).caches;
    (globalThis as any).caches = {
      keys: async () => [...stores.keys()],
      open: async (name: string) => ({ delete: async (key: string) => stores.get(name)!.delete(key) }),
    };
    try {
      await dropCachedShell();
      expect(stores.get("pigeon-cache-v4")!.has("/")).toBe(false);
      expect(stores.get("pigeon-cache-v4")!.has("/icon.svg")).toBe(true);
      expect(stores.get("pigeon-settings")!.get("/__locale")).toBe("zh");
    } finally {
      (globalThis as any).caches = origCaches;
    }
  });
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

describe("prompt answers (mobile-ui-and-themes.md §4.1)", () => {
  test("an ack with approved: false keeps the card and never opens the terminal view", () => {
    setState("pendingInteraction", { id: "c1", kind: "interaction", interactionId: "int_1", title: "", question: "Proceed?", payload: "", fingerprint: "fp_1", options: [], fallbackKeys: [] } as any);
    setState("terminalOpen", false);
    handleServerMessage({ type: "ack", replyTo: "x1", payload: { approved: false, interactionId: "int_1" } } as any);
    expect(state.terminalOpen).toBe(false);
    expect(state.pendingInteraction?.interactionId).toBe("int_1");
  });
});

describe("socket teardown on resume (protocol.md §2.2)", () => {
  test("a closed socket found on resume rejects its pending requests before reconnecting", async () => {
    const origWs = globalThis.WebSocket;
    const origDoc = (globalThis as any).document;
    const origWindow = (globalThis as any).window;
    const origFetch = globalThis.fetch;
    let fakeClientWs: any;

    (globalThis as any).document = { visibilityState: "visible" };
    (globalThis as any).window = { location: { protocol: "http:", host: "localhost", hash: "" } };
    (globalThis as any).fetch = (async () => Response.json({ authenticated: true })) as any;
    (globalThis as any).WebSocket = class {
      readyState = 1;
      onopen: any;
      onclose: any;
      onmessage: any;
      constructor() {
        fakeClientWs = this;
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {}
    };

    try {
      await initWebSocket();
      const pending = request({ type: "refresh_models", payload: {} } as any);
      fakeClientWs.readyState = 3; // CLOSED
      handleVisibilityChange();
      await expect(pending).rejects.toThrow();
      await Bun.sleep(20); // the reconnect it started finishes before the stubs go
      fakeClientWs.readyState = 3; // and its socket does not outlive the test
    } finally {
      globalThis.WebSocket = origWs;
      (globalThis as any).document = origDoc;
      (globalThis as any).window = origWindow;
      globalThis.fetch = origFetch;
    }
  });
});

describe("heartbeat (protocol.md §2.1)", () => {
  test("sends a ping every 5 s and reconnects only after no pong arrives for more than 15 s", async () => {
    const origWs = globalThis.WebSocket;
    const origDoc = (globalThis as any).document;
    const origWindow = (globalThis as any).window;
    const origFetch = globalThis.fetch;
    const sockets: any[] = [];

    class FakeSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      sent: any[] = [];
      closeCalled = false;
      onopen: ((e: any) => void) | null = null;
      onclose: ((e: any) => void) | null = null;
      onmessage: ((e: any) => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      send(text: string) {
        this.sent.push(JSON.parse(text));
      }
      close() {
        this.closeCalled = true;
        if (this.readyState === 1) this.readyState = 2;
      }
      open() {
        this.readyState = 1;
        this.onopen?.({});
      }
      drop(code = 1006) {
        this.readyState = 3;
        this.onclose?.({ code, reason: "" });
      }
    }

    jest.useFakeTimers();
    (globalThis as any).document = { visibilityState: "visible" };
    (globalThis as any).window = { location: { protocol: "http:", host: "localhost", hash: "" } };
    (globalThis as any).fetch = (async () => Response.json({ authenticated: true })) as any;
    (globalThis as any).WebSocket = FakeSocket as any;

    const flush = async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve();
    };

    try {
      await initWebSocket();
      const first = sockets[sockets.length - 1];
      first.open();
      first.sent.length = 0;

      jest.advanceTimersByTime(5_000);
      await flush();
      expect(first.sent.filter((m: any) => m.type === "ping").length).toBe(1);
      expect(sockets.length).toBe(1);

      jest.advanceTimersByTime(5_000);
      await flush();
      expect(first.sent.filter((m: any) => m.type === "ping").length).toBe(2);
      expect(sockets.length).toBe(1);

      jest.advanceTimersByTime(5_000); // 15 s without a pong: still within the timeout
      await flush();
      expect(first.sent.filter((m: any) => m.type === "ping").length).toBe(3);
      expect(first.closeCalled).toBe(false);
      expect(sockets.length).toBe(1);

      jest.advanceTimersByTime(5_000);
      await flush();
      expect(first.closeCalled).toBe(true);
      expect(sockets.length).toBe(2);
    } finally {
      await flush();
      for (const s of sockets) if (s.readyState !== 3) s.drop(4409);
      sockets[sockets.length - 1]?.drop(4409);
      await flush();
      jest.useRealTimers();
      globalThis.WebSocket = origWs;
      (globalThis as any).document = origDoc;
      (globalThis as any).window = origWindow;
      globalThis.fetch = origFetch;
    }
  });
});
