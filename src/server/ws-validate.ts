import type { ClientMessage, ClientConfig } from "../types/protocol";
import { ACCENT_NAMES } from "../shared/defaults";

// Runtime validation for frames from the phone — the network trust boundary (architecture.md §5).
// Every handler in ws-server.ts can rely on the shapes checked here.

export type ValidationResult =
  | { ok: true; msg: ClientMessage }
  | { ok: false; id?: string; error: string };

const MAX_TEXT = 100_000;
const MAX_KEYS = 16;
const MAX_ATTACHMENTS = 10;
const RESUME_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
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
    case "agent_prompt": {
      if (!isObj(p) || !isStr(p.targetPaneId) || typeof p.text !== "string" || p.text.length > MAX_TEXT) {
        return fail(id, "agent_prompt needs payload.targetPaneId and payload.text");
      }
      const att = p.attachments;
      if (att !== undefined && !(Array.isArray(att) && att.length <= MAX_ATTACHMENTS && att.every((a) => isStr(a, 64)))) {
        return fail(id, "attachments must be at most 10 upload ids");
      }
      if (!p.text.trim() && !(Array.isArray(att) && att.length > 0)) return fail(id, "agent_prompt needs text or attachments");
      return ok();
    }
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
      if (!isObj(p) || !isStr(p.workspaceId) || !isStr(p.agentKind, 32) || !optStr(p.modelId, 128) || !optStr(p.thinking, 32) || !optStr(p.cwd, 4096) || !optStr(p.firstMessage, MAX_TEXT)) {
        return fail(id, "create_tab_and_agent needs workspaceId and agentKind");
      }
      if (typeof p.cwd === "string" && !p.cwd.startsWith("/")) return fail(id, "cwd must be an absolute path");
      if (p.resumeSessionId !== undefined && !(typeof p.resumeSessionId === "string" && RESUME_ID_RE.test(p.resumeSessionId))) {
        return fail(id, "resumeSessionId is malformed");
      }
      return ok();
    case "close_tab":
      if (!isObj(p) || !isStr(p.tabId)) return fail(id, "close_tab needs payload.tabId");
      return ok();
    case "agent_set_model":
      if (!isObj(p) || !isStr(p.targetPaneId) || !optStr(p.modelId, 128) || !optStr(p.thinking, 32) || (p.modelId === undefined && p.thinking === undefined)) {
        return fail(id, "agent_set_model needs targetPaneId and modelId or thinking");
      }
      return ok();
    case "sessions_list":
      if (!isObj(p) || !isStr(p.workspaceId) || !isStr(p.agentKind, 32)) return fail(id, "sessions_list needs workspaceId and agentKind");
      return ok();
    case "tab_rename":
      if (!isObj(p) || !isStr(p.tabId) || typeof p.name !== "string" || !p.name.trim() || p.name.trim().length > 80) {
        return fail(id, "tab_rename needs tabId and a name of 1–80 characters");
      }
      return ok();
    case "device_revoke":
      if (!isObj(p) || !isStr(p.deviceId, 128)) return fail(id, "device_revoke needs payload.deviceId");
      return ok();
    case "queue_cancel":
      if (!isObj(p) || !isStr(p.targetPaneId) || !isStr(p.queueId, 64)) return fail(id, "queue_cancel needs targetPaneId and queueId");
      return ok();
    case "queue_update":
      if (!isObj(p) || !isStr(p.targetPaneId) || !isStr(p.queueId, 64) || typeof p.text !== "string") {
        return fail(id, "queue_update needs targetPaneId, queueId and text");
      }
      if (p.attachments !== undefined && (!Array.isArray(p.attachments) || !p.attachments.every((a: unknown) => isStr(a, 64)))) {
        return fail(id, "queue_update attachments must be string[]");
      }
      return ok();
    case "models_refresh":
      if (!isObj(p)) return fail(id, "models_refresh needs a payload object");
      return ok();
    case "skills_get":
    case "config_get":
    case "devices_list":
      return ok();
    case "config_patch": {
      if (!isObj(p) || !isObj(p.client)) return fail(id, "config_patch needs payload.client");
      const err = validateClientConfigPatch(p.client);
      return err ? fail(id, err) : ok();
    }
    case "quota_get":
      if (p !== undefined && (!isObj(p) || (p.force !== undefined && typeof p.force !== "boolean"))) {
        return fail(id, "quota_get payload must be an object with optional boolean force");
      }
      return ok();
    case "usage_get": {
      if (!isObj(p)) return fail(id, "usage_get needs a payload object");
      const validPresets = new Set(["today", "7d", "30d", "year", "all", "custom"]);
      if (typeof p.preset !== "string" || !validPresets.has(p.preset)) {
        return fail(id, "usage_get needs a valid preset ('today', '7d', '30d', 'year', 'all', 'custom')");
      }
      if (p.preset === "custom") {
        if (!isDateStr(p.from) || !isDateStr(p.to)) {
          return fail(id, "usage_get custom preset requires 'from' and 'to' (YYYY-MM-DD)");
        }
      } else {
        if (p.from !== undefined || p.to !== undefined) {
          return fail(id, "usage_get fixed preset must not carry 'from' or 'to'");
        }
      }
      if (!isValidAgentList(p.agents)) {
        return fail(id, "usage_get needs a non-empty list of distinct valid agents");
      }
      return ok();
    }
    case "usage_day":
      if (!isObj(p) || !isDateStr(p.date) || !isValidAgentList(p.agents)) {
        return fail(id, "usage_day needs date (YYYY-MM-DD) and non-empty distinct valid agents");
      }
      return ok();
    case "usage_model":
      if (!isObj(p) || !isStr(p.model) || !isDateStr(p.from) || !isDateStr(p.to) || !isValidAgentList(p.agents)) {
        return fail(id, "usage_model needs model, from, to (YYYY-MM-DD) and non-empty distinct valid agents");
      }
      return ok();
    default:
      return fail(id, `Unsupported message type '${type}'`);
  }
}

const VALID_PROVIDERS = new Set(["claude", "codex", "antigravity"]);
const VALID_AGENT_KINDS = new Set(["claude", "codex", "agy", "opencode", "pi"]);

function isDateStr(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isValidAgentList(v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  const set = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string" || !VALID_AGENT_KINDS.has(item)) return false;
    if (set.has(item)) return false;
    set.add(item);
  }
  return true;
}

const CONFIG_CHECKS: Record<keyof ClientConfig, (v: unknown) => boolean> = {
  themeMode: (v) => v === "system" || v === "light" || v === "dark",
  accent: (v) => typeof v === "string" && (ACCENT_NAMES as readonly string[]).includes(v),
  quotaDisplay: (v) => v === "remaining" || v === "used",
  quotaButton: (v) => typeof v === "boolean",
  quotaShowAccount: (v) => typeof v === "boolean",
  usageScanMode: (v) => v === "realtime" || v === "scheduled",
  usageScanInterval: (v) => v === "1m" || v === "2m" || v === "5m" || v === "10m" || v === "15m",
  quotaProviders: (v) => {
    if (!isObj(v)) return false;
    const keys = Object.keys(v);
    if (keys.length === 0) return true;
    return keys.every((k) => VALID_PROVIDERS.has(k) && typeof (v as any)[k] === "boolean");
  },
};

/** Returns an error message, or null when every key is known and well-typed. */
function validateClientConfigPatch(patch: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(patch)) {
    const check = CONFIG_CHECKS[key as keyof ClientConfig];
    if (!check) return `Unknown client config key '${key}'`;
    if (!check(value)) return `Invalid value for client config '${key}'`;
  }
  return null;
}
