import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Isolate HOME / XDG / CODEX_HOME / HERDR_APP_HOME for every test process.
const origHome = process.env.HOME;
const bunBinDir = process.execPath ? dirname(process.execPath) : "";
const testHome = mkdtempSync(join(tmpdir(), "pigeon-test-home-"));
const stubBin = join(testHome, "stub-bin");
mkdirSync(stubBin, { recursive: true, mode: 0o700 });
for (const cli of ["claude", "codex", "opencode", "agy", "pi"]) {
  const stub = join(stubBin, cli);
  writeFileSync(stub, "#!/bin/sh\nexit 127\n", "utf-8");
  chmodSync(stub, 0o755);
}
if (process.env.PATH) {
  const parts = process.env.PATH.split(":").filter((p) => {
    if (!p) return false;
    if (bunBinDir && p === bunBinDir) return true;
    return !origHome || (p !== origHome && !p.startsWith(origHome + "/"));
  });
  process.env.PATH = [stubBin, ...parts].join(":");
} else {
  process.env.PATH = stubBin;
}

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
