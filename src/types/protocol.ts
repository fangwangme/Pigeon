import type { NormalizedTurn, SessionStats, TodoItem } from "../shared/agent-session";
export type { NormalizedTurn, NormalizedToolCall, FileDiffSummary, NormalizedQuestion, SessionStats, TodoItem, TurnItem, ToolVerb } from "../shared/agent-session";

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
  /** The pane's foreground program (`protocol.md` §5.3). */
  program?: string;
  summary?: string;
}

export interface TabSummary {
  id: string;
  label: string;
  branch?: string;
  paneCount: number;
  panes: PaneSummary[];
}

export interface WorkspaceSummary {
  id: string;
  label: string;
  folder: string;
  branch?: string;
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

export type ThemeMode = "system" | "light" | "dark";
export type AccentName = "blue" | "purple" | "green" | "orange" | "pink";

/** Appearance shared by every paired phone (`protocol.md` §6). */
export interface ClientConfig {
  themeMode: ThemeMode;
  accent: AccentName;
}

export interface ServerConfig {
  port: number;
  host: string;
  insecureDev: boolean;
  publicBaseUrl: string;
  /** Herdr App window socket (`herdr-adapter.md` §2). */
  herdrAppSocketPath: string;
  /** Herdr Core socket (`herdr-adapter.md` §2). */
  herdrCoreSocketPath: string;
  adminSocketPath: string;
  /** Directory for devices.json and vapid.json. */
  stateDir: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  source: "builtin" | "user" | "project" | "plugin";
  kind: "skill" | "command";
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
  /** Whether `resumeSessionId` is accepted (`protocol.md` §4.5). */
  resumable: boolean;
  /** Which values `agent_set_model` can change (`protocol.md` §4.9). */
  runtimeSwitch: { model: boolean; thinking: boolean };
}

export interface SessionValue {
  value: string | null;
  source: "log" | "launch" | "unknown";
}

/** `protocol.md` §5.6. */
export interface SessionInfo {
  bound: boolean;
  agent: string | null;
  sessionId?: string;
  model: SessionValue;
  thinking: SessionValue;
}

export interface NormalizedTurnsPayload {
  paneId: string;
  turns: NormalizedTurn[];
  sessionStats?: SessionStats;
  sessionTitle?: string;
  todos?: TodoItem[];
  session: SessionInfo;
}

export interface TurnsDeltaPayload {
  paneId: string;
  seqWatermark: number;
  sinceTurnIndex: number;
  appendTurns: NormalizedTurn[];
  patchLastTurn?: NormalizedTurn;
  sessionStats?: SessionStats;
  sessionTitle?: string;
  todos?: TodoItem[];
  session?: SessionInfo;
  isStreaming?: boolean;
}

export interface QueuedPrompt {
  queueId: string;
  text: string;
  attachments: string[];
  createdAt: number;
}

export interface PromptQueuePayload {
  paneId: string;
  items: QueuedPrompt[];
}

export interface PastSession {
  id: string;
  title: string;
  updatedAt: number;
}

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  createdAt: number;
  lastUsedAt: number;
  isThisDevice: boolean;
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
  | { type: "agent_prompt"; id: string; payload: { targetPaneId: string; text: string; attachments?: string[] } }
  | { type: "agent_send_keys"; id: string; payload: { targetPaneId: string; keys: string[] } }
  | { type: "create_tab_and_agent"; id: string; payload: { workspaceId: string; agentKind: string; modelId?: string; thinking?: string; cwd?: string; firstMessage?: string; resumeSessionId?: string } }
  | { type: "close_tab"; id: string; payload: { tabId: string } }
  | { type: "agent_set_model"; id: string; payload: { targetPaneId: string; modelId?: string; thinking?: string } }
  | { type: "sessions_list"; id: string; payload: { workspaceId: string; agentKind: string } }
  | { type: "tab_rename"; id: string; payload: { tabId: string; name: string } }
  | { type: "devices_list"; id: string }
  | { type: "device_revoke"; id: string; payload: { deviceId: string } }
  | { type: "queue_cancel"; id: string; payload: { targetPaneId: string; queueId: string } }
  | { type: "skills_get"; id: string }
  | { type: "config_get"; id: string }
  | { type: "config_patch"; id: string; payload: { client: Partial<ClientConfig> } };

// Server -> Client messages
export type ServerMessage =
  | { type: "welcome"; replyTo: string; payload: { protocolVersion: string; serverVersion: string; buildId: string; deviceId: string; clientConfig: ClientConfig; recipes: Record<string, AgentRecipeSummary> } }
  | { type: "pong"; timestamp: number }
  | { type: "ack"; replyTo: string; payload: { status: "ok"; [key: string]: any } }
  | { type: "error"; replyTo?: string; error: { code: string; message: string; details?: any } }
  | { type: "pane_state"; payload: PaneStatePayload }
  | { type: "snapshot_update"; payload: SnapshotPayload }
  | { type: "config_sync"; replyTo?: string; payload: { version: number; client: ClientConfig } }
  | { type: "config_updated"; payload: { version: number; client: ClientConfig } }
  | { type: "skills_sync"; replyTo?: string; payload: { paneId: string | null; skills: SkillEntry[]; recipes: Record<string, AgentRecipeSummary> } }
  | { type: "upstream_status"; payload: { herdrConnected: boolean; lastSyncTimestamp: number } }
  | { type: "normalized_turns"; payload: NormalizedTurnsPayload }
  | { type: "turns_delta"; payload: TurnsDeltaPayload }
  | { type: "prompt_queue"; payload: PromptQueuePayload };

export const ProtocolErrors = {
  ERR_INVALID_PAYLOAD: "ERR_INVALID_PAYLOAD",
  ERR_NOT_FOUND: "ERR_NOT_FOUND",
  ERR_INTERACTION_STALE: "ERR_INTERACTION_STALE",
  ERR_AGENT_NOT_READY: "ERR_AGENT_NOT_READY",
  ERR_AGENT_BLOCKED: "ERR_AGENT_BLOCKED",
  ERR_TIMEOUT: "ERR_TIMEOUT",
  ERR_INCOMPATIBLE_PROTOCOL: "ERR_INCOMPATIBLE_PROTOCOL",
  ERR_INTERNAL: "ERR_INTERNAL",
} as const;
