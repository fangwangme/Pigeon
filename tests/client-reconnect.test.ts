import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { handleOnline, handleServerMessage, handleVisibilityChange, initWebSocket } from "../src/client/src/state/ws";
import { setState, state } from "../src/client/src/state/store";
import type { PaneStatePayload } from "../src/types/protocol";

// protocol.md §2.1 (wakeup), §2.2 (socket first, retry schedule, one attempt, attempt timeouts),
// §2.3 (client_diag), §3.3 (requestedPaneId, Syncing).

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
let authChecks = 0;
let authAnswer: () => Promise<Response> = async () => Response.json({ authenticated: true });
const saved: Record<string, any> = {};
const g = globalThis as any;
const last = () => sockets[sockets.length - 1];

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function tick(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flush();
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

const welcome = (debug: boolean) =>
  handleServerMessage({
    type: "welcome",
    replyTo: "h1",
    payload: { protocolVersion: "1.0.0", serverVersion: "0.1.0", buildId: "build_r", debug, deviceId: "d", clientConfig: {} as any, recipes: {} },
  } as any);

function paneState(paneId: string, revision: number, screen: string): PaneStatePayload {
  return { paneId, workspaceId: "w1", tabId: "t1", agentStatus: "idle", cards: [], pendingInteraction: null, rawScreen: screen, revision };
}

const unboundSession = { bound: false, agent: "claude", model: { value: null, source: "unknown" }, thinking: { value: null, source: "unknown" } };

beforeEach(() => {
  jest.useFakeTimers();
  sockets = [];
  authChecks = 0;
  authAnswer = async () => Response.json({ authenticated: true });
  for (const key of ["WebSocket", "fetch", "window", "document", "localStorage"]) saved[key] = g[key];
  g.WebSocket = FakeSocket;
  g.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.includes("/api/auth/status")) {
      authChecks++;
      return authAnswer();
    }
    throw new TypeError(`unexpected fetch ${url}`);
  };
  g.window = { location: { protocol: "http:", host: "localhost", hash: "" }, addEventListener() {}, history: { replaceState() {} } };
  g.document = { visibilityState: "visible", addEventListener() {} };
  g.localStorage = memoryStorage();
  setState("paired", true);
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

describe("socket first (protocol.md §2.2)", () => {
  test("an attempt opens /ws without requesting /api/auth/status first", async () => {
    void initWebSocket();
    await flush();
    expect(sockets.length).toBe(1);
    expect(last().url).toBe("ws://localhost/ws");
    expect(authChecks).toBe(0);

    last().open();
    last().drop(1006); // a socket that had opened: no pairing check before the next attempt
    await tick(0);
    expect(authChecks).toBe(0);
    expect(sockets.length).toBe(2);
  });

  test("a socket that closes without opening is followed by the pairing check; not paired shows the guidance and stops", async () => {
    authAnswer = async () => Response.json({ authenticated: false });
    void initWebSocket();
    await flush();
    last().drop(1006); // e.g. the upgrade was refused with 401
    await flush();
    expect(authChecks).toBe(1);
    expect(state.paired).toBe(false);

    await tick(10_000);
    expect(sockets.length).toBe(1);
  });

  test("a pairing check that says paired, or cannot reach the daemon, leads to the next attempt", async () => {
    void initWebSocket();
    await flush();
    last().drop(1006);
    await tick(0);
    expect(authChecks).toBe(1);
    expect(state.paired).toBe(true);
    expect(sockets.length).toBe(2);

    authAnswer = async () => {
      throw new TypeError("Failed to fetch"); // daemon restarting
    };
    last().drop(1006);
    await tick(500);
    expect(authChecks).toBe(2);
    expect(sockets.length).toBe(3);
  });

  test("two overlapping connect calls open one socket", async () => {
    const a = initWebSocket();
    const b = initWebSocket();
    await Promise.all([a, b]);
    await flush();
    expect(sockets.length).toBe(1);
  });
});

describe("retry schedule (protocol.md §2.2)", () => {
  test("consecutive failed attempts wait 0, 0.5, 1, 2, then 3 s; an opened socket resets the schedule", async () => {
    void initWebSocket();
    await flush();
    last().open();

    const expectNextAfter = async (ms: number) => {
      const before = sockets.length;
      last().drop(1006);
      await flush();
      if (ms > 0) {
        await tick(ms - 1);
        expect(sockets.length).toBe(before);
        await tick(1);
      } else {
        await tick(0);
      }
      expect(sockets.length).toBe(before + 1);
    };

    await expectNextAfter(0); // the open socket's close
    await expectNextAfter(500); // that attempt failed before opening
    await expectNextAfter(1_000);
    await expectNextAfter(2_000);
    await expectNextAfter(3_000);
    await expectNextAfter(3_000);

    last().open();
    await expectNextAfter(0);
  });

  test("an online event during a wait starts an attempt at once", async () => {
    void initWebSocket();
    await flush();
    last().open();
    last().drop(1006);
    await tick(0);
    last().drop(1006);
    await tick(500);
    last().drop(1006);
    await flush(); // now waiting 1 s
    const before = sockets.length;

    handleOnline();
    await tick(0);
    expect(sockets.length).toBe(before + 1);
  });

  test("becoming visible during a wait starts an attempt at once", async () => {
    void initWebSocket();
    await flush();
    last().open();
    last().drop(1006);
    await tick(0);
    last().drop(1006);
    await tick(500);
    last().drop(1006);
    await flush(); // now waiting 1 s
    const before = sockets.length;

    handleVisibilityChange();
    await tick(0);
    expect(sockets.length).toBe(before + 1);
  });

  test("a socket still CONNECTING after 10 s is closed and a new attempt follows", async () => {
    void initWebSocket();
    await flush();
    const stuck = last();

    await tick(9_999);
    expect(stuck.closeCalled).toBe(false);
    expect(sockets.length).toBe(1);

    await tick(1);
    expect(stuck.closeCalled).toBe(true);
    await tick(0);
    expect(sockets.length).toBe(2);
  });
});

describe("debug mode (protocol.md §2.3)", () => {
  const diags = (s: FakeSocket) => s.sent.filter((m) => m.type === "client_diag");
  const key = (e: any) => JSON.stringify(e);

  test("a failed attempt before the connection opened is sent after a debug welcome, and nothing is sent twice", async () => {
    void initWebSocket();
    await flush();
    last().drop(1006); // fails before opening
    await tick(0);
    const second = last();
    second.open();
    welcome(true);
    await flush();
    const first = diags(second).flatMap((m) => m.payload.events);
    expect(first.length).toBeGreaterThan(0);
    expect(first.some((e: any) => e.code === 1006)).toBe(true);
    for (const e of first) {
      expect(typeof e.t).toBe("number");
      expect(typeof e.ev).toBe("string");
    }

    second.drop(1006);
    await tick(0);
    const third = last();
    third.open();
    welcome(true);
    await flush();
    const again = diags(third).flatMap((m) => m.payload.events);
    const sentBefore = new Set(first.map(key));
    expect(again.some((e: any) => sentBefore.has(key(e)))).toBe(false);
  });

  test("after a welcome without debug the client sends no client_diag", async () => {
    void initWebSocket();
    await flush();
    last().drop(1006);
    await tick(0);
    const s = last();
    s.open();
    welcome(false);
    await flush();
    expect(diags(s).length).toBe(0);
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
