import type { ClientMessage, ClientConfig, MacroItem } from "../types/protocol";

// Runtime validation for frames from the phone — the network trust boundary (architecture.md §5).
// Every handler in ws-server.ts can rely on the shapes checked here.

export type ValidationResult =
  | { ok: true; msg: ClientMessage }
  | { ok: false; id?: string; error: string };

const MAX_TEXT = 100_000;
const MAX_KEYS = 16;
const KEY_RE = /^[a-z0-9+_-]{1,24}$/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (v: unknown, max = 512) => v === undefined || isStr(v, max);

function fail(id: unknown, error: string): ValidationResult {
  return { ok: false, id: typeof id === "string" ? id : undefined, error };
}

export function validateClientMessage(raw: unknown): ValidationResult {
  if (!isObj(raw) || typeof raw.type !== "string") return fail(undefined, "Message must be an object with a string 'type'");
  const { id, type } = raw;
  const p = raw.payload;
  const needsId = type !== "ping" && type !== "presence_update";
  if (needsId && !isStr(id, 128)) return fail(id, `'${type}' requires a string 'id'`);
  const ok = (): ValidationResult => ({ ok: true, msg: raw as unknown as ClientMessage });

  switch (type) {
    case "hello":
      if (!isObj(p) || !isStr(p.protocolVersion, 32) || !optStr(p.subscribePaneId)) return fail(id, "hello needs payload.protocolVersion");
      return ok();
    case "ping":
      return ok();
    case "presence_update":
      if (typeof raw.isVisible !== "boolean" || !(raw.viewingPaneId === null || isStr(raw.viewingPaneId))) {
        return fail(id, "presence_update needs isVisible and viewingPaneId");
      }
      return ok();
    case "select_view":
      if (!isObj(p) || !isStr(p.paneId)) return fail(id, "select_view needs payload.paneId");
      return ok();
    case "agent_prompt":
      if (!isObj(p) || !isStr(p.targetPaneId) || !isStr(p.text, MAX_TEXT) || !p.text.trim()) {
        return fail(id, "agent_prompt needs payload.targetPaneId and non-empty payload.text");
      }
      return ok();
    case "agent_send_keys":
      if (!isObj(p) || !isStr(p.targetPaneId) || !Array.isArray(p.keys) || p.keys.length === 0 || p.keys.length > MAX_KEYS || !p.keys.every((k) => typeof k === "string" && KEY_RE.test(k))) {
        return fail(id, "agent_send_keys needs payload.targetPaneId and 1–16 key names");
      }
      return ok();
    case "interaction_respond":
      if (!isObj(p) || !isStr(p.targetPaneId) || !isStr(p.interactionId) || !isStr(p.optionId) || !isStr(p.fingerprint)) {
        return fail(id, "interaction_respond needs targetPaneId, interactionId, optionId and fingerprint");
      }
      return ok();
    case "create_tab_and_agent":
      if (!isObj(p) || !isStr(p.workspaceId) || !isStr(p.agentKind, 32) || !optStr(p.modelId, 128) || !optStr(p.thinking, 32) || !optStr(p.cwd, 4096)) {
        return fail(id, "create_tab_and_agent needs workspaceId and agentKind");
      }
      if (typeof p.cwd === "string" && !p.cwd.startsWith("/")) return fail(id, "cwd must be an absolute path");
      return ok();
    case "close_tab":
      if (!isObj(p) || !isStr(p.tabId)) return fail(id, "close_tab needs payload.tabId");
      return ok();
    case "skills_get":
    case "config_get":
      return ok();
    case "config_patch": {
      if (!isObj(p) || !isObj(p.client)) return fail(id, "config_patch needs payload.client");
      const err = validateClientConfigPatch(p.client);
      return err ? fail(id, err) : ok();
    }
    default:
      return fail(id, `Unsupported message type '${type}'`);
  }
}

const CONFIG_CHECKS: Record<keyof ClientConfig, (v: unknown) => boolean> = {
  themeKey: (v) => isStr(v, 64),
  themeMode: (v) => v === "system" || v === "light" || v === "dark",
  themeId: (v) => isStr(v, 64),
  confirmCtrlC: (v) => typeof v === "boolean",
  defaultView: (v) => isStr(v, 32),
  macros: (v) => Array.isArray(v) && v.length <= 50 && v.every(isMacro),
  displayDensity: (v) => v === "compact" || v === "aggregated" || v === "detailed",
  showScrollControls: (v) => typeof v === "boolean",
  showMacroDock: (v) => typeof v === "boolean",
};

function isMacro(v: unknown): v is MacroItem {
  return (
    isObj(v) &&
    isStr(v.id, 64) &&
    isStr(v.name, 64) &&
    (v.type === "text" || v.type === "key") &&
    isStr(v.payload, 4096) &&
    (v.type === "text" || KEY_RE.test(v.payload as string)) &&
    (v.confirm === undefined || typeof v.confirm === "boolean")
  );
}

/** Returns an error message, or null when every key is known and well-typed. */
export function validateClientConfigPatch(patch: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(patch)) {
    const check = CONFIG_CHECKS[key as keyof ClientConfig];
    if (!check) return `Unknown client config key '${key}'`;
    if (!check(value)) return `Invalid value for client config '${key}'`;
  }
  return null;
}
