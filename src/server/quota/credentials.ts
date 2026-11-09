// Issue #13. quota-and-usage.md §2.3, security-and-pairing.md §6: shared credential handling of the quota providers.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where an agent keeps its credential: a file, or (Claude on macOS) the Keychain. */
export interface CredentialSource {
  /** The stored credential as text, or null when there is none. */
  read(): string | null;
  /** Replaces the stored credential. */
  write(raw: string): void;
}

export function fileCredentialSource(path: string): CredentialSource {
  return {
    read: () => (existsSync(path) ? readFileSync(path, "utf-8") : null),
    write: (raw) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, raw, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

/**
 * §2.3 write-conflict protection: writes the refreshed tokens only when the source still holds what was
 * read before the refresh. When the agent rotated it meanwhile, nothing is written and the agent's
 * credential is used. Returns the credential text to continue with.
 */
export function storeRefreshed(source: CredentialSource, readBefore: string, applyTokens: (credential: any) => void): string {
  const current = source.read();
  if (current !== readBefore) {
    if (current === null) throw new Error("credentials disappeared during the token refresh");
    return current;
  }
  const credential = JSON.parse(readBefore);
  applyTokens(credential);
  const next = JSON.stringify(credential, null, 2);
  source.write(next);
  return next;
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
