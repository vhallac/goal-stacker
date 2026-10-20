import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STORE_DIR = path.join(process.cwd(), ".goal-stacker");
const STORE_FILE = path.join(STORE_DIR, "store.jsonl");

/** Goal status per goal-tree-mvp.md §2.2. */
export type GoalStatus = "pending" | "active" | "expanded" | "done" | "dropped" | "failed" | "blocked";

/**
 * One durable goal record (§3). Root records have no `parent`.
 * `outcome` is set when an attempt ends (Slice 1: compact, unvalidated).
 */
export interface GoalRecord {
  kind: "goal";
  ts: string;
  sessionId: string | undefined;
  id: string;
  parent?: string;
  statement: string;
  done_when?: string;
  contributes?: string;
  origin: "prompt" | "expansion" | "addition";
  status: GoalStatus;
  selected?: boolean;
  outcome?: string;
  disposition?: "satisfied" | "failed" | "blocked";
}

/** The tree as derived from the record set: goals by id plus the active goal, if any. */
export interface GoalTree {
  goals: Map<string, GoalRecord>;
  rootId: string | undefined;
  activeGoal: GoalRecord | undefined;
  /** Children by parent id (last record per id wins). */
  children: Map<string, string[]>;
}

/** §2.2 invariant: at most one goal is active. Later records for an id supersede earlier ones. */
export function deriveTree(records: GoalRecord[]): GoalTree {
  const goals = new Map<string, GoalRecord>();
  let rootId: string | undefined;
  let activeGoal: GoalRecord | undefined;
  for (const rec of records) {
    if (rec.kind !== "goal") continue;
    const prev = goals.get(rec.id);
    if (prev && prev.origin === "prompt" && rootId === prev.id) rootId = undefined;
    goals.set(rec.id, rec);
    if (rec.origin === "prompt" && rootId === undefined) rootId = rec.id;
  }
  const children = new Map<string, string[]>();
  for (const rec of goals.values()) {
    if (rec.parent === undefined) continue;
    const list = children.get(rec.parent) ?? [];
    list.push(rec.id);
    children.set(rec.parent, list);
  }
  for (const rec of goals.values()) {
    if (rec.status === "active") {
      if (activeGoal !== undefined) {
        throw new Error(`store invariant violated: two active goals (${activeGoal.id}, ${rec.id})`);
      }
      activeGoal = rec;
    }
  }
  return { goals, rootId, activeGoal, children };
}

/** Full goal-record parse: a line is a record only if it parses and carries the §3 shape. */
export function parseRecordLine(line: string): GoalRecord | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.kind !== "goal") return undefined;
    if (typeof obj.id !== "string" || typeof obj.statement !== "string") return undefined;
    if (typeof obj.origin !== "string" || typeof obj.status !== "string") return undefined;
    return obj as unknown as GoalRecord;
  } catch {
    return undefined;
  }
}

export function readStoreRecords(file: string): GoalRecord[] {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map(parseRecordLine)
      .filter((r): r is GoalRecord => r !== undefined);
  } catch {
    return []; // 4.a.1 semantics: empty or unreadable store -> no tree
  }
}

export function appendRecord(file: string, rec: GoalRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
}

export function appendRecords(file: string, recs: GoalRecord[]): void {
  for (const rec of recs) appendRecord(file, rec);
}

let counter = 0;
function nextGoalId(ts: number): string {
  counter += 1;
  return `g${ts}-${counter}`;
}

// ── Transition layer (§4 operations, shared validation entry) ────────────────
// Pure: given the current record set and one operation, either return the
// transition records to append or a concise error. Nothing is appended on
// error, so an invalid call leaves the store byte-identical (1.a.1).

export type Disposition = "satisfied" | "failed" | "blocked";

export type GoalOperation =
  | { op: "goal_end_attempt"; disposition: Disposition; outcome: string }
  | { op: "goal_expand"; children: { statement: string; done_when?: string; contributes?: string }[]; findings?: string }
  | { op: "goal_select"; id: string }
  | { op: "goal_add_and_select"; parent: string; statement: string; done_when?: string; contributes?: string }
  | { op: "goal_drop"; id: string; reason: string }
  | { op: "goal_contract_children"; parent: string; verdict: Disposition; outcome: string }
  | { op: "goal_stop_work"; reason: string };

export type OperationResult =
  | { ok: true; transitions: GoalRecord[]; stopped?: string }
  | { ok: false; error: string };

function childRecord(base: Omit<GoalRecord, "kind" | "ts" | "sessionId" | "id" | "origin" | "status">, ts: number, sessionId: string | undefined): GoalRecord {
  return { kind: "goal", ts: new Date(ts).toISOString(), sessionId, id: nextGoalId(ts), origin: "expansion", status: "pending", ...base };
}

/**
 * Shared validation entry for all §4 operations. Enforces:
 * - phase (which operations are legal with/without an active goal);
 * - target validity (unknown ids, non-leaf/non-pending selects, non-pending drops);
 * - contract prerequisites (all children done or dropped);
 * - the at-most-one-active invariant (4.a) at the transition layer.
 */
export function applyOperation(records: GoalRecord[], operation: GoalOperation, sessionId: string | undefined): OperationResult {
  let tree: GoalTree;
  try {
    tree = deriveTree(records);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const ts = Date.now();
  const hasActive = tree.activeGoal !== undefined;
  const active = tree.activeGoal;
  const transition = (goal: GoalRecord, patch: Partial<GoalRecord>): GoalRecord => ({
    ...goal,
    ...patch,
    ts: new Date(ts).toISOString(),
  });

  switch (operation.op) {
    case "goal_end_attempt": {
      if (!hasActive) return { ok: false, error: "no active goal" };
      const status = operation.disposition === "satisfied" ? "done" : operation.disposition;
      return { ok: true, transitions: [transition(active!, { status, outcome: operation.outcome, selected: false, disposition: operation.disposition })] };
    }
    case "goal_expand": {
      if (!hasActive) return { ok: false, error: "no active goal" };
      if (operation.children.length === 0) return { ok: false, error: "goal_expand: children set is empty" };
      // Atomic: all children added or none (§4). Appended together with the parent transition.
      const kids = operation.children.map((c) =>
        childRecord({ parent: active!.id, statement: c.statement, done_when: c.done_when, contributes: c.contributes }, ts, sessionId),
      );
      const parent = transition(active!, { status: "expanded", selected: false, outcome: operation.findings });
      return { ok: true, transitions: [parent, ...kids] };
    }
    case "goal_select": {
      if (hasActive) return { ok: false, error: `a goal is already active (${active!.id})` };
      const goal = tree.goals.get(operation.id);
      if (goal === undefined) return { ok: false, error: `unknown goal id: ${operation.id}` };
      if (goal.status !== "pending") return { ok: false, error: `goal ${operation.id} is not pending (status: ${goal.status})` };
      if ((tree.children.get(goal.id) ?? []).length > 0) return { ok: false, error: `goal ${operation.id} is not a leaf` };
      return { ok: true, transitions: [transition(goal, { status: "active", selected: true })] };
    }
    case "goal_add_and_select": {
      if (hasActive) return { ok: false, error: `a goal is already active (${active!.id})` };
      const parent = tree.goals.get(operation.parent);
      if (parent === undefined) return { ok: false, error: `unknown goal id: ${operation.parent}` };
      if (parent.status === "done" || parent.status === "dropped") {
        return { ok: false, error: `parent ${operation.parent} is finished (${parent.status}); use an unfinished parent or start a new run` };
      }
      const child = childRecord(
        { parent: parent.id, statement: operation.statement, done_when: operation.done_when, contributes: operation.contributes },
        ts,
        sessionId,
      );
      child.origin = "addition";
      child.status = "active";
      child.selected = true;
      return { ok: true, transitions: [child] };
    }
    case "goal_drop": {
      if (hasActive) return { ok: false, error: `a goal is already active (${active!.id})` };
      const goal = tree.goals.get(operation.id);
      if (goal === undefined) return { ok: false, error: `unknown goal id: ${operation.id}` };
      if (goal.status !== "pending") return { ok: false, error: `goal ${operation.id} is not pending (status: ${goal.status})` };
      return { ok: true, transitions: [transition(goal, { status: "dropped", outcome: operation.reason })] };
    }
    case "goal_contract_children": {
      if (hasActive) return { ok: false, error: `a goal is already active (${active!.id})` };
      const parent = tree.goals.get(operation.parent);
      if (parent === undefined) return { ok: false, error: `unknown goal id: ${operation.parent}` };
      const kidIds = tree.children.get(parent.id) ?? [];
      if (kidIds.length === 0) return { ok: false, error: `parent ${parent.id} has no children to contract` };
      const unfinished = kidIds.filter((id) => {
        const s = tree.goals.get(id)?.status;
        return s !== "done" && s !== "dropped";
      });
      if (unfinished.length > 0) {
        return { ok: false, error: `children of ${parent.id} are not all done or dropped: ${unfinished.join(", ")}` };
      }
      const status = operation.verdict === "satisfied" ? "done" : "failed";
      return { ok: true, transitions: [transition(parent, { status, outcome: operation.outcome, disposition: operation.verdict, selected: false })] };
    }
    case "goal_stop_work": {
      const rootDone = tree.rootId !== undefined && tree.goals.get(tree.rootId)?.status === "done";
      if (rootDone) return { ok: true, transitions: [] };
      // 3.a.1: run stops with the reason visible in the result.
      return { ok: true, transitions: [], stopped: operation.reason };
    }
  }
}

/**
 * Root-goal creation (§2.1): if the session's store has no tree, record a full
 * §3 root goal from the verbatim prompt — origin=prompt, status=active,
 * selected — and select it. A later before_agent_start in the same session
 * appends no duplicate root.
 */
export function ensureRoot(records: GoalRecord[], prompt: string, sessionId: string | undefined, file: string): GoalRecord | undefined {
  const tree = deriveTree(records);
  if (tree.rootId !== undefined) return undefined; // tree exists -> no duplicate root
  const rec: GoalRecord = {
    kind: "goal",
    ts: new Date().toISOString(),
    sessionId,
    id: nextGoalId(Date.now()),
    statement: prompt,
    origin: "prompt",
    status: "active",
    selected: true,
  };
  appendRecord(file, rec);
  return rec;
}

export default function goalStacker(pi: ExtensionAPI) {
  const log = (line: string) => console.error(`[goal-stacker] ${line}`);

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt;
    const sessionId = ctx.sessionManager.getSessionId();

    const rec = ensureRoot(readStoreRecords(STORE_FILE), prompt, sessionId, STORE_FILE);
    if (rec) {
      log(`root goal created: ${rec.id} — ${rec.statement.slice(0, 80)}`);
    }
    // No injection yet — state-view rendering and injection is #13, not this slice.
  });
}
