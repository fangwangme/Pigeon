/** Fallback model display name: strip provider prefix (`provider/model` -> `model`). */
export function fallbackLabel(id: string): string {
  const slash = id.lastIndexOf("/");
  if (slash !== -1 && slash < id.length - 1) {
    return id.slice(slash + 1);
  }
  return id;
}

const AGY_TIER_SUFFIX_RE = /\s*\([^)]+\)\s*$/;
const AGY_ID_TIER_RE = /[-_](low|medium|high|minimal)$/i;

/** Strips a trailing thinking-tier suffix (e.g. ` (Medium)`) from an Antigravity model label. */
export function stripAntigravityTier(label: string): string {
  return label.replace(AGY_TIER_SUFFIX_RE, "").trim();
}

/** Normalizes an Antigravity model id or label into a comparable tierless token key. */
export function normalizeAntigravityKey(idOrLabel: string): string {
  return stripAntigravityTier(idOrLabel)
    .toLowerCase()
    .replace(AGY_ID_TIER_RE, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
