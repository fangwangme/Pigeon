// Issue #13. quota-and-usage.md §3.2. Model ID normalization.

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
