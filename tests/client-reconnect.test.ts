import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { handleServerMessage, handleVisibilityChange, initWebSocket } from "../src/client/src/state/ws";
import { setState, state } from "../src/client/src/state/store";
import type { PaneStatePayload } from "../src/types/protocol";

// Issue #29. protocol.md §2.1 (wakeup), §2.2 (reconnect timing, one attempt, attempt timeouts), §3.3 (requestedPaneId, Syncing).

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
  onerror: ((e: any) => void) | null = null;
  constructor(public url: string) {
    sockets.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closeCalled = true;
    if (this.readyState === 0) {
      // A browser fails a connection that is still being set up and reports the close.
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code: 1006, reason: "" }));
    } else if (this.readyState === 1) {
      // A dead link: the closing handshake never completes, so no close event comes.
      this.readyState = 2;
    }
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

let sockets: FakeSocket[] = [];
const saved: Record<string, any> = {};
const g = globalThis as any;
const last = () => sockets[sockets.length - 1];

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function paneState(paneId: string, revision: number, screen: string): PaneStatePayload {
  return { paneId, workspaceId: "w1", tabId: "t1", agentStatus: "idle", cards: [], pendingInteraction: null, rawScreen: screen, revision };
}

const unboundSession = { bound: false, agent: "claude", model: { value: null, source: "unknown" }, thinking: { value: null, source: "unknown" } };

beforeEach(() => {
  jest.useFakeTimers();
  sockets = [];
  for (const key of ["WebSocket", "fetch", "window", "document"]) saved[key] = g[key];
  g.WebSocket = FakeSocket;
  g.fetch = async () => Response.json({ authenticated: true });
  g.window = { location: { protocol: "http:", host: "localhost", hash: "" }, addEventListener() {}, history: { replaceState() {} } };
  g.document = { visibilityState: "visible", addEventListener() {} };
});

afterEach(async () => {
  await flush();
  // 4409 is a final close: it stops this test's reconnects before the next test starts.
  for (const s of sockets) if (s.readyState !== 3) s.drop(4409);
  last()?.drop(4409);
  await flush();
  for (const key of Object.keys(saved)) g[key] = saved[key];
  jest.useRealTimers();
});

describe("wakeup probe (protocol.md §2.1)", () => {
  test("on visible with an open socket a ping goes out at once; a pong within 3 s keeps the socket, no pong opens a new one", async () => {
    await initWebSocket();
    const first = last();
    first.open();
    first.sent.length = 0;

    handleVisibilityChange();
    expect(first.sent.filter((m) => m.type === "ping").length).toBe(1);
    jest.advanceTimersByTime(1_000);
    handleServerMessage({ type: "pong", timestamp: Date.now() } as any);
    jest.advanceTimersByTime(3_000);
    await flush();
    expect(sockets.length).toBe(1);
    expect(first.closeCalled).toBe(false);

    handleVisibilityChange();
    expect(first.sent.filter((m) => m.type === "ping").length).toBe(2);
    expect(sockets.length).toBe(1);
    jest.advanceTimersByTime(3_000);
    await flush();
    expect(sockets.length).toBe(2);
  });
});

describe("reconnect timing (protocol.md §2.2)", () => {
  test("the first reconnect after a non-final close starts at once; the next waits 3 s; an open resets it", async () => {
    await initWebSocket();
    last().open();

    last().drop(1006);
    await flush();
    expect(sockets.length).toBe(2);

    last().drop(1006); // that attempt failed before opening
    await flush();
    expect(sockets.length).toBe(2);
    jest.advanceTimersByTime(2_999);
    await flush();
    expect(sockets.length).toBe(2);
    jest.advanceTimersByTime(1);
    await flush();
    expect(sockets.length).toBe(3);

    last().open();
    last().drop(1006);
    await flush();
    expect(sockets.length).toBe(4);
  });

  test("two overlapping connect calls open one socket", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    g.fetch = async () => {
      await gate;
      return Response.json({ authenticated: true });
    };
    const a = initWebSocket();
    const b = initWebSocket();
    release();
    await Promise.all([a, b]);
    await flush();
    expect(sockets.length).toBe(1);
  });

  test("a socket still CONNECTING after 10 s is closed and a new attempt follows", async () => {
    await initWebSocket();
    const stuck = last();

    jest.advanceTimersByTime(9_999);
    await flush();
    expect(stuck.closeCalled).toBe(false);
    expect(sockets.length).toBe(1);

    jest.advanceTimersByTime(1);
    await flush();
    expect(stuck.closeCalled).toBe(true);

    jest.advanceTimersByTime(3_000);
    await flush();
    expect(sockets.length).toBe(2);
  });
});

describe("Syncing and substituted panes (protocol.md §3.3)", () => {
  test("a close before the bootstrap arrives clears Syncing", async () => {
    setState({
      activePaneId: "w1:p_sync",
      session: { bound: true, agent: "claude", sessionId: "s_sync", model: { value: null, source: "unknown" }, thinking: { value: null, source: "unknown" } } as any,
    });
    setState("normalizedTurns", [{ role: "user", text: "a" } as any, { role: "assistant", text: "b" } as any]);
    await initWebSocket();
    last().open();
    expect(state.paneSyncing).toBe(true);

    last().drop(1006);
    expect(state.paneSyncing).toBe(false);
  });

  test("a bootstrap with requestedPaneId for the viewed pane switches to the substituted pane; another pane's is still ignored", () => {
    setState({ activePaneId: "w1:p_gone", paneSyncing: true });

    handleServerMessage({
      type: "pane_bootstrap",
      payload: {
        paneId: "w1:p_focus",
        requestedPaneId: "w1:p_gone",
        turns: { paneId: "w1:p_focus", seq: 1, turns: [], session: unboundSession },
        resume: null,
        queue: [],
        state: paneState("w1:p_focus", 1, "focused screen"),
        serverMs: 1,
      },
    } as any);
    expect(state.activePaneId).toBe("w1:p_focus");
    expect(state.paneSyncing).toBe(false);
    expect(state.rawScreen).toBe("focused screen");

    handleServerMessage({
      type: "pane_bootstrap",
      payload: {
        paneId: "w1:p_other",
        turns: { paneId: "w1:p_other", seq: 1, turns: [], session: unboundSession },
        resume: null,
        queue: [],
        state: paneState("w1:p_other", 1, "other screen"),
        serverMs: 1,
      },
    } as any);
    expect(state.activePaneId).toBe("w1:p_focus");
    expect(state.rawScreen).toBe("focused screen");
  });
});
