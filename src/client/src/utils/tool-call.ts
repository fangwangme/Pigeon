import type { NormalizedToolCall, NormalizedTurn } from "../../../shared/agent-session";

export function callCommand(call: NormalizedToolCall): string {
  const input = call.input as unknown;
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") return command;
    if (Array.isArray(command)) return command.join(" ");
  }
  return call.target || "";
}

export function callInputText(call: NormalizedToolCall): string {
  const input = call.input as unknown;
  if (input === undefined || input === null) return "";
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

/** mobile-ui-and-themes.md §4.3, protocol.md §5.4: a completed AGY artifact yields when a screen prompt is active. */
export function activePlanForInteraction(
  source: "screen" | "transcript" | undefined,
  pendingPlan: NormalizedTurn["pendingPlan"] | undefined
): NormalizedTurn["pendingPlan"] | undefined {
  if (!pendingPlan?.markdown) return undefined;
  if (pendingPlan.artifact && source !== "transcript") return undefined;
  return pendingPlan;
}
