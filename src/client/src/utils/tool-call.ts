import type { NormalizedToolCall } from "../../../shared/agent-session";

// protocol.md §4.20: transcript payloads carry lightweight calls whose `input`/`output` arrive later through
// `detail_get`, so every reader must handle a call without them.

/** The command a `run` call executed, or its target while the input has not arrived. */
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

/** A call's input as shown text; empty while it has not arrived. */
export function callInputText(call: NormalizedToolCall): string {
  const input = call.input as unknown;
  if (input === undefined || input === null) return "";
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}
