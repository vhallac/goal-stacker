/** Minimal goal record schema — design/requirements/goal-tree-mvp.md §3. */

export type GoalOrigin = "prompt" | "expansion" | "explicit_add";

export type GoalStatus =
  | "pending"
  | "active"
  | "expanded"
  | "done"
  | "dropped"
  | "failed"
  | "blocked";

export interface GoalRecord {
  /** Stable, runtime-assigned identifier; never reused or renumbered. */
  id: string;
  /** Parent goal ID; absent for the root. */
  parent?: string;
  /** Concise description of the work. The root preserves the user's prompt verbatim. */
  statement: string;
  /** Optional observable completion conditions. */
  done_when?: string;
  /** For children: what this goal contributes to its parent. */
  contributes?: string;
  /** Where the goal came from. */
  origin: GoalOrigin;
  status: GoalStatus;
  /** Compact report recorded when the attempt ends. */
  outcome?: string;
}

export interface NewGoal {
  parent?: string;
  statement: string;
  done_when?: string;
  contributes?: string;
  origin: GoalOrigin;
  status?: GoalStatus;
  outcome?: string;
}
