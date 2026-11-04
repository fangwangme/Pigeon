// Subset of the Herdr App socket (`herdr-app commands`) and the Herdr Core API (`hc schema`)
// that Pigeon reads. Unknown fields are ignored.

/** App `ls`: one terminal in a tab. */
export interface HerdrAppTerminalRef {
  /** Core terminal address, e.g. `t1r`. */
  terminal: string;
  /** App pane id, e.g. `pa315…`. */
  pane: string;
  name?: string | null;
}

export interface HerdrAppTab {
  id: string;
  name: string;
  active: boolean;
  terminals: HerdrAppTerminalRef[];
}

export interface HerdrAppSpace {
  id: string;
  name: string;
  folder: string;
  active: boolean;
  tabs: HerdrAppTab[];
}

export interface HerdrAppLsResult {
  spaces: HerdrAppSpace[];
}

/** App `status`: what the window shows. */
export interface HerdrAppStatusResult {
  focused_pane?: string | null;
}

/** One OSC 7501 record, as the Core reports it. */
export interface HerdrCoreStatus {
  /** idle, working, done, blocked or error. */
  state: string;
  app?: string;
  msg?: string;
  title?: string;
}

export interface HerdrCoreTerminal {
  address: string;
  name?: string | null;
  cwd: string;
  state: "live" | "finished";
  foreground?: { cwd: string } | null;
  status?: HerdrCoreStatus | null;
  title?: string;
}

export interface HerdrCoreListResult {
  terminals: HerdrCoreTerminal[];
}

export interface HerdrCoreReadResult {
  text: string;
  /** "screen", "history", or "stitched" (a full-screen app, read by scrolling it). */
  how: string;
}

/** The three answers a snapshot joins (`herdr-adapter.md` §3.1). */
export interface HerdrTopology {
  ls: HerdrAppLsResult;
  status: HerdrAppStatusResult;
  terminals: HerdrCoreTerminal[];
}
