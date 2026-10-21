import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Session-scoped store path (review F1): one file per session under the cwd. */
export function storeFileFor(cwd: string, sessionId: string | undefined): string {
  // Path-safe name: sessions are uuid-like, but never trust the id as a path component.
  const name = (sessionId ?? "default").replace(/[^A-Za-z0-9_-]/g, "_") || "default";
  return path.join(cwd, ".goal-stacker", `${name}.jsonl`);
}

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
  // Collapse to the latest record per id first (F2): rootId is derived from the
  // collapsed map, not the raw stream, so a superseded prompt-origin record can
  // never unset the root or let ensureRoot append a duplicate root. Among
  // distinct prompt-origin records, the latest one wins.
  const latest = new Map<string, GoalRecord>();
  let latestPrompt: GoalRecord | undefined;
  for (const rec of records) {
    if (rec.kind !== "goal") continue;
    if (rec.origin === "prompt") latestPrompt = rec;
    latest.set(rec.id, rec);
  }
  const goals = latest;
  const rootId = latestPrompt?.id;
  let activeGoal: GoalRecord | undefined;
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
  // Durability (review F4): open in append mode, write, then fsync before
  // resolving so a crash or power loss cannot leave a torn/lost line.
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, JSON.stringify(rec) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function appendRecords(file: string, recs: GoalRecord[]): void {
  for (const rec of recs) appendRecord(file, rec);
}

/**
 * R2.F1 (delete-on-root-completion): when the root goal is done, return the
 * compacted record set — every record belonging to the completed root's goal
 * tree is rewritten out except a single terminal completion record for the
 * root itself; all other goals' records (e.g. another root sharing the file)
 * are preserved untouched. Returns undefined when no compaction is due.
 */
export function compactedRecords(records: GoalRecord[]): GoalRecord[] | undefined {
  let tree: GoalTree;
  try {
    tree = deriveTree(records);
  } catch {
    return undefined; // compaction never runs on an inconsistent store
  }
  if (tree.rootId === undefined) return undefined;
  if (tree.goals.get(tree.rootId)?.status !== "done") return undefined;
  const inTree = new Set<string>([tree.rootId]);
  const stack = [tree.rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const c of tree.children.get(id) ?? []) {
      if (!inTree.has(c)) {
        inTree.add(c);
        stack.push(c);
      }
    }
  }
  const out: GoalRecord[] = [];
  for (const rec of records) {
    if (rec.id === tree.rootId) {
      if (rec.status === "done") out.push(rec); // terminal completion record
      continue;
    }
    if (inTree.has(rec.id)) continue;
    out.push(rec);
  }
  return out;
}

/**
 * Durable rewrite-once-on-completion (R2.F1): write the compacted set to a
 * temp file, fsync it, then rename over the store — a crash leaves either the
 * old or the new file, never a torn one. After the rename the containing
 * directory is fsynced too (R3.F1), so the rename itself is durable, not
 * only the file contents.
 */
export function rewriteStore(file: string, records: GoalRecord[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : ""));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const dirFd = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
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
  | { ok: true; op: GoalOperation["op"]; transitions: GoalRecord[]; stopped?: string }
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
      return { ok: true, op: operation.op, transitions: [transition(active!, { status, outcome: operation.outcome, selected: false, disposition: operation.disposition })] };
    }
    case "goal_expand": {
      if (!hasActive) return { ok: false, error: "no active goal" };
      if (operation.children.length === 0) return { ok: false, error: "goal_expand: children set is empty" };
      // Atomic: all children added or none (§4). Appended together with the parent transition.
      const kids = operation.children.map((c) =>
        childRecord({ parent: active!.id, statement: c.statement, done_when: c.done_when, contributes: c.contributes }, ts, sessionId),
      );
      const parent = transition(active!, { status: "expanded", selected: false, outcome: operation.findings });
      return { ok: true, op: operation.op, transitions: [parent, ...kids] };
    }
    case "goal_select": {
      if (hasActive) return { ok: false, error: `a goal is already active (${active!.id})` };
      const goal = tree.goals.get(operation.id);
      if (goal === undefined) return { ok: false, error: `unknown goal id: ${operation.id}` };
      if (goal.status !== "pending") return { ok: false, error: `goal ${operation.id} is not pending (status: ${goal.status})` };
      if ((tree.children.get(goal.id) ?? []).length > 0) return { ok: false, error: `goal ${operation.id} is not a leaf` };
      return { ok: true, op: operation.op, transitions: [transition(goal, { status: "active", selected: true })] };
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
      return { ok: true, op: operation.op, transitions: [child] };
    }
    case "goal_drop": {
      if (hasActive) return { ok: false, error: `a goal is already active (${active!.id})` };
      const goal = tree.goals.get(operation.id);
      if (goal === undefined) return { ok: false, error: `unknown goal id: ${operation.id}` };
      if (goal.status !== "pending") return { ok: false, error: `goal ${operation.id} is not pending (status: ${goal.status})` };
      return { ok: true, op: operation.op, transitions: [transition(goal, { status: "dropped", outcome: operation.reason })] };
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
      return { ok: true, op: operation.op, transitions: [transition(parent, { status, outcome: operation.outcome, disposition: operation.verdict, selected: false })] };
    }
    case "goal_stop_work": {
      const rootDone = tree.rootId !== undefined && tree.goals.get(tree.rootId)?.status === "done";
      if (rootDone) return { ok: true, op: operation.op, transitions: [] };
      // 3.a.1: run stops with the reason visible in the result.
      return { ok: true, op: operation.op, transitions: [], stopped: operation.reason };
    }
  }
}

/**
 * The tree-control operations available while no goal is active (issue #11 §2
 * step 4): the two ending operations are gone — the attempt has already ended.
 */
export const NO_ACTIVE_GOAL_BLOCK_OPERATIONS = [
  "goal_select",
  "goal_add_and_select",
  "goal_drop",
  "goal_contract_children",
  "goal_stop_work",
] as const;

/**
 * Phase-boundary block message template (issue #11 edge call): names the phase,
 * then one line per available tree-control operation. LLM-visible wording —
 * veto-able by the product owner; #13 aligns to whatever ships.
 */
export function phaseBlockMessage(): string {
  return [
    "blocked: no active goal — execution phase is closed until a goal is selected. Available tree-control operations:",
    ...NO_ACTIVE_GOAL_BLOCK_OPERATIONS.map((op) => `- ${op}`),
  ].join("\n");
}

/**
 * §6 state view (issue #13): a compact, derived-only rendering of the durable
 * tree for injection on every post-first invocation. Nothing here writes — the
 * store is never touched by rendering (R3.F3: rendering failure degrades to no
 * injection + log, never a write).
 */
export const STATE_VIEW_TYPE = "goal-stacker-state-view";

export function renderStateView(tree: GoalTree): string {
  const root = tree.rootId !== undefined ? tree.goals.get(tree.rootId) : undefined;
  if (root === undefined) throw new Error("no root goal in store");
  const lines: string[] = [];

  // Original root prompt, verbatim.
  lines.push(`root: ${root.statement}`);

  // Active goal and its ancestors, root first.
  const active = tree.activeGoal;
  if (active !== undefined) {
    const chain: GoalRecord[] = [active];
    let p = active.parent;
    while (p !== undefined) {
      const g = tree.goals.get(p);
      if (g === undefined) break;
      chain.unshift(g);
      p = g.parent;
    }
    for (const g of chain) lines.push(`active: ${g.id} (${g.status}) — ${g.statement}`);
  }

  // Pending goals available for selection.
  const pending = [...tree.goals.values()].filter((g) => g.status === "pending");
  if (pending.length > 0) {
    lines.push("pending:");
    for (const g of pending) lines.push(`- ${g.id}: ${g.statement}`);
  }

  // Completed-child outcomes (one line per outcome, never truncated away).
  const outcomes = [...tree.goals.values()].filter(
    (g) => g.parent !== undefined && g.outcome !== undefined && (g.status === "done" || g.status === "failed" || g.status === "dropped"),
  );
  if (outcomes.length > 0) {
    lines.push("outcomes:");
    for (const g of outcomes) lines.push(`- ${g.id} [${g.status}]: ${g.outcome}`);
  }

  // Phase and available operations (aligned with #11's phase messages).
  if (active !== undefined) {
    lines.push("phase: execution — ordinary task tools and the ending operations (goal_end_attempt, goal_expand) are available.");
  } else {
    lines.push(`phase: no active goal — execution is closed until a goal is selected. Available tree-control operations:`);
    for (const op of NO_ACTIVE_GOAL_BLOCK_OPERATIONS) lines.push(`- ${op}`);
  }
  return lines.join("\n");
}

/**
 * §6 injection (issue #13): render the current state via the #9 mechanism —
 * `before_agent_start` returns `{ message: { customType, content, display } }`.
 * Fail-open (R3.F3): any rendering failure degrades to no injection + log,
 * never a write; an empty/unreadable store (no tree) injects nothing.
 */
export function stateViewInjection(file: string): { message: { customType: string; content: string; display: boolean } } | undefined {
  const records = readStoreRecords(file);
  if (records.length === 0) return undefined; // empty or unreadable store -> no tree -> no injection (1.a)
  const content = renderStateView(deriveTree(records));
  return { message: { customType: STATE_VIEW_TYPE, content, display: true } };
}

/**
 * Phase-boundary gate (issue #11): derive the phase from the store —
 * never a stored flag — and with no active goal block every tool call that is
 * not one of the seven goal_* tools. Returns the block reason, or undefined
 * when the call may proceed (active goal: extension 1.a, no gating overhead;
 * goal_* tool: handled by #10's validation path).
 */
export function phaseBlockReason(cwd: string, sessionId: string | undefined, toolName: string): string | undefined {
  if (toolName.startsWith("goal_")) return undefined;
  // Fail-closed (PR !17 review F2): a store invariant violation must not throw
  // out of the rigid pi tool_call handler (pi's behavior on a throwing handler
  // is unspecified) — every ordinary call is blocked with the reason instead.
  let tree: GoalTree;
  try {
    tree = deriveTree(readStoreRecords(storeFileFor(cwd, sessionId)));
  } catch (err) {
    return `blocked: corrupt goal store — ${(err as Error).message}. Repair the store (e.g. goal_stop_work) before proceeding.`;
  }
  if (tree.activeGoal !== undefined) return undefined;
  return phaseBlockMessage();
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

// ── Tool layer (issue #10 tool surface; one shared validation path) ─────────

function toolResult(text: string, extra?: Partial<AgentToolResult<undefined>>): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, ...extra };
}

/**
 * Shared tool path: read the store, apply the operation through the one
 * validation entry, append the transitions only on success. Invalid calls
 * return a concise error and append nothing — the store stays byte-identical
 * (1.a.1, inherited from the pure transition layer).
 */
export function executeOperation(cwd: string, sessionId: string | undefined, operation: GoalOperation): AgentToolResult<undefined> {
  const file = storeFileFor(cwd, sessionId);
  const before = readStoreRecords(file);
  const res = applyOperation(before, operation, sessionId);
  if (!res.ok) return toolResult(`error: ${res.error}`);
  appendRecords(file, res.transitions);
  // F3: derive the result from the records we just appended (before +
  // transitions), not a racing re-read of the store file.
  const records = [...before, ...res.transitions];
  // R2.F1: root completion compacts the store — the completed root's records
  // are rewritten out, a terminal completion record is kept, and other goals'
  // records in the same file are untouched.
  const compact = compactedRecords(records);
  if (compact !== undefined) rewriteStore(file, compact);
  if (operation.op === "goal_stop_work") {
    if (res.stopped === undefined) return toolResult("work stopped: root goal is done");
    // 3.a.1: run stops with the reason visible in the result.
    return toolResult(`work stopped: ${res.stopped} (root goal is not done)`, { terminate: true });
  }
  // 2.b.1: contract verdict not satisfied — parent failed, run stops for inspection.
  if (operation.op === "goal_contract_children" && operation.verdict !== "satisfied") {
    return toolResult(`applied ${operation.op}: parent failed; run stops for inspection`, { terminate: true });
  }
  const tree = deriveTree(records);
  const parts: string[] = [];
  if (tree.activeGoal) parts.push(`active: ${tree.activeGoal.id} (${tree.activeGoal.status}) — ${tree.activeGoal.statement}`);
  else if (tree.rootId !== undefined && tree.goals.get(tree.rootId)?.status === "done") parts.push("root goal is done; run complete");
  else parts.push("no active goal");
  const pending = [...tree.goals.values()].filter((g) => g.status === "pending").map((g) => `${g.id}: ${g.statement}`);
  if (pending.length > 0) parts.push(`pending: ${pending.join("; ")}`);
  return toolResult(`applied ${operation.op}. ${parts.join(" | ")}`);
}

export interface GoalToolSpec { name: string; description: string; parameters: unknown; make: (params: Record<string, unknown>) => GoalOperation; }

interface GoalToolSchemas {
  goal_end_attempt: { disposition: Disposition; outcome: string };
  goal_expand: { children: { statement: string; done_when?: string; contributes?: string }[]; findings?: string };
  goal_select: { id: string };
  goal_add_and_select: { parent: string; statement: string; done_when?: string; contributes?: string };
  goal_drop: { id: string; reason: string };
  goal_contract_children: { parent: string; verdict: Disposition; outcome: string };
  goal_stop_work: { reason: string };
}

const dispositionSchema = Type.Union([Type.Literal("satisfied"), Type.Literal("failed"), Type.Literal("blocked")]);
const childSchema = Type.Object({ statement: Type.String(), done_when: Type.Optional(Type.String()), contributes: Type.Optional(Type.String()) });

/**
 * The seven goal_* tools (issue #10 tool-name table). Each has the same shape:
 * parameters per §4, execute routed through the shared validation path.
 */
export function goalTools(): GoalToolSpec[] {
  return [
    {
      name: "goal_end_attempt",
      description: "End the current attempt as satisfied, failed, or blocked, recording a compact outcome.",
      parameters: Type.Object({ disposition: dispositionSchema, outcome: Type.String() }),
      make: (p) => ({ op: "goal_end_attempt", ...p } as GoalOperation),
    },
    {
      name: "goal_expand",
      description: "Atomically add a non-empty set of pending children under the active goal, record findings, and end the attempt. All children or none.",
      parameters: Type.Object({ children: Type.Array(childSchema), findings: Type.Optional(Type.String()) }),
      make: (p) => ({ op: "goal_expand", ...p } as GoalOperation),
    },
    {
      name: "goal_select",
      description: "Select a pending leaf goal as the new active goal.",
      parameters: Type.Object({ id: Type.String() }),
      make: (p) => ({ op: "goal_select", ...p } as GoalOperation),
    },
    {
      name: "goal_add_and_select",
      description: "Atomically add one goal under an eligible unfinished parent and select it as active.",
      parameters: Type.Object({ parent: Type.String(), statement: Type.String(), done_when: Type.Optional(Type.String()), contributes: Type.Optional(Type.String()) }),
      make: (p) => ({ op: "goal_add_and_select", ...p } as GoalOperation),
    },
    {
      name: "goal_drop",
      description: "Drop a pending goal that is no longer needed; the reason states why the parent remains covered.",
      parameters: Type.Object({ id: Type.String(), reason: Type.String() }),
      make: (p) => ({ op: "goal_drop", ...p } as GoalOperation),
    },
    {
      name: "goal_contract_children",
      description: "Evaluate completed or dropped children against the parent goal. Parent becomes done only if the verdict is satisfied; otherwise failed and the run stops.",
      parameters: Type.Object({ parent: Type.String(), verdict: dispositionSchema, outcome: Type.String() }),
      make: (p) => ({ op: "goal_contract_children", ...p } as GoalOperation),
    },
    {
      name: "goal_stop_work",
      description: "End the run. A run is successful only if the root goal is done; otherwise the run stops with the reason visible.",
      parameters: Type.Object({ reason: Type.String() }),
      make: (p) => ({ op: "goal_stop_work", ...p } as GoalOperation),
    },
  ];
}

export default function goalStacker(pi: ExtensionAPI) {
  const log = (line: string) => console.error(`[goal-stacker] ${line}`);

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt;
    const sessionId = ctx.sessionManager.getSessionId();
    const file = storeFileFor(ctx.cwd, sessionId);

    const rec = ensureRoot(readStoreRecords(file), prompt, sessionId, file);
    if (rec) {
      log(`root goal created: ${rec.id} — ${rec.statement.slice(0, 80)}`);
      return undefined; // first invocation: the prompt itself opens the session
    }
    // §6 state view (issue #13): inject on every post-first invocation.
    try {
      return stateViewInjection(file);
    } catch (e) {
      // R3.F3: fail-open — no injection, log, never a write.
      log(`state-view rendering failed, injecting nothing: ${(e as Error).message}`);
      return undefined;
    }
  });

  // Phase boundary (issue #11): with no active goal, ordinary tools are
  // blocked with the phase message; goal_* tools pass through to #10's
  // validation path. Rigid pi tool_call contract, called directly — no wrapper.
  pi.on("tool_call", async (event, ctx) => {
    const reason = phaseBlockReason(ctx.cwd, ctx.sessionManager.getSessionId(), event.toolName);
    if (reason !== undefined) return { block: true, reason };
    return undefined;
  });

  for (const tool of goalTools()) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters as Parameters<typeof pi.registerTool>[0]["parameters"],
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return executeOperation(ctx.cwd, ctx.sessionManager.getSessionId(), tool.make(params as never));
      },
    });
  }
}
