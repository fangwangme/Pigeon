import { fallbackLabel, normalizeAntigravityKey, stripAntigravityTier } from "../../../shared/model-name";
import type { AgentRecipeSummary } from "../../../types/protocol";

export type ModelRecipeMap = Record<string, Pick<AgentRecipeSummary, "models"> | undefined>;

/**
 * Formats a model identifier into a friendly label using the known recipes.
 * Supports multi-agent lookup (skipping unresolved `label === id` entries) and
 * Antigravity tierless canonical ID matching / display tier stripping.
 */
export function formatModelNameWithRecipes(
  recipes: ModelRecipeMap,
  agent: string | ReadonlyArray<string | null | undefined> | null | undefined,
  model: string | null | undefined
): string {
  if (!model) return "";

  const agents: string[] = Array.isArray(agent)
    ? agent.filter((a): a is string => typeof a === "string" && a.length > 0)
    : typeof agent === "string" && agent.length > 0
    ? [agent]
    : [];

  for (const ag of agents) {
    const models = recipes[ag]?.models ?? [];
    const exact = models.find((m: { id: string; label?: string }) => m.id === model || m.label === model);
    if (exact && exact.label && exact.label !== exact.id) {
      return ag === "agy" ? stripAntigravityTier(exact.label) : exact.label;
    }

    if (ag === "agy") {
      const targetKey = normalizeAntigravityKey(model);
      if (targetKey) {
        const tierMatch = models.find(
          (m: { id: string; label?: string }) =>
            m.label &&
            m.label !== m.id &&
            (normalizeAntigravityKey(m.id) === targetKey || normalizeAntigravityKey(m.label) === targetKey)
        );
        if (tierMatch?.label) {
          return stripAntigravityTier(tierMatch.label);
        }
      }
    }
  }

  const base = agents.includes("agy") ? stripAntigravityTier(model) : model;
  return fallbackLabel(base);
}
