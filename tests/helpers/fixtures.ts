import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrTopology } from "../../src/types/herdr";

/** A fresh directory under $TMPDIR (the only writable temp location in sandboxed runs). */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pigeon-${prefix}-`));
}

export interface HerdrCall {
  /** Core JSON-RPC method, App request (`ls`, `status`) or App command (`tab.new`). */
  method: string;
  params: Record<string, any>;
}

/**
 * `error` is a Core error kind on the Core socket and the error text on the App socket.
 * "no-reply" leaves the request unanswered, like a Herdr call still in progress.
 */
type Handler = (params: Record<string, any>) => { result?: any; error?: string } | "no-reply" | undefined;

/**
 * A stand-in for Herdr: the App window socket (`{"ls":{}}`, `{"do":…}` → result or
 * `{"error":"…"}`) and the Core socket (JSON-RPC 2.0). Core `events.subscribe` connections are
 * kept open and only receive what `emitEvent` sends.
 */
export class FakeHerdr {
  public calls: HerdrCall[] = [];
  public handlers: Record<string, Handler> = {};
  public readonly appSocketPath: string;
  public readonly coreSocketPath: string;
  private servers: Server[] = [];
  private sockets = new Set<Socket>();
  private subscribers = new Set<Socket>();

  constructor(dir: string) {
    this.appSocketPath = join(dir, "app.sock");
    this.coreSocketPath = join(dir, "core.sock");
    this.serve([]);
    this.servers.push(this.lineServer((socket, req) => this.answerApp(socket, req)));
    this.servers.push(this.lineServer((socket, req) => this.answerCore(socket, req)));
  }

  /** Answers `ls`, `status` and `terminal.list` with one space and one tab holding these panes. */
  serve(panes: FakePane[], options: TopologyOptions = {}): void {
    const topology = topologyOf(panes, options);
    this.handlers.ls = () => ({ result: topology.ls });
    this.handlers.status = () => ({ result: topology.status });
    this.handlers["terminal.list"] = () => ({ result: { terminals: topology.terminals, hidden_finished: 0, machines: [] } });
  }

  private lineServer(onRequest: (socket: Socket, req: any) => void): Server {
    return createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => {
        this.sockets.delete(socket);
        this.subscribers.delete(socket);
      });
      socket.on("error", () => undefined); // the client destroys sockets after each answer
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          onRequest(socket, JSON.parse(line));
        }
      });
    });
  }

  private answerApp(socket: Socket, req: any): void {
    const method = typeof req.do === "string" ? req.do : Object.keys(req)[0];
    const params = typeof req.do === "string" ? req.args || {} : req[method] || {};
    this.calls.push({ method, params });
    const res = this.handlers[method]?.(params) ?? { result: {} };
    if (res === "no-reply") return;
    socket.write(JSON.stringify(res.error !== undefined ? { error: res.error } : res.result) + "\n");
  }

  private answerCore(socket: Socket, req: any): void {
    this.calls.push({ method: req.method, params: req.params || {} });
    if (req.method === "events.subscribe") {
      this.subscribers.add(socket);
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { seq: 0, terminals: [] } }) + "\n");
      return;
    }
    const res = this.handlers[req.method]?.(req.params || {}) ?? { result: {} };
    if (res === "no-reply") return;
    const body =
      res.error !== undefined
        ? { error: { code: -32000, message: res.error, data: { kind: res.error } } }
        : { result: res.result };
    socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body }) + "\n");
  }

  async listen(): Promise<void> {
    await Promise.all(
      this.servers.map((s, i) => new Promise<void>((resolve) => s.listen(i === 0 ? this.appSocketPath : this.coreSocketPath, resolve)))
    );
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return Promise.all(this.servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))).then(() => undefined);
  }

  callsOf(method: string): HerdrCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Pushes a Core event notification to every open `events.subscribe` connection. */
  emitEvent(type: string, terminal: string, data: Record<string, any>): void {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, terminal, seq: 1, data } });
    for (const s of this.subscribers) s.write(line + "\n");
  }
}

export interface FakePane {
  /** Core terminal address, used as the pane id. */
  paneId: string;
  /** The status record's `app` (`claude-code`, `codex`, …); absent for a plain terminal. */
  app?: string;
  /** The status record's `state`; defaults to `idle` for an agent. */
  state?: string;
  cwd?: string;
  /** Foreground process id and name (`herdr-adapter.md` §3.1). */
  pid?: number;
  program?: string;
  /** Terminal creation time; defaults to one hour ago. */
  createdMs?: number;
}

export interface TopologyOptions {
  /** The space folder; defaults to `/work`. */
  folder?: string;
}

/** A topology with one space (`w1`, "proj") and one tab (`tab1`) holding the given panes. */
export function topologyOf(panes: FakePane[], options: TopologyOptions = {}): HerdrTopology {
  return {
    ls: {
      spaces: [
        {
          id: "w1",
          name: "proj",
          folder: options.folder ?? "/work",
          active: true,
          tabs: [{ id: "tab1", name: "1", active: true, terminals: panes.map((p) => ({ terminal: p.paneId, pane: `pane-${p.paneId}` })) }],
        },
      ],
    },
    status: { focused_pane: panes[0] ? `pane-${panes[0].paneId}` : null },
    terminals: panes.map((p) => ({
      address: p.paneId,
      cwd: "/launch",
      state: "live" as const,
      created_ms: p.createdMs ?? Date.now() - 3_600_000,
      foreground: { cwd: p.cwd ?? "/work", pid: p.pid ?? 0, name: p.program ?? (p.app ? p.app : "zsh"), argv: [] },
      status: p.app ? { state: p.state ?? "idle", app: p.app } : null,
      title: "",
    })),
  };
}

/** Records what the server sends to one WebSocket connection. */
export function fakeWs(deviceId = "dev_1", connectionId = `conn_${deviceId}`) {
  const sent: any[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  const ws: any = {
    data: { session: { deviceId, deviceName: "Phone", tokenHash: "h", createdAt: 0, lastUsedAt: 0 }, connectionId, subscribedPaneId: null, lastPingTime: Date.now() },
    send: (text: string) => sent.push(JSON.parse(text)),
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
  };
  return { ws, sent, closes, ofType: (type: string) => sent.filter((m) => m.type === type) };
}
