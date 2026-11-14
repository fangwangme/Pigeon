// Issue #13 & #23. quota-and-usage.md §2.3, security-and-pairing.md §6: read-only credential helpers.
import { existsSync, readFileSync } from "node:fs";

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Where an agent keeps its credential: a file, or (Claude on macOS) the Keychain (read-only). */
export interface CredentialSource {
  /** The stored credential as text, or null when there is none. */
  read(): string | null;
}

export function fileCredentialSource(path: string): CredentialSource {
  return {
    read: () => (existsSync(path) ? readFileSync(path, "utf-8") : null),
  };
}

/** Read-only macOS Keychain source for Claude Code credentials. */
export function macKeychainSource(): CredentialSource {
  return {
    read: () => {
      const res = Bun.spawnSync(["security", "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"]);
      return res.exitCode === 0 ? res.stdout.toString().trim() || null : null;
    },
  };
}

/** The payload of a JWT, or null when the token is not one. */
export function decodeJwtPayload(token: string): any {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
  } catch {
    return null;
  }
}
