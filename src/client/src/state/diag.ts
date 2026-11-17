import type { DiagEvent } from "../../../types/protocol";
import { readPref, writePref } from "./store";

// protocol.md §2.3: the phone's bounded record of connection events, kept across reloads.
// It holds times, outcomes and close codes only; it is sent only to a daemon in debug mode.

const KEY = "pigeon_conn_events";
const MAX_EVENTS = 300;

type Stored = DiagEvent & { n: number };
interface ConnRecord {
  seq: number;
  sent: number;
  events: Stored[];
}

function load(): ConnRecord {
  const raw = readPref(KEY);
  if (raw) {
    try {
      const r = JSON.parse(raw);
      if (r && Array.isArray(r.events) && typeof r.seq === "number" && typeof r.sent === "number") return r;
    } catch {
      // a corrupt record is replaced by a fresh one
    }
  }
  return { seq: 0, sent: 0, events: [] };
}

export function recordConn(ev: string, fields: Record<string, string | number | boolean> = {}): void {
  const r = load();
  r.seq += 1;
  r.events.push({ ...fields, t: Date.now(), ev, n: r.seq });
  if (r.events.length > MAX_EVENTS) r.events.splice(0, r.events.length - MAX_EVENTS);
  writePref(KEY, JSON.stringify(r));
}

/** The events not sent yet, and the mark to pass to `markSent` once they went out. */
export function unsentConn(): { events: DiagEvent[]; upTo: number } {
  const r = load();
  const pending = r.events.filter((e) => e.n > r.sent);
  return { events: pending, upTo: pending.length ? pending[pending.length - 1].n : r.sent };
}

export function markConnSent(upTo: number): void {
  const r = load();
  r.sent = Math.max(r.sent, upTo);
  writePref(KEY, JSON.stringify(r));
}
