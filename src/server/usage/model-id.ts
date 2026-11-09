// Issue #13. quota-and-usage.md §3.2. Model ID normalization.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function stripDateSuffix(modelId: string): string {
  const m1 = modelId.match(/-(\d{8})$/);
  if (m1) return modelId.slice(0, -9);
  const m2 = modelId.match(/-(\d{4}-\d{2}-\d{2})$/);
  if (m2) return modelId.slice(0, -11);
  return modelId;
}

export function stripVariantSuffixes(modelId: string): string {
  let s = modelId;
  const suffixes = ["-high", "-medium", "-low", "-free", "-thinking", "-tiered"];
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of suffixes) {
      if (s.endsWith(suffix)) {
        s = s.slice(0, -suffix.length);
        stripped = true;
        break;
      }
    }
  }
  if (s.endsWith("-0")) {
    s = s.slice(0, -2);
  }
  return s.replace(/^-+|-+$/g, "");
}

export function collapseRepeatedHyphens(s: string): string {
  return s.replace(/-+/g, "-");
}

export function formatModelId(modelId: string): string {
  let normalized = modelId.trim().toLowerCase().replace(/[._ ]/g, "-");
  for (const prefix of ["antigravity-", "anti-gravity-"]) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }
  return collapseRepeatedHyphens(normalized).replace(/^-+|-+$/g, "");
}

export function pricingKey(modelId: string): string {
  let normalized = modelId.trim().toLowerCase();
  normalized = stripDateSuffix(normalized);

  const slashIdx = normalized.lastIndexOf("/");
  if (slashIdx >= 0) {
    normalized = normalized.slice(slashIdx + 1);
  }

  normalized = normalized.replace(/[._ ]/g, "-");
  normalized = collapseRepeatedHyphens(normalized);

  for (const prefix of ["antigravity-", "anti-gravity-"]) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }

  return stripVariantSuffixes(normalized);
}

export function canonical(modelId: string): string {
  const pk = pricingKey(modelId);
  const withoutPreview = pk
    .split("-")
    .filter((segment) => segment !== "preview")
    .join("-");
  return stripVariantSuffixes(withoutPreview);
}

export function detectCompany(modelId: string, agentKind?: string): "anthropic" | "openai" | "google" | "other" {
  const lower = modelId.toLowerCase();
  if (lower.includes("claude") || lower.includes("anthropic")) return "anthropic";
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3") || lower.includes("chatgpt") || lower.includes("openai") || lower.includes("codex")) return "openai";
  if (lower.includes("gemini") || lower.includes("palm") || lower.includes("gemma") || lower.includes("argon") || lower.includes("google")) return "google";
  if (agentKind === "claude") return "anthropic";
  if (agentKind === "codex") return "openai";
  if (agentKind === "agy") return "google";
  return "other";
}

export function isPseudoModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return (
    lower === "gemini-default" ||
    lower === "auto-gemini-3" ||
    lower === "unknown" ||
    lower === "codex-auto-review"
  );
}

export const STATIC_MODEL_ALIASES: Record<string, string> = {
  m37: "gemini-3-1-pro-high",
  m36: "gemini-3-1-pro-low",
  m18: "gemini-3-flash",
  m8: "gemini-3-pro-high",
  m7: "gemini-3-pro-low",
  m9: "gemini-3-pro-image",
  m26: "claude-opus-4-6-thinking",
  m35: "claude-sonnet-4-6-thinking",
  m12: "claude-opus-4-5-thinking",
  model_claude_4_5_sonnet: "claude-sonnet-4-5",
  model_openai_gpt_oss_120b_medium: "gpt-oss-120b-medium",
  m47: "gemini-3-flash",
  m16: "gemini-3-1-pro-high",
  m132: "gemini-3-5-flash-high",
  m20: "gemini-3-5-flash-medium",
  m187: "gemini-3-5-flash-low",
  m196: "gemini-3-6-flash",
  m264: "gemini-3-6-flash",
  m71: "gemini-3-6-flash-high",
  m72: "gemini-3-6-flash-medium",
  m73: "gemini-3-6-flash-low",
  m298: "gemini-3-7-flash-high",
  m299: "gemini-3-7-flash-medium",
  m300: "gemini-3-7-flash-low",
  m318: "gemini-3-8-flash-high",
  m319: "gemini-3-8-flash-medium",
  m320: "gemini-3-8-flash-low",
  m399: "claude-opus-5-5-low",
  m400: "claude-opus-5-5-medium",
  m401: "claude-opus-5-5-high",
  m403: "claude-sonnet-5-5-low",
  m404: "claude-sonnet-5-5-medium",
  m405: "claude-sonnet-5-5-high",
  m417: "gemini-4-argon-high",
  m418: "gemini-4-argon-medium",
  m419: "gemini-4-argon-low",
  m421: "gemini-4-argon",
};

const KNOWN_CODENAMES: Record<string, string> = {
  "gemini-3-flash-a": "gemini-3-5-flash",
  "gemini-3.8-flash-n": "gemini-3-8-flash",
  "gemini-4-argon-trial": "gemini-4-argon",
};

let dynamicAliasesLoaded = false;
const dynamicAliases = new Map<string, string>();

export function loadModelAliases(): Map<string, string> {
  if (dynamicAliasesLoaded) return dynamicAliases;
  dynamicAliasesLoaded = true;

  for (const [k, v] of Object.entries(STATIC_MODEL_ALIASES)) {
    const formatted = formatModelId(v);
    dynamicAliases.set(k.toLowerCase(), formatted);
    dynamicAliases.set(`model_placeholder_${k}`.toLowerCase(), formatted);
    dynamicAliases.set(`model-placeholder-${k}`.toLowerCase(), formatted);
  }

  try {
    const home = process.env.HOME || "";
    const p = join(home, ".local", "share", "tokenpulse", "antigravity-cache", "model-aliases.json");
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed?.aliases) {
        for (const [key, entry] of Object.entries(parsed.aliases)) {
          const mId = (entry as any)?.modelId;
          if (mId) {
            const formatted = formatModelId(mId);
            dynamicAliases.set(key.toLowerCase(), formatted);
            const raw = (entry as any)?.rawModelId;
            if (raw) dynamicAliases.set(raw.toLowerCase(), formatted);
          }
        }
      }
    }
  } catch {}

  return dynamicAliases;
}

function lookupAlias(raw: string, table: Map<string, string>): string | undefined {
  const norm = raw.trim().toLowerCase();
  if (table.has(norm)) return table.get(norm);
  const withUnder = norm.replace(/-/g, "_");
  if (table.has(withUnder)) return table.get(withUnder);
  const withDash = norm.replace(/_/g, "-");
  if (table.has(withDash)) return table.get(withDash);
  const stripped = norm.replace(/^model[_-]placeholder[_-]/, "");
  if (table.has(stripped)) return table.get(stripped);
  return undefined;
}

export function resolveAntigravityModel(
  modelEnum: string | null | undefined,
  servedModel: string | null | undefined
): { rawModelId: string; modelId: string; canonicalModelId: string } {
  const aliases = loadModelAliases();
  const rawEnum = modelEnum?.trim() || null;
  const rawServed = servedModel?.trim() || null;
  const rawModelId = rawEnum || rawServed || "unknown";

  // Step 1: Enum in alias table
  if (rawEnum) {
    const alias = lookupAlias(rawEnum, aliases);
    if (alias) {
      const modelId = formatModelId(alias);
      return {
        rawModelId,
        modelId,
        canonicalModelId: canonical(modelId),
      };
    }
  }

  // Step 2: Served model (check known codenames or non-pseudo)
  if (rawServed && !isPseudoModel(rawServed)) {
    const codename = KNOWN_CODENAMES[rawServed.toLowerCase()];
    const modelId = codename ? formatModelId(codename) : formatModelId(rawServed);
    return {
      rawModelId,
      modelId,
      canonicalModelId: canonical(modelId),
    };
  }

  // Step 3: Raw enum fallback
  if (rawEnum) {
    const modelId = formatModelId(rawEnum);
    return {
      rawModelId,
      modelId,
      canonicalModelId: canonical(modelId),
    };
  }

  return {
    rawModelId: "unknown",
    modelId: "unknown",
    canonicalModelId: "unknown",
  };
}

