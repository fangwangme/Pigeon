import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrSnapshotResult } from "../../src/types/herdr";

/** A fresh directory under $TMPDIR (the only writable temp location in sandboxed runs). */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pigeon-${prefix}-`));
}

export interface HerdrCall {
  method: string;
  params: Record<string, any>;
}

type Handler = (params: Record<string, any>) => { result?: any; error?: { code: string; message: string } } | undefined;

/**
 * A stand-in for the Herdr Unix socket: newline-delimited JSON requests, one response each.
 * `events.subscribe` connections are kept open and never answered with data.
 */
export class FakeHerdr {
  public calls: HerdrCall[] = [];
  public handlers: Record<string, Handler> = { "session.snapshot": () => ({ result: snapshotOf([]) }) };
  private server: Server;
  private sockets = new Set<Socket>();

  constructor(public socketPath: string) {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => undefined); // the client destroys sockets after each answer
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const req = JSON.parse(line);
          this.calls.push({ method: req.method, params: req.params || {} });
          if (req.method === "events.subscribe") continue;
          const res = this.handlers[req.method]?.(req.params || {}) ?? { result: {} };
          socket.write(JSON.stringify({ id: req.id, ...res }) + "\n");
        }
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socketPath, resolve));
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  callsOf(method: string): HerdrCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

export interface FakePane {
  paneId: string;
  agent?: string | null;
  status?: string;
  cwd?: string;
  session?: { agent: string; value: string };
}

/** A `session.snapshot` result with one workspace and one tab holding the given panes. */
export function snapshotOf(panes: FakePane[]): HerdrSnapshotResult {
  return {
    snapshot: {
      version: "0.9.5",
      protocol: 22,
      focused_pane_id: panes[0]?.paneId ?? null,
      workspaces: [
        { workspace_id: "w1", number: 1, label: "proj", focused: true, pane_count: panes.length, tab_count: 1, active_tab_id: "t1", agent_status: "idle" },
      ],
      tabs: [{ tab_id: "t1", workspace_id: "w1", number: 1, label: "1", focused: true, pane_count: panes.length, agent_status: "idle" }],
      panes: panes.map((p) => ({
        pane_id: p.paneId,
        workspace_id: "w1",
        tab_id: "t1",
        focused: false,
        agent: p.agent ?? null,
        agent_status: (p.status as any) || "idle",
        cwd: p.cwd ?? "/work",
        agent_session: p.session ? { source: "herdr", agent: p.session.agent, kind: "id", value: p.session.value } : null,
        revision: 1,
      })),
      agents: panes
        .filter((p) => p.agent)
        .map((p) => ({
          pane_id: p.paneId,
          workspace_id: "w1",
          tab_id: "t1",
          agent: p.agent,
          name: p.agent,
          agent_status: (p.status as any) || "idle",
          cwd: p.cwd ?? "/work",
        })),
    },
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
