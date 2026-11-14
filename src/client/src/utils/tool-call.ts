import type { NormalizedToolCall } from "../../../shared/agent-session";

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
