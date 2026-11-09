import type { NormalizedTurn, SessionStats, TodoItem } from "../shared/agent-session";
export type { NormalizedTurn, NormalizedToolCall, FileDiffSummary, NormalizedQuestion, SessionStats, TodoItem, TurnItem, ToolVerb } from "../shared/agent-session";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type CardKind = "thought" | "tool_call" | "diff" | "markdown" | "interaction";

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

export type Card = ThoughtCard | ToolCallCard | DiffCard | MarkdownCard | InteractionCardData;

export interface PaneSummary {
  id: string;
  agent: string | null;
  agentStatus: AgentStatus;
  isPrimary: boolean;
  name?: string;
  /** The pane's foreground program (`protocol.md` §5.3). */
  program?: string;
  summary?: string;
  /** How the phone shows `summary` (`protocol.md` §5.3). */
  summaryKind?: SummaryKind;
}

/** `text`: shown as is; `run`: the running command; `thinking`: the thought's title, or empty. */
export type SummaryKind = "text" | "run" | "thinking";

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
  summaryKind?: SummaryKind;
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
export type QuotaDisplayMode = "remaining" | "used";

export interface QuotaProvidersConfig {
  claude: boolean;
  codex: boolean;
  antigravity: boolean;
}

export type UsageScanMode = "realtime" | "scheduled";
export type UsageScanInterval = "1m" | "2m" | "5m" | "10m" | "15m";

/** Appearance and quota settings shared by every paired phone (`protocol.md` §6). */
export interface ClientConfig {
  themeMode: ThemeMode;
  accent: AccentName;
  quotaProviders?: QuotaProvidersConfig;
  quotaDisplay?: QuotaDisplayMode;
  quotaButton?: boolean;
  quotaShowAccount?: boolean;
  usageScanMode?: UsageScanMode;
  usageScanInterval?: UsageScanInterval;
}

export interface QuotaWindow {
  id: string;
  label: string;
  family?: string;
  usedPercent: number;
  periodMs: number | null;
  resetsAt: number | null;
}

export interface QuotaCredit {
  id?: string;
  label?: string;
  expiresAt: number | null;
  [key: string]: any;
}

export interface QuotaSnapshot {
  provider: "claude" | "codex" | "antigravity";
  plan?: string;
  account?: string;
  windows: QuotaWindow[];
  credits: QuotaCredit[];
  fetchedAt: number;
}

export interface QuotaProviderState {
  provider: "claude" | "codex" | "antigravity";
  enabled: boolean;
  snapshot: QuotaSnapshot | null;
  error: { message: string; at: number } | null;
}

export interface QuotaGetPayload {
  providers: QuotaProviderState[];
}

export interface UsageTotals {
  cost: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  sessions: number;
}

export interface UsageDaySummary extends UsageTotals {
  date: string;
}

export interface UsageModelSummary extends UsageTotals {
  model: string;
  company: string;
  agents: string[];
  lastUsed: string;
  unpriced: boolean;
}

export interface UsageGetPayload {
  range: { from: string; to: string };
  firstDay: string | null;
  scannedAt: number;
  pricesAvailable: boolean;
  totals: UsageTotals;
  comparison: { from: string; to: string; totals: UsageTotals } | null;
  days: UsageDaySummary[];
  models: UsageModelSummary[];
}

export interface UsageDayAgentModel extends UsageTotals {
  model: string;
  company?: string;
}

export interface UsageDayAgent extends UsageTotals {
  agent: string;
  models: UsageDayAgentModel[];
}

export interface UsageDayPayload {
  date: string;
  totals: UsageTotals;
  agents: UsageDayAgent[];
}

export interface UsageModelPerDay {
  date: string;
  tokens: number;
  cost: number;
}

export interface UsageModelAgentTotals extends UsageTotals {
  agent: string;
}

export interface UsageModelPayload {
  model: string;
  company: string;
  totals: UsageTotals;
  lastUsed: string;
  agents: UsageModelAgentTotals[];
  perDay: UsageModelPerDay[];
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
  /** Built-in commands only: the id the phone translates; `description` is the English fallback. */
  descriptionId?: string;
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
  /** Whether `create_tab_and_agent` can start the agent on a chosen model (`protocol.md` §4.5). */
  launchModel: boolean;
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

export interface HaveInfo {
  sessionId: string;
  turnCount: number;
  lastTurnHash: string;
}

export function fnv1a32(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function hashTurn(turn: NormalizedTurn): string {
  return fnv1a32(JSON.stringify(turn));
}

// Client -> Server messages
export type ClientMessage =
  | { type: "hello"; id: string; payload: { protocolVersion: string; subscribePaneId?: string; have?: HaveInfo } }
  | { type: "ping"; timestamp?: number }
  | { type: "presence_update"; isVisible: boolean; viewingPaneId: string | null }
  | { type: "select_view"; id: string; payload: { paneId: string; have?: HaveInfo } }
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
  | { type: "queue_update"; id: string; payload: { targetPaneId: string; queueId: string; text: string; attachments?: string[] } }
  | { type: "models_refresh"; id: string; payload: Record<string, never> }
  | { type: "skills_get"; id: string }
  | { type: "config_get"; id: string }
  | { type: "config_patch"; id: string; payload: { client: Partial<ClientConfig> } }
  | { type: "quota_get"; id: string; payload?: { force?: boolean } }
  | { type: "usage_get"; id: string; payload: { preset: string; from?: string; to?: string; agents: string[]; force?: boolean } }
  | { type: "usage_day"; id: string; payload: { date: string; agents: string[] } }
  | { type: "usage_model"; id: string; payload: { model: string; from: string; to: string; agents: string[] } };

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
  | { type: "prompt_queue"; payload: PromptQueuePayload }
  | { type: "recipes_sync"; payload: { recipes: Record<string, AgentRecipeSummary> } };

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
