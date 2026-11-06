import type { PastSession } from "../../types/protocol";
import type { SessionRead } from "./common";

/** What Herdr Core reports about a pane, used to find its session (`agent-session-normalization.md` §2.0). */
export interface PaneFacts {
  agent: string;
  pid: number | null;
  cwd: string | null;
  createdMs: number;
}

/** One agent's session store. */
export interface SessionSource {
  readonly agent: string;
  /** Rule 1: the exact session from the process, when the agent records one. */
  exact?(facts: PaneFacts): string | null;
  /** Rule 2: the newest session of the folder written since the terminal started, skipping `exclude`. */
  newest(facts: PaneFacts, exclude: Set<string>): string | null;
  /** The file whose changes mean new records. */
  watchPath(sessionId: string): string | null;
  read(sessionId: string, incremental: boolean): SessionRead;
  /** Drops incremental state for a session that is no longer bound. */
  forget(sessionId: string): void;
  /** `agent-session-normalization.md` §2.6. */
  list(folder: string): PastSession[];
  /** The value the recipe's resume argument takes (a file path for pi), or null when unknown. */
  resumeTarget?(sessionId: string, folder: string): string | null;
}
