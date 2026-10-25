import type { NormalizedTurn, FileDiffSummary } from "../shared/agent-session";
export type { NormalizedTurn, NormalizedToolCall, FileDiffSummary, NormalizedQuestion, NormalizedBlock, NormalizedBlockKind } from "../shared/agent-session";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type CardKind = "thought" | "tool_call" | "diff" | "markdown" | "interaction" | "text";

export interface BaseCard {
  id: string;
  kind: CardKind;
  timestamp?: number;
}

export interface ThoughtCard extends BaseCard {
  kind: "thought";
  title?: string;
  body: string;
  collapsed?: boolean;
}

export interface ToolCallCard extends BaseCard {
  kind: "tool_call";
  title: string;
  command: string;
  status: "running" | "done" | "error";
  exitCode?: number;
  output?: string;
}

export interface DiffCard extends BaseCard {
  kind: "diff";
  filePath: string;
  additions: number;
  deletions: number;
  diff: string;
  collapsed?: boolean;
}

export interface MarkdownCard extends BaseCard {
  kind: "markdown";
  content: string;
}

export interface InteractionCardData extends BaseCard {
  kind: "interaction";
  interactionId: string;
  title: string;
  question: string;
  payload?: string;
  fingerprint: string;
  options: Array<{
    id: string;
    label: string;
    keyShortcut?: string;
  }>;
  fallbackKeys: string[];
}

export interface TextCard extends BaseCard {
  kind: "text";
  text: string;
}

export type Card = ThoughtCard | ToolCallCard | DiffCard | MarkdownCard | InteractionCardData | TextCard;

export interface PaneSummary {
  id: string;
  agent: string | null;
  agentStatus: AgentStatus;
  isPrimary: boolean;
  name?: string;
}

export interface TabSummary {
  id: string;
  label: string;
  paneCount: number;
  panes: PaneSummary[];
}

export interface WorkspaceSummary {
  id: string;
  label: string;
  tabCount: number;
  activeTabId: string | null;
  hasWarn?: boolean;
  hasWorking?: boolean;
  isFocused?: boolean;
  tabs: TabSummary[];
}

export interface WorkingAgentSummary {
  agent: string;
  name: string;
  status: AgentStatus;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  paneId: string;
  summary?: string;
}

export interface SnapshotPayload {
  workspaces: WorkspaceSummary[];
  workingAgents: WorkingAgentSummary[];
}

export interface PaneStatePayload {
  paneId: string;
  workspaceId: string;
  tabId: string;
  agentStatus: AgentStatus;
  cards: Card[];
  pendingInteraction: InteractionCardData | null;
  rawScreen: string;
  revision: number;
}

export interface MacroItem {
  id: string;
  name: string;
  type: "text" | "key";
  payload: string;
  /** Ask for a second tap before sending (used for interrupting keys such as Ctrl+C). */
  confirm?: boolean;
}

export type DisplayDensity = "compact" | "aggregated" | "detailed";

export interface ClientConfig {
  themeKey: string;
  themeMode: "system" | "light" | "dark";
  themeId: string;
  confirmCtrlC: boolean;
  defaultView: string;
  macros: MacroItem[];
  displayDensity?: DisplayDensity;
  showScrollControls?: boolean;
  showMacroDock?: boolean;
}

export interface ServerConfig {
  port: number;
  host: string;
  insecureDev: boolean;
  publicBaseUrl: string;
  herdrSocketPath: string;
  adminSocketPath: string;
  /** Directory for devices.json and vapid.json. */
  stateDir: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  source: "builtin" | "user" | "project";
  /** Text to insert into the prompt to invoke the skill in this agent (e.g. "/name", "$name"). */
  invocation: string;
}

export interface ModelOption {
  id: string;
  label: string;
  thinkingLevels?: string[];
}

export interface AgentRecipeSummary {
  kind: string;
  label: string;
  models: ModelOption[];
  defaultModel?: string;
  defaultThinking?: string;
  interruptKeys: string[];
}

export interface TurnsDeltaPayload {
  paneId: string;
  seqWatermark: number;
  sinceTurnIndex: number;
  appendTurns: NormalizedTurn[];
  patchLastTurn?: NormalizedTurn;
  sessionStats?: { filesModified: number; additions: number; deletions: number; diffs?: FileDiffSummary[] };
  sessionTitle?: string;
  isStreaming?: boolean;
}

export interface PigeonConfig {
  server: ServerConfig;
  client: ClientConfig;
}

// Client -> Server messages
export type ClientMessage =
  | { type: "hello"; id: string; payload: { protocolVersion: string; subscribePaneId?: string } }
  | { type: "ping"; id?: string; timestamp?: number }
  | { type: "presence_update"; isVisible: boolean; viewingPaneId: string | null }
  | { type: "select_view"; id: string; payload: { paneId: string } }
  | { type: "interaction_respond"; id: string; payload: { targetPaneId: string; interactionId: string; optionId: string; fingerprint: string } }
  | { type: "agent_prompt"; id: string; payload: { targetPaneId: string; text: string } }
  | { type: "agent_send_keys"; id: string; payload: { targetPaneId: string; keys: string[] } }
  | { type: "create_tab_and_agent"; id: string; payload: { workspaceId: string; agentKind: string; modelId?: string; thinking?: string; cwd?: string } }
  | { type: "close_tab"; id: string; payload: { tabId: string } }
  | { type: "skills_get"; id: string }
  | { type: "config_get"; id: string }
  | { type: "config_patch"; id: string; payload: { client: Partial<ClientConfig> } };

// Server -> Client messages
export type ServerMessage =
  | { type: "welcome"; replyTo: string; payload: { protocolVersion: string; serverVersion: string; deviceId: string; clientConfig: ClientConfig; recipes: Record<string, AgentRecipeSummary> } }
  | { type: "pong"; timestamp: number }
  | { type: "ack"; replyTo: string; payload: { status: "ok"; [key: string]: any } }
  | { type: "error"; replyTo?: string; error: { code: string; message: string; details?: any } }
  | { type: "pane_state"; payload: PaneStatePayload }
  | { type: "snapshot_update"; payload: SnapshotPayload }
  | { type: "config_sync"; replyTo?: string; payload: { version: number; client: ClientConfig } }
  | { type: "config_updated"; payload: { version: number; client: ClientConfig } }
  | { type: "skills_sync"; replyTo?: string; payload: { paneId: string | null; skills: SkillEntry[]; recipes: Record<string, AgentRecipeSummary> } }
  | { type: "upstream_status"; payload: { herdrConnected: boolean; lastSyncTimestamp: number } }
  | { type: "normalized_turns"; payload: { paneId: string; turns: NormalizedTurn[]; sessionStats?: { filesModified: number; additions: number; deletions: number; diffs?: FileDiffSummary[] }; sessionTitle?: string } }
  | { type: "turns_delta"; payload: TurnsDeltaPayload };

export const ProtocolErrors = {
  ERR_UNAUTHORIZED: "ERR_UNAUTHORIZED",
  ERR_FORBIDDEN_ORIGIN: "ERR_FORBIDDEN_ORIGIN",
  ERR_INVALID_PAYLOAD: "ERR_INVALID_PAYLOAD",
  ERR_NOT_FOUND: "ERR_NOT_FOUND",
  ERR_INTERACTION_STALE: "ERR_INTERACTION_STALE",
  ERR_AGENT_BUSY: "ERR_AGENT_BUSY",
  ERR_AGENT_NOT_READY: "ERR_AGENT_NOT_READY",
  ERR_AGENT_BLOCKED: "ERR_AGENT_BLOCKED",
  ERR_TIMEOUT: "ERR_TIMEOUT",
  ERR_INCOMPATIBLE_PROTOCOL: "ERR_INCOMPATIBLE_PROTOCOL",
  ERR_INTERNAL: "ERR_INTERNAL",
} as const;
