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

export type DiscoveredLsCandidate = AntigravityLsConnection;

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
 * Discovers language server hub JSON files written by running Antigravity processes in ~/.gemini/* /daemon/.
 */
export function discoverDaemonHubFiles(homeDir: string): DiscoveredLsCandidate[] {
  const candidates: DiscoveredLsCandidate[] = [];
  const dirs: Array<{ dir: string; runtimeKind: "desktop" | "ide" | "cli" }> = [
    { dir: join(homeDir, ".gemini", "antigravity", "daemon"), runtimeKind: "desktop" },
    { dir: join(homeDir, ".gemini", "antigravity-ide", "daemon"), runtimeKind: "ide" },
    { dir: join(homeDir, ".gemini", "antigravity-cli", "daemon"), runtimeKind: "cli" },
  ];

  for (const { dir, runtimeKind } of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = readFileSync(join(dir, file), "utf-8");
          const data = JSON.parse(raw);
          const port = data.httpPort || data.port;
          const pid = data.pid;
          if (port && typeof port === "number" && port > 0 && port <= 65535) {
            let isAlive = true;
            if (typeof pid === "number" && pid > 0) {
              try {
                process.kill(pid, 0);
              } catch {
                isAlive = false;
              }
            }
            if (isAlive) {
              candidates.push({
                pid: pid || 0,
                address: `127.0.0.1:${port}`,
                port,
                csrfToken: data.csrfToken,
                runtimeKind,
              });
            }
          }
        } catch {}
      }
    } catch {}
  }
  return candidates;
}

/**
 * Pure function to extract LS candidates from `ps -eo pid,args` output lines.
 */
export function parseProcessListCandidates(lines: string[]): DiscoveredLsCandidate[] {
  const candidates: DiscoveredLsCandidate[] = [];
  const validBinaries = new Set(["language_server", "antigravity", "agy"]);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (!lower.includes("antigravity") && !lower.includes("language_server") && !lower.includes("agy")) {
      continue;
    }
    if (lower.includes("--type=renderer") || lower.includes("--type=gpu-process") || lower.includes("--type=zygote") || lower.includes("--type=utility")) {
      continue;
    }

    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) continue;
    const pidStr = trimmed.slice(0, spaceIdx).trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) continue;
    const cmdline = trimmed.slice(spaceIdx + 1).trim();

    // Check executable binary name
    const rawExe = cmdline.split(/\s+/)[0];
    const exeName = rawExe.split("/").pop()?.toLowerCase() || "";
    if (!validBinaries.has(exeName) && !exeName.endsWith("language_server") && !exeName.endsWith("antigravity") && !exeName.endsWith("agy")) {
      continue;
    }

    let runtimeKind: "desktop" | "ide" | "cli" = "desktop";
    if (lower.includes("antigravity-cli") || lower.includes("/agy") || lower.includes("--app_data_dir antigravity-cli")) {
      runtimeKind = "cli";
    } else if (lower.includes("antigravity-ide") || lower.includes("--app_data_dir antigravity-ide")) {
      runtimeKind = "ide";
    } else if (lower.includes("/opt/antigravity") || lower.includes("antigravity.app") || lower.includes("--app_data_dir antigravity")) {
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
  return candidates;
}

export interface DiscoverLsOptions {
  homeDir?: string;
  address?: string;
  csrfToken?: string;
}

/**
 * Automatically discovers the local Antigravity Language Server on loopback,
 * prioritizing Desktop over IDE and CLI.
 */
export async function discoverAntigravityLs(
  optionsOrHome?: string | DiscoverLsOptions,
  envOverride?: {
    address?: string;
    csrfToken?: string;
  }
): Promise<AntigravityLsConnection | null> {
  let homeDir = process.env.HOME || "";
  let explicitAddr: string | undefined;
  let explicitCsrf: string | undefined;

  if (typeof optionsOrHome === "string") {
    homeDir = optionsOrHome;
    if (envOverride?.address) explicitAddr = envOverride.address;
    if (envOverride?.csrfToken) explicitCsrf = envOverride.csrfToken;
  } else if (typeof optionsOrHome === "object" && optionsOrHome !== null) {
    if (optionsOrHome.homeDir) homeDir = optionsOrHome.homeDir;
    if (optionsOrHome.address) explicitAddr = optionsOrHome.address;
    if (optionsOrHome.csrfToken) explicitCsrf = optionsOrHome.csrfToken;
  }

  // Explicit address passed directly in options/tests
  if (explicitAddr) {
    const parsed = parseLsAddress(explicitAddr);
    if (!parsed || !isLoopbackAddress(parsed.host)) {
      console.warn(`[Pigeon] Refusing non-loopback Antigravity LS address: ${explicitAddr}`);
      return null;
    }
    return {
      address: `${parsed.host}:${parsed.port}`,
      port: parsed.port,
      csrfToken: explicitCsrf,
      runtimeKind: "desktop",
    };
  }

  const candidates: DiscoveredLsCandidate[] = [];

  // 1. Check daemon hub JSON files
  candidates.push(...discoverDaemonHubFiles(homeDir));

  // 2. Check running processes
  try {
    const proc = Bun.spawn(["ps", "-eo", "pid,args"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    candidates.push(...parseProcessListCandidates(output.split("\n")));
  } catch {}

  // 3. Fallback: CLI environment variable
  const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (envAddr) {
    const parsed = parseLsAddress(envAddr);
    if (parsed && isLoopbackAddress(parsed.host)) {
      candidates.push({
        pid: 0,
        address: `${parsed.host}:${parsed.port}`,
        port: parsed.port,
        csrfToken: envCsrf,
        runtimeKind: "cli",
      });
    }
  }

  if (candidates.length === 0) return null;

  // Prioritize desktop > ide > cli, then newest PID
  const priorityOrder: Record<string, number> = { desktop: 3, ide: 2, cli: 1 };
  candidates.sort((a, b) => {
    const diff = priorityOrder[b.runtimeKind] - priorityOrder[a.runtimeKind];
    if (diff !== 0) return diff;
    return (b.pid || 0) - (a.pid || 0);
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

  return null;
}

/**
 * Initializes Pigeon's native Antigravity cache database.
 */
export function initAntigravityCacheDb(dbPath: string): Database {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath);
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("PRAGMA journal_mode = WAL;");

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      client TEXT,
      last_modified_ms INTEGER,
      step_count INTEGER
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS session_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      client TEXT,
      model_enum TEXT,
      served_model TEXT,
      model_id TEXT,
      timestamp INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      response_id TEXT,
      step_index INTEGER DEFAULT 0
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_session_usage_session ON session_usage(session_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_session_usage_ts ON session_usage(timestamp);`);
  return db;
}

/**
 * Syncs Desktop .pb session token usage from Antigravity Language Server RPC
 * into Pigeon's native SQLite cache.
 */
export async function syncAntigravityDesktopSessions(
  conn: AntigravityLsConnection,
  cacheDbPath: string,
  homeDir = process.env.HOME || ""
): Promise<number> {
  if (!isLoopbackAddress(conn.address)) {
    console.warn(`[Pigeon] Refusing to sync Antigravity sessions from non-loopback address: ${conn.address}`);
    return 0;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
  };
  if (conn.csrfToken) {
    headers["X-Codeium-Csrf-Token"] = conn.csrfToken;
  }

  // 1. Scan candidate dirs strictly for .pb files
  const candidateDirs = [
    join(homeDir, ".gemini", "antigravity", "conversations"),
    join(homeDir, ".gemini", "antigravity-ide", "conversations"),
  ];

  const fileMtimes = new Map<string, number>();
  const pbSessionIds = new Set<string>();

  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        if (!f.endsWith(".pb")) continue;
        const stem = f.slice(0, -3);
        try {
          const st = statSync(join(dir, f));
          fileMtimes.set(stem, Math.floor(st.mtimeMs));
          pbSessionIds.add(stem);
        } catch {}
      }
    } catch {}
  }

  if (pbSessionIds.size === 0) return 0;

  // Query GetAllCascadeTrajectories
  const trajectoryEntries = new Map<string, number | undefined>();
  try {
    const res = await fetch(`http://${conn.address}/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      const summaries = data?.trajectorySummaries || data?.cascadeTrajectories || data;
      if (Array.isArray(summaries)) {
        for (const item of summaries) {
          if (item?.cascadeId) trajectoryEntries.set(item.cascadeId, item.stepCount);
        }
      } else if (typeof summaries === "object" && summaries !== null) {
        for (const [k, v] of Object.entries(summaries)) {
          trajectoryEntries.set(k, (v as any)?.stepCount);
        }
      }
    }
  } catch {}

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

    // Sync only sessions whose .pb file exists on disk
    for (const sId of pbSessionIds) {
      const fileMtime = fileMtimes.get(sId);
      if (!fileMtime) continue;

      const stepCount = trajectoryEntries.get(sId);
      const existing = cachedMap.get(sId);

      // Skip if already cached and file has not changed
      if (existing && existing.lastMod === fileMtime && (stepCount === undefined || existing.stepCount === stepCount)) {
        continue;
      }

      // 3. Query GetCascadeTrajectoryGeneratorMetadata
      let inTx = false;
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
        inTx = true;
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

        upsertSession.run(sId, conn.runtimeKind, fileMtime, stepCount || generatorMetadata.length);
        db.run("COMMIT;");
        inTx = false;
        synced++;
      } catch (err) {
        if (inTx) {
          try {
            db.run("ROLLBACK;");
          } catch {}
        }
      }
    }
  } finally {
    db.close();
  }

  return synced;
}
