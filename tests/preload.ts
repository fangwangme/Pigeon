import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate HOME / XDG / CODEX_HOME / HERDR_APP_HOME for every test process.
const testHome = mkdtempSync(join(tmpdir(), "pigeon-test-home-"));
const dataHome = join(testHome, ".local", "share");
const configHome = join(testHome, ".config");
const stateHome = join(testHome, ".local", "state");
const cacheHome = join(testHome, ".cache");
const runtimeDir = join(testHome, "run");

mkdirSync(dataHome, { recursive: true, mode: 0o700 });
mkdirSync(configHome, { recursive: true, mode: 0o700 });
mkdirSync(stateHome, { recursive: true, mode: 0o700 });
mkdirSync(cacheHome, { recursive: true, mode: 0o700 });
mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

process.env.HOME = testHome;
process.env.XDG_DATA_HOME = dataHome;
process.env.XDG_CONFIG_HOME = configHome;
process.env.XDG_STATE_HOME = stateHome;
process.env.XDG_CACHE_HOME = cacheHome;
process.env.XDG_RUNTIME_DIR = runtimeDir;
process.env.CODEX_HOME = join(testHome, ".codex");
process.env.HERDR_APP_HOME = join(configHome, "herdr-app");

process.once("exit", () => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {}
});

// Block unexpected outbound network calls while allowing loopback mock servers and relative URLs.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const rawFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(urlStr)) {
    const parsed = new URL(urlStr);
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new Error(`Blocked unexpected outbound fetch in tests: ${urlStr}`);
    }
  }
  return rawFetch(input, init);
}) as typeof fetch;
