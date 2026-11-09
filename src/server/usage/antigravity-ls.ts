import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveAntigravityModel } from "./model-id";

export interface AntigravityLsConnection {
  address: string;
  port: number;
  csrfToken?: string;
  runtimeKind: "desktop" | "ide" | "cli";
  pid?: number;
}

/** Check if address is strictly loopback (127.0.0.1, localhost, [::1]) per security §6. */
export function isLoopbackAddress(address: string): boolean {
  if (!address) return false;
  const trimmed = address.trim().replace(/^https?:\/\//i, "");
  const host = trimmed.includes(":") ? trimmed.slice(0, trimmed.lastIndexOf(":")) : trimmed;
  const cleanHost = host.replace(/^\[|\]$/g, "");
  return cleanHost === "127.0.0.1" || cleanHost === "localhost" || cleanHost === "::1";
}

/** Extract host & port from address string. */
export function parseLsAddress(addr: string): { host: string; port: number } | null {
  if (!addr) return null;
  const clean = addr.trim().replace(/^https?:\/\//i, "");
  const lastColon = clean.lastIndexOf(":");
  if (lastColon === -1) return null;
  const host = clean.slice(0, lastColon).replace(/^\[|\]$/g, "");
  const port = parseInt(clean.slice(lastColon + 1), 10);
  if (isNaN(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/** Parse Linux /proc environ buffer into CSRF token and LS address. */
export function parseProcEnviron(bytes: Uint8Array): { csrfToken?: string; lsAddress?: string } {
  let csrfToken: string | undefined;
  let lsAddress: string | undefined;
  const text = Buffer.from(bytes).toString("utf-8");
  const entries = text.split("\0");
  for (const entry of entries) {
    if (entry.startsWith("ANTIGRAVITY_CSRF_TOKEN=")) {
      csrfToken = entry.slice("ANTIGRAVITY_CSRF_TOKEN=".length).trim();
    } else if (entry.startsWith("ANTIGRAVITY_LS_ADDRESS=")) {
      lsAddress = entry.slice("ANTIGRAVITY_LS_ADDRESS=".length).trim();
    }
  }
  return { csrfToken: csrfToken || undefined, lsAddress: lsAddress || undefined };
}

/**
 * Automatically discovers the local Antigravity Language Server on loopback,
 * prioritizing Desktop over IDE and CLI.
 */
export async function discoverAntigravityLs(envOverride?: {
  address?: string;
  csrfToken?: string;
}): Promise<AntigravityLsConnection | null> {
  const envAddr = envOverride?.address || process.env.ANTIGRAVITY_LS_ADDRESS;
  const envCsrf = envOverride?.csrfToken || process.env.ANTIGRAVITY_CSRF_TOKEN;

  if (envAddr) {
    const parsed = parseLsAddress(envAddr);
    if (!parsed || !isLoopbackAddress(parsed.host)) {
      console.warn(`[Pigeon] Refusing non-loopback Antigravity LS address: ${envAddr}`);
      return null;
    }
    return {
      address: `${parsed.host}:${parsed.port}`,
      port: parsed.port,
      csrfToken: envCsrf,
      runtimeKind: "desktop",
    };
  }

  // Fast process discovery using ps
  const candidates: Array<{
    pid: number;
    address: string;
    port: number;
    csrfToken?: string;
    runtimeKind: "desktop" | "ide" | "cli";
  }> = [];

  try {
    const proc = Bun.spawn(["ps", "-eo", "pid,args"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const lines = output.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (!lower.includes("antigravity") && !lower.includes("language_server") && !lower.includes("agy")) {
        continue;
      }
      if (lower.includes("--type=renderer") || lower.includes("--type=gpu-process")) {
        continue;
      }

      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) continue;
      const pidStr = trimmed.slice(0, spaceIdx).trim();
      const pid = parseInt(pidStr, 10);
      if (isNaN(pid)) continue;
      const cmdline = trimmed.slice(spaceIdx + 1).trim();

      let runtimeKind: "desktop" | "ide" | "cli" = "desktop";
      if (lower.includes("antigravity-cli") || lower.includes("agy")) {
        runtimeKind = "cli";
      } else if (lower.includes("antigravity-ide")) {
        runtimeKind = "ide";
      } else if (lower.includes("antigravity")) {
        runtimeKind = "desktop";
      }

      let csrfToken: string | undefined;
      let lsAddress: string | undefined;

      // Check environ on Linux for this specific PID
      try {
        if (existsSync(`/proc/${pid}/environ`)) {
          const environBuf = readFileSync(`/proc/${pid}/environ`);
          const envTokens = parseProcEnviron(environBuf);
          csrfToken = envTokens.csrfToken;
          lsAddress = envTokens.lsAddress;
        }
      } catch {}

      // Check cmdline arguments
      const parts = cmdline.split(/\s+/);
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "--csrf_token" && parts[i + 1]) {
          csrfToken = parts[i + 1];
        } else if ((parts[i] === "--extension_server_port" || parts[i] === "--port") && parts[i + 1]) {
          const p = parseInt(parts[i + 1], 10);
          if (!isNaN(p) && p > 0) lsAddress = `127.0.0.1:${p}`;
        }
      }

      if (lsAddress) {
        const parsed = parseLsAddress(lsAddress);
        if (parsed && isLoopbackAddress(parsed.host)) {
          candidates.push({
            pid,
            address: `127.0.0.1:${parsed.port}`,
            port: parsed.port,
            csrfToken,
            runtimeKind,
          });
        }
      }
    }
  } catch {}

  if (candidates.length === 0) return null;

  // Prioritize desktop > ide > cli, then newest PID
  const priorityOrder: Record<string, number> = { desktop: 3, ide: 2, cli: 1 };
  candidates.sort((a, b) => {
    const diff = priorityOrder[b.runtimeKind] - priorityOrder[a.runtimeKind];
    if (diff !== 0) return diff;
    return b.pid - a.pid;
  });

  // Probe candidates with a short heartbeat to ensure it's responsive
  for (const c of candidates) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      };
      if (c.csrfToken) headers["X-Codeium-Csrf-Token"] = c.csrfToken;

      const res = await fetch(`http://${c.address}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          metadata: { ideName: "antigravity", extensionName: "antigravity", ideVersion: "unknown", locale: "en" },
        }),
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        return c;
      }
    } catch {}
  }

  return candidates[0] || null;
}

/**
 * Initializes Pigeon's native Antigravity cache database.
 */
export function initAntigravityCacheDb(dbPath: string): Database {
  const dir = dbPath.slice(0, dbPath.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 3000;");

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      client TEXT NOT NULL,
      last_modified_ms INTEGER,
      step_count INTEGER
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS session_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      client TEXT NOT NULL,
      model_enum TEXT,
      served_model TEXT,
      model_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      response_id TEXT,
      step_index INTEGER
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_session_usage_session ON session_usage(session_id);`);
  return db;
}

/**
 * Pulls Desktop/IDE sessions over Language Server RPC and stores them in Pigeon's own cache.
 */
export async function syncAntigravityDesktopSessions(
  conn: AntigravityLsConnection,
  cacheDbPath: string,
  homeDir: string = process.env.HOME || "."
): Promise<number> {
  if (!isLoopbackAddress(conn.address)) {
    console.warn(`[Pigeon] Skipping non-loopback Antigravity LS sync: ${conn.address}`);
    return 0;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
  };
  if (conn.csrfToken) headers["X-Codeium-Csrf-Token"] = conn.csrfToken;

  // 1. Query GetAllCascadeTrajectories
  let trajectoryEntries: Array<{ sessionId: string; stepCount?: number }> = [];
  try {
    const res = await fetch(`http://${conn.address}/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as any;
    const summaries = data?.trajectorySummaries || data?.cascadeTrajectories || data;
    if (Array.isArray(summaries)) {
      for (const item of summaries) {
        if (item?.cascadeId) trajectoryEntries.push({ sessionId: item.cascadeId, stepCount: item.stepCount });
      }
    } else if (typeof summaries === "object" && summaries !== null) {
      for (const [k, v] of Object.entries(summaries)) {
        trajectoryEntries.push({ sessionId: k, stepCount: (v as any)?.stepCount });
      }
    }
  } catch {
    return 0;
  }

  if (trajectoryEntries.length === 0) return 0;

  // Check which local files correspond to .pb or .db
  const candidateDirs = [
    join(homeDir, ".gemini", "antigravity", "conversations"),
    join(homeDir, ".gemini", "antigravity-ide", "conversations"),
  ];

  const fileMtimes = new Map<string, number>();
  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        if (!f.endsWith(".pb") && !f.endsWith(".db")) continue;
        const stem = f.replace(/\.(pb|db)$/, "");
        try {
          const st = statSync(join(dir, f));
          fileMtimes.set(stem, Math.floor(st.mtimeMs));
        } catch {}
      }
    } catch {}
  }

  // 2. Open / initialize native cache
  const db = initAntigravityCacheDb(cacheDbPath);
  let synced = 0;

  try {
    const cachedRows = db.query(`SELECT session_id, last_modified_ms, step_count FROM sessions`).all() as any[];
    const cachedMap = new Map<string, { lastMod?: number; stepCount?: number }>();
    for (const r of cachedRows) {
      cachedMap.set(r.session_id, { lastMod: r.last_modified_ms, stepCount: r.step_count });
    }

    const insertUsage = db.prepare(`
      INSERT OR REPLACE INTO session_usage (
        id, session_id, client, model_enum, served_model, model_id,
        timestamp, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        response_id, step_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const upsertSession = db.prepare(`
      INSERT OR REPLACE INTO sessions (session_id, client, last_modified_ms, step_count)
      VALUES (?, ?, ?, ?)
    `);

    for (const entry of trajectoryEntries) {
      const sId = entry.sessionId;
      const fileMtime = fileMtimes.get(sId) || Date.now();
      const existing = cachedMap.get(sId);

      // Skip if already cached and file has not changed
      if (existing && existing.lastMod === fileMtime && (entry.stepCount === undefined || existing.stepCount === entry.stepCount)) {
        continue;
      }

      // 3. Query GetCascadeTrajectoryGeneratorMetadata
      try {
        const metaRes = await fetch(
          `http://${conn.address}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ cascadeId: sId }),
            signal: AbortSignal.timeout(10000),
          }
        );
        if (!metaRes.ok) continue;
        const metaData = (await metaRes.json()) as any;
        const generatorMetadata = metaData?.generatorMetadata || [];

        db.run("BEGIN TRANSACTION;");
        db.run(`DELETE FROM session_usage WHERE session_id = ?`, [sId]);

        for (let stepIdx = 0; stepIdx < generatorMetadata.length; stepIdx++) {
          const meta = generatorMetadata[stepIdx];
          const chatModel = meta?.chatModel || meta || {};
          const modelEnum = chatModel.model;
          const servedModel = chatModel.responseModel;
          const displayName = chatModel.modelDisplayName;
          const resolved = resolveAntigravityModel(modelEnum, servedModel || displayName);

          let createdAt = fileMtime;
          const createdRaw = chatModel.chatStartMetadata?.createdAt;
          if (createdRaw) {
            const parsed = typeof createdRaw === "number" ? createdRaw : Date.parse(createdRaw);
            if (!isNaN(parsed) && parsed > 0) createdAt = parsed;
          }

          const retryInfos = chatModel.retryInfos || [];
          for (const retry of retryInfos) {
            const usage = retry.usage || retry || {};
            const inp = usage.inputTokens || 0;
            const out = usage.outputTokens || 0;
            const cr = usage.cacheReadTokens || 0;
            const cw = usage.cacheWriteTokens || 0;
            if (inp + out + cr + cw <= 0) continue;

            const ts = usage.timestamp ? (usage.timestamp > 1e11 ? usage.timestamp : usage.timestamp * 1000) : createdAt;
            const respId = usage.responseId || retry.responseId;
            const usageId = respId ? `${sId}:${respId}` : `${sId}:${stepIdx}:${ts}`;

            insertUsage.run(
              usageId,
              sId,
              conn.runtimeKind,
              modelEnum || null,
              servedModel || null,
              resolved.modelId,
              ts,
              inp,
              out,
              cr,
              cw,
              respId || null,
              stepIdx
            );
          }
        }

        upsertSession.run(sId, conn.runtimeKind, fileMtime, entry.stepCount || generatorMetadata.length);
        db.run("COMMIT;");
        synced++;
      } catch {
        db.run("ROLLBACK;");
      }
    }
  } finally {
    db.close();
  }

  return synced;
}
