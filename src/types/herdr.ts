// Subset of the Herdr socket API (`herdr api schema --json`) that Pigeon reads.

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrAgentSessionInfo {
  source: string;
  agent: string;
  kind: "id" | "path";
  value: string;
}

export interface HerdrWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: HerdrAgentStatus;
  tabs?: HerdrTab[];
}

export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: HerdrAgentStatus;
  panes?: HerdrPane[];
}

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent?: string | null;
  agent_status: HerdrAgentStatus;
  agent_session?: HerdrAgentSessionInfo | null;
  cwd?: string | null;
  title?: string | null;
  terminal_title?: string | null;
  revision: number;
}

export interface HerdrAgent {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string | null;
  name?: string | null;
  agent_status: HerdrAgentStatus;
  agent_session?: HerdrAgentSessionInfo | null;
  cwd?: string | null;
  terminal_title?: string | null;
}

export interface HerdrSnapshotResult {
  type?: "session_snapshot";
  snapshot: {
    version: string;
    protocol: number;
    focused_workspace_id?: string | null;
    focused_tab_id?: string | null;
    focused_pane_id?: string | null;
    workspaces: HerdrWorkspace[];
    tabs: HerdrTab[];
    panes: HerdrPane[];
    agents: HerdrAgent[];
  };
}
