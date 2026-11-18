import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { handleOnline, handleServerMessage, handleVisibilityChange, initWebSocket, request } from "../src/client/src/state/ws";
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
    payload: { protocolVersion: "1.0.0", serverVersion: "0.1.0", buildId: "build_r", debug, deviceId: "d", clientConfig: { quotaEnabled: false } as any, recipes: {} },
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
  g.document = {
    visibilityState: "visible",
    addEventListener() {},
    documentElement: { setAttribute() {}, style: { setProperty() {} } },
    // protocol.md §3.2: the page carries its own build, so a welcome here never sets one for other files.
    querySelector: (sel: string) => (sel.includes("pigeon-build") ? { getAttribute: () => "build_r" } : null),
  };
  g.localStorage = memoryStorage();
  setState({ paired: true, quotaEnabled: false });
});

afterEach(async () => {
  await flush();
  // 4409 is a final close: it stops this test's reconnects before the next test starts.
  for (const s of sockets) if (s.readyState !== 3) s.drop(4409);
  last()?.drop(4409);
  await flush();
  for (const key of Object.keys(saved)) g[key] = saved[key];
  setState({
    activePaneId: null,
    session: null,
    normalizedTurns: [],
    rawScreen: "",
    paneSyncing: false,
  });
  jest.useRealTimers();
});

describe("wakeup probe (protocol.md §2.1)", () => {
  test("on visible with an open socket a ping goes out at once; a pong within 2 s keeps the socket, no pong opens a new one", async () => {
    await initWebSocket();
    const first = last();
    first.open();
    first.sent.length = 0;

    handleVisibilityChange();
    expect(first.sent.filter((m) => m.type === "ping").length).toBe(1);
    jest.advanceTimersByTime(1_000);
    handleServerMessage({ type: "pong", timestamp: Date.now() } as any);
    jest.advanceTimersByTime(2_000);
    await flush();
    expect(sockets.length).toBe(1);
    expect(first.closeCalled).toBe(false);

    handleVisibilityChange();
    expect(first.sent.filter((m) => m.type === "ping").length).toBe(2);
    expect(sockets.length).toBe(1);
    jest.advanceTimersByTime(2_000);
    await flush();
    expect(sockets.length).toBe(2);
  });

  test("periodic heartbeat check yields to an active 2 s wakeup probe after long sleep", async () => {
    await initWebSocket();
    const first = last();
    first.open();
    welcome(false);
    await flush();

    // Advance 19 s without pong (pingInterval at 5s/10s/15s each see <= 15s, next fires at 20s with 20s > 15s).
    g.document.visibilityState = "hidden";
    handleVisibilityChange();
    await tick(19_000);
    g.document.visibilityState = "visible";
    handleVisibilityChange();
    // At t=20s, periodic pingInterval ticks with lastPongTime 20s old — must wait for wakeup probe rather than closing early
    await tick(1_100);
    expect(first.closeCalled).toBe(false);
    expect(sockets.length).toBe(1);
    handleServerMessage({ type: "pong", timestamp: Date.now() } as any);
    await tick(1_500);
    expect(first.closeCalled).toBe(false);
    expect(sockets.length).toBe(1);
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

  test("a socket still CONNECTING after 2 s is closed and a new attempt follows", async () => {
    void initWebSocket();
    await flush();
    const stuck = last();

    await tick(1_999);
    expect(stuck.closeCalled).toBe(false);
    expect(sockets.length).toBe(1);

    await tick(1);
    expect(stuck.closeCalled).toBe(true);
    await tick(0);
    expect(sockets.length).toBe(2);
  });

  test("an online event or wake from hidden replaces a stale CONNECTING socket immediately", async () => {
    void initWebSocket();
    await flush();
    const first = last();
    expect(sockets.length).toBe(1);

    handleOnline();
    await flush();
    expect(first.closeCalled).toBe(true);
    expect(sockets.length).toBe(2);

    const second = last();
    g.document.visibilityState = "hidden";
    handleVisibilityChange();
    g.document.visibilityState = "visible";
    handleVisibilityChange();
    await flush();
    expect(second.closeCalled).toBe(true);
    expect(sockets.length).toBe(3);
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

  test("a heartbeat timeout on a debug connection is sent on the next connection, not onto the dead socket", async () => {
    void initWebSocket();
    await flush();
    const dead = last();
    dead.open();
    welcome(true);
    await flush();
    await tick(20_000); // no pong: the heartbeat gives the socket up
    expect(diags(dead).flatMap((m) => m.payload.events).some((e: any) => e.ev.includes("heartbeat"))).toBe(false);

    const next = last();
    expect(next).not.toBe(dead);
    next.open();
    welcome(true);
    await flush();
    expect(diags(next).flatMap((m) => m.payload.events).some((e: any) => e.ev.includes("heartbeat"))).toBe(true);
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

  test("failed offline or dropped RPC requests record rpc_error in client_diag without payload text", async () => {
    await expect(
      request({ type: "usage_model", payload: { model: "gemini-4-hydrogen", from: "2026-11-18", to: "2026-11-18", agents: ["agy"] } })
    ).rejects.toMatchObject({ code: "ERR_OFFLINE" });

    void initWebSocket();
    await flush();
    const first = last();
    first.open();
    welcome(true);
    await flush();

    const offlineEvs = diags(first).flatMap((m) => m.payload.events).filter((e: any) => e.ev === "rpc_error");
    expect(offlineEvs).toHaveLength(1);
    expect(offlineEvs[0]).toMatchObject({ ev: "rpc_error", cmd: "usage_model", code: "ERR_OFFLINE" });
    expect(JSON.stringify(offlineEvs[0])).not.toContain("gemini-4-hydrogen");

    const inFlight = request({ type: "usage_day", payload: { date: "2026-11-18", agents: ["agy"] } });
    await tick(120);
    first.drop(1006);
    await expect(inFlight).rejects.toMatchObject({ code: "ERR_OFFLINE" });

    await tick(0);
    const second = last();
    second.open();
    welcome(true);
    await flush();
    const dropEvs = diags(second).flatMap((m) => m.payload.events).filter((e: any) => e.ev === "rpc_error");
    expect(dropEvs).toHaveLength(1);
    expect(dropEvs[0]).toMatchObject({ ev: "rpc_error", cmd: "usage_day", code: "ERR_OFFLINE" });
    expect(dropEvs[0].ms).toBeGreaterThanOrEqual(120);
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
