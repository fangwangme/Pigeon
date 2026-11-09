// Issue #13. quota-and-usage.md §3.1, §3.2. Agent session data scanners.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { formatYMD } from "../../shared/usage";
import { canonical, detectCompany, formatModelId, resolveAntigravityModel } from "./model-id";

/** quota-and-usage.md §3.1: records that could not be parsed, counted over one scan. */
export interface ScanStats {
  skipped: number;
}

export interface RawUsageRecord {
  agent: string;
  sessionId: string;
  messageKey: string;
  timestampMs: number;
  date: string; // YYYY-MM-DD
  rawModelId?: string;
  modelId: string;
  canonicalModelId: string;
  company: "anthropic" | "openai" | "google" | "other";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

function formatLocalDate(ms: number): string {
  return formatYMD(new Date(ms));
}

export function findFilesRecursive(dir: string, ext: string | string[]): string[] {
  const result: string[] = [];
  try {
    if (!existsSync(dir)) return result;
    const exts = Array.isArray(ext) ? ext : [ext];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...findFilesRecursive(full, ext));
      } else if (exts.some((e) => entry.name.endsWith(e))) {
        result.push(full);
      }
    }
  } catch {}
  return result;
}

// 1. Claude scanner
export function scanClaudeFile(path: string, stats: ScanStats = { skipped: 0 }): RawUsageRecord[] {
  const records = new Map<string, RawUsageRecord>();
  let content = "";
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      stats.skipped++;
      continue;
    }
    if (entry.type !== "assistant" && entry.entry_type !== "assistant") continue;
    const msg = entry.message;
    if (!msg || !msg.usage || !msg.model) continue;

    const u = msg.usage;
    const input = u.input_tokens || 0;
    const output = u.output_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    const cacheWrite = u.cache_creation_input_tokens || 0;
    const total = input + output + cacheRead + cacheWrite;
    if (total <= 0) continue;

    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();
    const date = formatLocalDate(ts);
    const key = msg.id && entry.request_id ? `${msg.id}:${entry.request_id}` : (msg.id ? String(msg.id) : `${path}:${i}`);
    const rawModel = String(msg.model);
    const canon = canonical(rawModel);

    records.set(key, {
      agent: "claude",
      sessionId: path.slice(path.lastIndexOf("/") + 1).replace(/\.jsonl$/, ""),
      messageKey: key,
      timestampMs: ts,
      date,
      rawModelId: rawModel,
      modelId: formatModelId(rawModel),
      canonicalModelId: canon,
      company: detectCompany(rawModel, "claude"),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: total,
    });
  }

  return Array.from(records.values());
}

// 2. Codex scanner
export function scanCodexFile(path: string, stats: ScanStats = { skipped: 0 }): RawUsageRecord[] {
  const records: RawUsageRecord[] = [];
  let content = "";
  try {
    if (path.endsWith(".zst")) {
      const proc = Bun.spawnSync(["zstd", "-dc", path]);
      if (proc.exitCode !== 0) return [];
      content = proc.stdout.toString();
    } else {
      content = readFileSync(path, "utf-8");
    }
  } catch {
    return [];
  }

  let currentModel = "gpt-4o";
  let previousTotals: any = null;
  let inheritsHistory = false;
  let turnStarted = false;
  let sessionId = path.slice(path.lastIndexOf("/") + 1).replace(/(\.jsonl|\.zst|\.jsonl\.zst)$/, "");

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let v: any;
    try {
      v = JSON.parse(line);
    } catch {
      stats.skipped++;
      continue;
    }

    const entryType = v.type;
    const payload = v.payload;

    if (entryType === "session_meta" && payload) {
      if (payload.id) sessionId = String(payload.id);
      if (payload.model) currentModel = String(payload.model);
      inheritsHistory = !!(payload.forked_from_id || payload.parent_thread_id || payload.source?.subagent);
      continue;
    }

    if (entryType === "turn_context") {
      turnStarted = true;
      if (payload?.model) currentModel = String(payload.model);
      continue;
    }

    if (entryType !== "event_msg" || payload?.type !== "token_count") continue;
    const info = payload?.info;
    if (!info) continue;

    if (info.model) currentModel = String(info.model);

    const parseUsage = (u: any) => {
      if (!u) return null;
      const rawInp = u.input_tokens || 0;
      const out = u.output_tokens || 0;
      const cr = u.cached_input_tokens || u.cache_read_input_tokens || 0;
      const cw = u.cache_creation_input_tokens || u.cache_write_input_tokens || 0;
      const inp = Math.max(0, rawInp - cr);
      const total = u.total_tokens || (inp + out + cr + cw);
      return { inp, out, cr, cw, total };
    };

    const lastUsage = parseUsage(info.last_token_usage);
    const totalUsage = parseUsage(info.total_token_usage);

    if (inheritsHistory && !turnStarted) {
      if (totalUsage && totalUsage.total > 0) previousTotals = totalUsage;
      continue;
    }

    const ts = v.timestamp ? Date.parse(v.timestamp) : (payload?.timestamp ? Date.parse(payload.timestamp) : Date.now());
    const date = formatLocalDate(ts);

    let usage: any = null;
    if (lastUsage && lastUsage.total > 0) {
      if (previousTotals && totalUsage) {
        if (totalUsage.total === previousTotals.total) continue;
        if (totalUsage.total < previousTotals.total && totalUsage.total + lastUsage.total >= previousTotals.total) continue;
      }
      if (totalUsage) previousTotals = totalUsage;
      usage = lastUsage;
    } else if (totalUsage && previousTotals) {
      const diffTotal = totalUsage.total - previousTotals.total;
      const diffInp = Math.max(0, totalUsage.inp - previousTotals.inp);
      const diffOut = Math.max(0, totalUsage.out - previousTotals.out);
      const diffCr = Math.max(0, totalUsage.cr - previousTotals.cr);
      previousTotals = totalUsage;
      if (diffTotal > 0) usage = { inp: diffInp, out: diffOut, cr: diffCr, cw: 0, total: diffTotal };
      else continue;
    } else if (totalUsage) {
      previousTotals = totalUsage;
      usage = totalUsage;
    } else {
      continue;
    }

    if (usage && usage.total > 0) {
      const key = `${sessionId}:${ts}:${i}`;
      records.push({
        agent: "codex",
        sessionId,
        messageKey: key,
        timestampMs: ts,
        date,
        rawModelId: currentModel,
        modelId: formatModelId(currentModel),
        canonicalModelId: canonical(currentModel),
        company: detectCompany(currentModel, "codex"),
        inputTokens: usage.inp,
        outputTokens: usage.out,
        cacheReadTokens: usage.cr,
        cacheWriteTokens: usage.cw,
        totalTokens: usage.total,
      });
    }
  }

  return records;
}

// 3. Antigravity scanner (protobuf wire decoder)
function readVarint(buf: Uint8Array, offset: number): [number, number] {
  let res = 0, shift = 0;
  while (offset < buf.length) {
    const b = buf[offset++];
    res += (b & 0x7f) * (2 ** shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [res, offset];
}

interface ProtoField {
  fieldNum: number;
  wireType: number;
  val?: number;
  data?: Uint8Array;
}

function parseProto(buf: Uint8Array): ProtoField[] {
  let offset = 0;
  const fields: ProtoField[] = [];
  while (offset < buf.length) {
    const [tag, nextOffset] = readVarint(buf, offset);
    offset = nextOffset;
    const wireType = tag & 0x07;
    const fieldNum = tag >>> 3;
    if (wireType === 0) {
      const [val, afterVal] = readVarint(buf, offset);
      offset = afterVal;
      fields.push({ fieldNum, wireType, val });
    } else if (wireType === 2) {
      const [len, afterLen] = readVarint(buf, offset);
      const data = buf.subarray(afterLen, afterLen + len);
      offset = afterLen + len;
      fields.push({ fieldNum, wireType, data });
    } else {
      break;
    }
  }
  return fields;
}

export function scanAntigravityDb(path: string): RawUsageRecord[] {
  const records: RawUsageRecord[] = [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    db.run("PRAGMA query_only = ON;");
    db.run("PRAGMA busy_timeout = 2000;");

    // Timestamps from steps
    const timestamps = new Map<string, number>();
    try {
      const stepRows: any[] = db.query("SELECT metadata FROM steps WHERE metadata IS NOT NULL").all();
      for (const r of stepRows) {
        if (!r.metadata) continue;
        const flds = parseProto(r.metadata);
        const uuidFld = flds.find((x) => x.fieldNum === 12);
        const tsFld = flds.find((x) => x.fieldNum === 1);
        if (uuidFld && tsFld && uuidFld.data && tsFld.data) {
          const uuid = Buffer.from(uuidFld.data).toString("utf-8");
          const tsSub = parseProto(tsFld.data);
          const sec = tsSub.find((x) => x.fieldNum === 1)?.val || 0;
          const nanos = tsSub.find((x) => x.fieldNum === 2)?.val || 0;
          if (sec > 0) timestamps.set(uuid, sec * 1000 + Math.floor(nanos / 1_000_000));
        }
      }
    } catch {}

    const sessionId = path.slice(path.lastIndexOf("/") + 1).replace(/\.db$/, "");

    // Gen metadata
    const genRows: any[] = db.query("SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx").all();
    for (const r of genRows) {
      if (!r.data) continue;
      const flds = parseProto(r.data);
      const uuidFld = flds.find((x) => x.fieldNum === 4);
      const payloadFld = flds.find((x) => x.fieldNum === 1);
      if (!payloadFld || !payloadFld.data) continue;

      const payloadSub = parseProto(payloadFld.data);
      const usageFld = payloadSub.find((x) => x.fieldNum === 4);
      if (!usageFld || !usageFld.data) continue;

      const usageSub = parseProto(usageFld.data);
      const inp = usageSub.find((x) => x.fieldNum === 2)?.val || 0;
      const totOut = usageSub.find((x) => x.fieldNum === 3)?.val || 0;
      if (totOut === 0) continue;
      const cr = usageSub.find((x) => x.fieldNum === 5)?.val || 0;
      const respOut = usageSub.find((x) => x.fieldNum === 10)?.val;
      const respIdFld = usageSub.find((x) => x.fieldNum === 11);
      const respId = respIdFld && respIdFld.data ? Buffer.from(respIdFld.data).toString("utf-8") : undefined;

      const servedModelFld = payloadSub.find((x) => x.fieldNum === 19);
      const servedModel = servedModelFld && servedModelFld.data ? Buffer.from(servedModelFld.data).toString("utf-8") : undefined;

      let modelEnum: string | undefined;
      const f20s = payloadSub.filter((x) => x.fieldNum === 20);
      for (const f of f20s) {
        if (!f.data) continue;
        const pair = parseProto(f.data);
        const k = pair.find((x) => x.fieldNum === 1);
        const v = pair.find((x) => x.fieldNum === 2);
        if (k?.data && Buffer.from(k.data).toString("utf-8") === "model_enum") {
          modelEnum = v?.data ? Buffer.from(v.data).toString("utf-8") : undefined;
          break;
        }
      }

      const resolved = resolveAntigravityModel(modelEnum, servedModel);

      const out = respOut !== undefined ? respOut : totOut;
      const total = inp + out + cr;

      const uuid = uuidFld && uuidFld.data ? Buffer.from(uuidFld.data).toString("utf-8") : null;
      const ts = uuid ? timestamps.get(uuid) : null;
      if (!ts) continue;

      const date = formatLocalDate(ts);
      const key = respId ? `${sessionId}:${respId}` : `${sessionId}:${r.idx}:${uuid || ts}`;

      records.push({
        agent: "agy",
        sessionId,
        messageKey: key,
        timestampMs: ts,
        date,
        rawModelId: resolved.rawModelId,
        modelId: resolved.modelId,
        canonicalModelId: resolved.canonicalModelId,
        company: detectCompany(resolved.modelId, "agy"),
        inputTokens: inp,
        outputTokens: out,
        cacheReadTokens: cr,
        cacheWriteTokens: 0,
        totalTokens: total,
      });
    }
  } catch {
  } finally {
    if (db) db.close();
  }

  return records;
}

// 4. Pigeon native Antigravity cache scanner (built from Language Server)
export function scanAntigravityCacheDb(path: string): RawUsageRecord[] {
  const records: RawUsageRecord[] = [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    db.run("PRAGMA query_only = ON;");
    db.run("PRAGMA busy_timeout = 2000;");

    const rows: any[] = db
      .query(`
        SELECT session_id, model_enum, served_model, model_id, timestamp,
               input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
               response_id, step_index, id
        FROM session_usage
      `)
      .all();

    for (const r of rows) {
      const resolved = resolveAntigravityModel(r.model_enum, r.served_model || r.model_id);
      const inp = r.input_tokens || 0;
      const out = r.output_tokens || 0;
      const cr = r.cache_read_tokens || 0;
      const cw = r.cache_write_tokens || 0;
      const total = inp + out + cr + cw;
      if (total <= 0) continue;

      const ts = r.timestamp ? (r.timestamp > 1e11 ? r.timestamp : r.timestamp * 1000) : Date.now();
      const date = formatLocalDate(ts);
      const key = r.response_id
        ? (r.response_id.startsWith(`${r.session_id}:`) ? r.response_id : `${r.session_id}:${r.response_id}`)
        : (r.id || `${r.session_id}:${r.step_index}:${ts}`);

      records.push({
        agent: "agy",
        sessionId: String(r.session_id),
        messageKey: key,
        timestampMs: ts,
        date,
        rawModelId: resolved.rawModelId,
        modelId: resolved.modelId,
        canonicalModelId: resolved.canonicalModelId,
        company: detectCompany(resolved.modelId, "agy"),
        inputTokens: inp,
        outputTokens: out,
        cacheReadTokens: cr,
        cacheWriteTokens: cw,
        totalTokens: total,
      });
    }
  } catch {
  } finally {
    if (db) db.close();
  }

  return records;
}

// 5. OpenCode scanner
export function scanOpenCodeDb(path: string, stats: ScanStats = { skipped: 0 }): RawUsageRecord[] {
  const records: RawUsageRecord[] = [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    db.run("PRAGMA query_only = ON;");
    db.run("PRAGMA busy_timeout = 2000;");

    const hasSessionMessage = (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message'").get() as any) !== undefined;
    const hasMessage = (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message'").get() as any) !== undefined;
    const tableName = hasSessionMessage ? "session_message" : (hasMessage ? "message" : null);
    if (!tableName) return [];

    const rows: any[] = db
      .query(`SELECT id, session_id, time_created, data FROM ${tableName} WHERE data IS NOT NULL`)
      .all();
    for (const r of rows) {
      if (!r.data) continue;
      let d: any;
      try {
        d = JSON.parse(r.data);
      } catch {
        stats.skipped++;
        continue;
      }
      const tokens = d.tokens || d.usage;
      if (!tokens) continue;

      const inp = tokens.input || tokens.input_tokens || 0;
      const out = tokens.output || tokens.output_tokens || 0;
      const cr = tokens.cache?.read || tokens.cache_read || 0;
      const cw = tokens.cache?.write || tokens.cache_write || 0;
      const total = inp + out + cr + cw;
      if (total <= 0) continue;

      const ts = r.time_created ? (r.time_created > 1e11 ? r.time_created : r.time_created * 1000) : Date.now();
      const date = formatLocalDate(ts);
      const rawModel = typeof d.model === "object" && d.model ? (d.model.id || d.model.name || "opencode") : (d.model || d.model_id || "opencode");
      const key = String(r.id || `${r.session_id}:${ts}`);

      records.push({
        agent: "opencode",
        sessionId: String(r.session_id || "unknown"),
        messageKey: key,
        timestampMs: ts,
        date,
        rawModelId: rawModel,
        modelId: formatModelId(rawModel),
        canonicalModelId: canonical(rawModel),
        company: detectCompany(rawModel, "opencode"),
        inputTokens: inp,
        outputTokens: out,
        cacheReadTokens: cr,
        cacheWriteTokens: cw,
        totalTokens: total,
      });
    }
  } catch {
  } finally {
    if (db) db.close();
  }

  return records;
}

// 6. Pi scanner
export function scanPiFile(path: string, stats: ScanStats = { skipped: 0 }): RawUsageRecord[] {
  const records: RawUsageRecord[] = [];
  let content = "";
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  let currentModel = "pi";
  let sessionId = path.slice(path.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      stats.skipped++;
      continue;
    }

    const type = entry.type || entry.entry_type;

    if (type === "session" || type === "header") {
      if (entry.session_id || entry.id) sessionId = String(entry.session_id || entry.id);
      if (entry.model || entry.model_id || entry.modelId) currentModel = String(entry.model || entry.model_id || entry.modelId);
      continue;
    }

    if (type === "model_change") {
      if (entry.model || entry.model_id || entry.modelId) currentModel = String(entry.model || entry.model_id || entry.modelId);
      continue;
    }

    if (type === "message" || type === "assistant") {
      const msg = entry.message;
      if (!msg || msg.role !== "assistant" || !msg.usage) continue;
      const u = msg.usage;
      const inp = u.input || u.input_tokens || 0;
      const out = u.output || u.output_tokens || 0;
      const cr = u.cacheRead || u.cache_read || 0;
      const cw = u.cacheWrite || u.cache_write || 0;
      const total = u.totalTokens || u.total_tokens || (inp + out + cr + cw);
      if (total <= 0) continue;

      const ts = entry.timestamp ? Date.parse(entry.timestamp) : (msg.timestamp || Date.now());
      const date = formatLocalDate(ts);
      const model = msg.model || currentModel;
      const key = `${sessionId}:${ts}:${i}`;

      records.push({
        agent: "pi",
        sessionId,
        messageKey: key,
        timestampMs: ts,
        date,
        rawModelId: model,
        modelId: formatModelId(model),
        canonicalModelId: canonical(model),
        company: detectCompany(model, "pi"),
        inputTokens: inp,
        outputTokens: out,
        cacheReadTokens: cr,
        cacheWriteTokens: cw,
        totalTokens: total,
      });
    }
  }

  return records;
}
