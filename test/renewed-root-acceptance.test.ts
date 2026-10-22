import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  executeOperation,
  ensureRoot,
  deriveTree,
  readStoreRecords,
  phaseBlockReason,
  storeFileFor,
  type GoalOperation,
} from "../src/extension.js";

// Issue #21 acceptance: after a terminal root (done or failed), the next
// ordinary prompt starts a fresh root through the rigid input interface —
// before_agent_start (ensureRoot), tool_call (phaseBlockReason), and the
// goal tool execution path (executeOperation). The previous run's terminal
// record stays observable in the goal history.

let dir: string;
const SESSION = "s1";
const OLD_PROMPT = "refactor the parser module for speed";
const NEW_PROMPT = "write the benchmark suite";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-stacker-renewed-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function file(): string {
  return storeFileFor(dir, SESSION);
}

function run(op: GoalOperation) {
  return executeOperation(dir, SESSION, op);
}

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content[0]?.text ?? "";
}

function tree() {
  return deriveTree(readStoreRecords(file()));
}

// Drive a run to a done root end-to-end (issue #12 contract path).
function driveRunToDone(): string {
  const root = ensureRoot([], OLD_PROMPT, SESSION, file())!.id;
  run({
    op: "goal_expand",
    children: [{ statement: "profile the hot loop", done_when: "hot loop identified" }],
  });
  const [child] = tree().children.get(root)!;
  run({ op: "goal_select", id: child });
  run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "hot loop is in tokenize()" });
  run({ op: "goal_contract_children", parent: root, verdict: "satisfied", outcome: "profiling complete" });
  return root;
}

function driveRunToFailed(): string {
  const root = ensureRoot([], OLD_PROMPT, SESSION, file())!.id;
  run({ op: "goal_end_attempt", disposition: "failed", outcome: "parser cannot be salvaged" });
  return root;
}

describe("renewed root after a terminal run (issue #21 acceptance)", () => {
  it("done root: next prompt starts a fresh run; gate open; tree ops succeed; old terminal record observable", () => {
    const oldRoot = driveRunToDone();
    // Compacted single terminal record shape.
    expect(readStoreRecords(file())).toHaveLength(1);
    expect(tree().goals.get(oldRoot)?.status).toBe("done");
    expect(tree().activeGoal).toBeUndefined();

    // Next ordinary prompt: before_agent_start starts a fresh root.
    const rec = ensureRoot(readStoreRecords(file()), NEW_PROMPT, SESSION, file());
    expect(rec).toBeDefined();
    expect(rec!.origin).toBe("prompt");
    expect(rec!.status).toBe("active");
    expect(rec!.selected).toBe(true);
    expect(rec!.statement).toBe(NEW_PROMPT);
    // Previous run's terminal completion record retained (append-only store).
    const records = readStoreRecords(file());
    expect(records.filter((r) => r.id === oldRoot && r.status === "done")).toHaveLength(1);

    // Ordinary tools are no longer phase-blocked.
    expect(phaseBlockReason(dir, SESSION, "read")).toBeUndefined();
    expect(phaseBlockReason(dir, SESSION, "bash")).toBeUndefined();

    // Tree operations succeed end-to-end under the new root.
    expect(text(run({ op: "goal_expand", children: [{ statement: "pick a benchmark harness", done_when: "harness chosen" }] })))
      .toContain("applied goal_expand");
    const newRoot = tree().rootId!;
    expect(newRoot).not.toBe(oldRoot);
    const [child] = tree().children.get(newRoot)!;
    run({ op: "goal_select", id: child });
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "vitest bench chosen" });
    const res = run({ op: "goal_contract_children", parent: newRoot, verdict: "satisfied", outcome: "benchmarking set up" });
    expect(text(res)).toContain("applied goal_contract_children");
    expect(tree().goals.get(newRoot)?.status).toBe("done");

    // Both runs' terminal records remain observable in the goal history.
    const finalRecords = readStoreRecords(file());
    const terminalRoots = finalRecords.filter((r) => r.parent === undefined && (r.status === "done" || r.status === "failed"));
    expect(terminalRoots.map((r) => r.id)).toContain(oldRoot);
    expect(terminalRoots.map((r) => r.id)).toContain(newRoot);
  });

  it("failed root: next prompt starts a fresh run; gate open; old failed record observable", () => {
    const oldRoot = driveRunToFailed();
    // Failed roots are not compacted — full record set remains.
    expect(tree().goals.get(oldRoot)?.status).toBe("failed");
    expect(tree().activeGoal).toBeUndefined();

    const rec = ensureRoot(readStoreRecords(file()), NEW_PROMPT, SESSION, file());
    expect(rec).toBeDefined();
    expect(rec!.origin).toBe("prompt");
    expect(rec!.status).toBe("active");

    // Ordinary tools are no longer phase-blocked.
    expect(phaseBlockReason(dir, SESSION, "edit")).toBeUndefined();

    // Tree operations succeed under the new root.
    expect(text(run({ op: "goal_expand", children: [{ statement: "attempt a rewrite", done_when: "rewrite landed" }] })))
      .toContain("applied goal_expand");
    const newRoot = tree().rootId!;
    expect(newRoot).not.toBe(oldRoot);
    // The old run's failed terminal record is still observable.
    expect(readStoreRecords(file()).filter((r) => r.id === oldRoot && r.status === "failed")).toHaveLength(1);
  });
});
