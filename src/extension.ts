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
}

/** §2.2 invariant: at most one goal is active. */
export function deriveTree(records: GoalRecord[]): GoalTree {
  const goals = new Map<string, GoalRecord>();
  let rootId: string | undefined;
  let activeGoal: GoalRecord | undefined;
  for (const rec of records) {
    if (rec.kind !== "goal") continue;
    goals.set(rec.id, rec);
    if (rec.origin === "prompt" && rootId === undefined) rootId = rec.id;
    if (rec.status === "active") {
      if (activeGoal !== undefined) {
        throw new Error(`store invariant violated: two active goals (${activeGoal.id}, ${rec.id})`);
      }
      activeGoal = rec;
    }
  }
  return { goals, rootId, activeGoal };
}

export function readStoreRecords(file: string): GoalRecord[] {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as GoalRecord);
  } catch {
    return []; // 4.a.1 semantics: empty or unreadable store -> no tree
  }
}

export function appendRecord(file: string, rec: GoalRecord): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
}

let counter = 0;
function nextGoalId(ts: number): string {
  counter += 1;
  return `g${ts}-${counter}`;
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
