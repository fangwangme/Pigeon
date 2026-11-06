import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const ID_RE = /^up_[0-9a-f]{16}$/;

export interface UploadInfo {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** Absolute path on this computer. */
  path: string;
}

/** Keeps only `[A-Za-z0-9._-]`, without a leading dot (`protocol.md` §7). */
export function safeUploadName(original: string): string {
  const name = original.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return name || "file";
}

/** Phone attachments stored under `<stateDir>/uploads` (`protocol.md` §7). */
export class UploadStore {
  private known = new Map<string, UploadInfo>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(dir)) {
      const path = join(dir, f);
      const st = statSync(path);
      if (Date.now() - st.mtimeMs > MAX_AGE_MS) {
        rmSync(path, { force: true });
        continue;
      }
      const m = /^(up_[0-9a-f]{16})-(.+)$/.exec(f);
      if (m) this.known.set(m[1], { id: m[1], name: m[2], size: st.size, mime: "application/octet-stream", path });
    }
  }

  /** Callers have validated name and size at the HTTP boundary. */
  public save(file: { name: string; mime: string; bytes: Uint8Array }): UploadInfo {
    const id = `up_${randomBytes(8).toString("hex")}`;
    const name = safeUploadName(file.name);
    const path = join(this.dir, `${id}-${name}`);
    writeFileSync(path, file.bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
    const info = { id, name, size: file.bytes.length, mime: file.mime || "application/octet-stream", path };
    this.known.set(id, info);
    return info;
  }

  public get(id: string): UploadInfo | null {
    if (!ID_RE.test(id)) return null;
    const info = this.known.get(id);
    return info && existsSync(info.path) ? info : null;
  }
}
