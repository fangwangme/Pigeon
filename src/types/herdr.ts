export interface HerdrRequest {
  id: string;
  method: string;
  params?: Record<string, any>;
}

export interface HerdrResponse<T = any> {
  id: string;
  result?: T;
  error?: {
    code: string;
    message: string;
    data?: any;
  };
}

export interface HerdrEvent<T = any> {
  event: string;
  params: T;
}

export interface HerdrWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id?: string;
  agent_status?: string;
  tabs?: HerdrTab[];
}

export interface HerdrTab {
  tab_id: string;
  number?: number;
  label?: string;
  workspace_id: string;
  focused?: boolean;
  panes?: HerdrPane[];
}

export interface HerdrPane {
  pane_id: string;
  tab_id: string;
  agent?: string;
  agent_status?: string;
  focused?: boolean;
  is_primary?: boolean;
  title?: string;
}

export interface HerdrSnapshotResult {
  type: "session_snapshot";
  snapshot: {
    version: string;
    protocol: number;
    focused_workspace_id: string;
    focused_tab_id: string;
    focused_pane_id: string;
    workspaces: HerdrWorkspace[];
    tabs?: HerdrTab[];
    panes?: HerdrPane[];
    working_agents?: any[];
  };
}
