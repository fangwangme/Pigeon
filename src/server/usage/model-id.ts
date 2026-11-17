// Issue #13, #33. quota-and-usage.md §3.2. Model ID normalization.

export function stripDateSuffix(modelId: string): string {
  const m1 = modelId.match(/-(\d{8})$/);
  if (m1) return modelId.slice(0, -9);
  const m2 = modelId.match(/-(\d{4}-\d{2}-\d{2})$/);
  if (m2) return modelId.slice(0, -11);
  return modelId;
}

export function stripVariantSuffixes(modelId: string): string {
  let s = modelId;
  const suffixes = ["-xhigh", "-high", "-medium", "-low", "-minimal", "-free", "-thinking", "-tiered"];
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
  if (
    lower.includes("gemini") ||
    lower.includes("palm") ||
    lower.includes("gemma") ||
    lower.includes("argon") ||
    lower.includes("carbon") ||
    lower.includes("hydrogen") ||
    lower.includes("google")
  ) {
    return "google";
  }
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

export function isAntigravityRoutingModel(modelId: string): boolean {
  if (isPseudoModel(modelId)) return true;
  const norm = formatModelId(modelId);
  return (
    norm === "gemini-pro-orchestrator" ||
    norm.startsWith("gemini-pro-orchestrator-") ||
    norm === "gemini-flash-worker-agy" ||
    /^gemini-[a-z0-9-]+-worker(?:-agy)?$/.test(norm)
  );
}

/** Concrete versioned model enums only; dynamic orchestrator/worker enums resolve through displayName + release dates. */
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
  m322: "gemini-3-8-flash-tiered",
  m399: "claude-opus-5-5-low",
  m400: "claude-opus-5-5-medium",
  m401: "claude-opus-5-5-high",
  m402: "claude-opus-5-5-high",
  m403: "claude-sonnet-5-5-low",
  m404: "claude-sonnet-5-5-medium",
  m405: "claude-sonnet-5-5-high",
  m417: "gemini-4-argon-high",
  m418: "gemini-4-argon-medium",
  m419: "gemini-4-argon-low",
  m421: "gemini-4-argon",
  m427: "gemini-4-carbon-high",
  m437: "gemini-4-carbon-medium",
  m438: "gemini-4-carbon-low",
  m525: "gemini-4-hydrogen-high",
  m526: "gemini-4-hydrogen-medium",
  m527: "gemini-4-hydrogen-low",
  m528: "gemini-4-hydrogen-xhigh",
};

const KNOWN_CODENAMES: Record<string, string> = {
  "gemini-3-flash-a": "gemini-3-5-flash",
  "gemini-3.8-flash-n": "gemini-3-8-flash",
  "gemini-4-argon-trial": "gemini-4-argon",
};

let modelAliases: Map<string, string> | null = null;

/** Antigravity's model enums → formatted model ids. `lookupAlias` also matches the `MODEL_PLACEHOLDER_` forms. */
function modelAliasTable(): Map<string, string> {
  modelAliases ??= new Map(Object.entries(STATIC_MODEL_ALIASES).map(([k, v]) => [k.toLowerCase(), formatModelId(v)]));
  return modelAliases;
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

function parseDisplayName(displayName: string): { concreteModelId?: string; unversionedFamily?: string } | null {
  const trimmed = displayName.trim();
  if (!trimmed) return null;

  // "Orchestrator (Carbon)", "Orchestrator (Argon)", or versioned "Orchestrator (Gemini 4.2 Carbon)" / "Orchestrator (Carbon 4.2)"
  const orchMatch = trimmed.match(/^orchestrator\s*\(([^)]+)\)$/i);
  if (orchMatch) {
    const inner = orchMatch[1].trim();
    if (!inner) return null;
    if (/\d/.test(inner)) {
      const nameVer = inner.match(/^(?:gemini[\s_-]+)?([a-z][a-z0-9-]*)\s+(\d+(?:[._-]\d+)?)$/i);
      if (nameVer) {
        return { concreteModelId: formatModelId(`gemini-${nameVer[2]}-${nameVer[1]}`) };
      }
      const prefixed = /^gemini[\s_-]/i.test(inner) ? inner : `gemini-${inner}`;
      return { concreteModelId: formatModelId(prefixed) };
    }
    const fam = formatModelId(inner.replace(/^gemini[\s_-]+/i, ""));
    return fam ? { unversionedFamily: fam } : null;
  }

  // Only treat as a display label (not a raw enum like MODEL_PLACEHOLDER_M668) when it has spaces or parentheses
  if (!/[\s()]/.test(trimmed)) return null;

  const base = trimmed.replace(/(?:\s*\([^)]+\))+\s*$/, "").trim();
  if (!base) return null;

  if (/\d/.test(base)) {
    return { concreteModelId: formatModelId(base) };
  }

  if (/^gemini[\s_-]+/i.test(base) || /\(\s*orchestrator\s*\)/i.test(trimmed)) {
    const fam = formatModelId(base.replace(/^gemini[\s_-]+/i, ""));
    if (fam) return { unversionedFamily: fam };
  }

  return { concreteModelId: formatModelId(base) };
}

function extractRoutingFamily(slug: string): string | null {
  const norm = formatModelId(slug);
  if (norm === "gemini-pro-orchestrator") return "carbon";
  if (norm === "gemini-pro-orchestrator-g1-pro") return "argon";
  if (norm.startsWith("gemini-pro-orchestrator-")) {
    const suffix = norm.slice("gemini-pro-orchestrator-".length);
    return suffix || null;
  }
  if (norm === "gemini-flash-worker-agy") return "flash";
  const workerMatch = norm.match(/^gemini-([a-z0-9]+)-worker(?:-agy)?$/);
  if (workerMatch) return workerMatch[1];
  return null;
}

export interface ResolvedAntigravityModel {
  rawModelId: string;
  modelId: string;
  canonicalModelId: string;
  unversionedFamily?: string;
}

export function resolveAntigravityModel(
  modelEnum: string | null | undefined,
  servedModel: string | null | undefined,
  displayName?: string | null
): ResolvedAntigravityModel {
  const aliases = modelAliasTable();
  const rawEnum = modelEnum?.trim() || null;
  const rawServed = servedModel?.trim() || null;
  const rawDisplay = displayName?.trim() || null;

  // Step 1: Concrete static enum alias
  if (rawEnum) {
    const alias = lookupAlias(rawEnum, aliases);
    if (alias) {
      const modelId = formatModelId(alias);
      return {
        rawModelId: rawEnum,
        modelId,
        canonicalModelId: canonical(modelId),
      };
    }

    // Stored raw_model_id from a previous unversioned family scan (re-evaluated during repairAntigravityRecords)
    const storedDisp = parseDisplayName(rawEnum);
    if (storedDisp?.unversionedFamily) {
      const fallback = `gemini-${storedDisp.unversionedFamily}`;
      return {
        rawModelId: rawEnum,
        modelId: fallback,
        canonicalModelId: fallback,
        unversionedFamily: storedDisp.unversionedFamily,
      };
    }
    const storedRouteFam = extractRoutingFamily(rawEnum);
    if (storedRouteFam) {
      const formatted = formatModelId(rawEnum);
      return {
        rawModelId: rawEnum,
        modelId: formatted,
        canonicalModelId: canonical(formatted),
        unversionedFamily: storedRouteFam,
      };
    }
  }

  // Step 2: Non-routing served model
  if (rawServed && !isAntigravityRoutingModel(rawServed)) {
    const servedDisp = parseDisplayName(rawServed);
    if (!servedDisp) {
      const codename = KNOWN_CODENAMES[rawServed.toLowerCase()];
      const modelId = codename ? formatModelId(codename) : formatModelId(rawServed);
      return {
        rawModelId: rawEnum || rawServed,
        modelId,
        canonicalModelId: canonical(modelId),
      };
    }
  }

  // Step 3: Display name (#21) — resolves ahead of routing servedModel slugs
  const dispSource = rawDisplay || (rawServed && parseDisplayName(rawServed) ? rawServed : null);
  if (dispSource) {
    const parsed = parseDisplayName(dispSource);
    if (parsed?.concreteModelId) {
      return {
        rawModelId: rawEnum || dispSource,
        modelId: parsed.concreteModelId,
        canonicalModelId: canonical(parsed.concreteModelId),
      };
    }
    if (parsed?.unversionedFamily) {
      const fallback = rawServed ? formatModelId(rawServed) : `gemini-${parsed.unversionedFamily}`;
      return {
        rawModelId: dispSource,
        modelId: fallback,
        canonicalModelId: canonical(fallback),
        unversionedFamily: parsed.unversionedFamily,
      };
    }
  }

  // Step 4: Routing servedModel family fallback when displayName is absent
  if (rawServed) {
    const routeFam = extractRoutingFamily(rawServed);
    if (routeFam) {
      const modelId = formatModelId(rawServed);
      return {
        rawModelId: rawServed,
        modelId,
        canonicalModelId: canonical(modelId),
        unversionedFamily: routeFam,
      };
    }
    if (!isPseudoModel(rawServed)) {
      const modelId = formatModelId(rawServed);
      return {
        rawModelId: rawEnum || rawServed,
        modelId,
        canonicalModelId: canonical(modelId),
      };
    }
  }

  // Step 5: Raw enum fallback
  if (rawEnum) {
    const modelId = formatModelId(rawEnum);
    return {
      rawModelId: rawEnum,
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
