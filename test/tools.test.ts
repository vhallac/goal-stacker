import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeOperation, ensureRoot, goalTools, readStoreRecords, deriveTree, type GoalOperation, type GoalRecord } from "../src/extension.js";

// Behavior under test (issue #10 use case steps 3–5, ext 1.a/2.b/3.a; §4):
// The seven goal_* tools route through the shared validation path; valid calls
// append their transition and report the applied tree state; invalid calls
// return a concise error and leave store.jsonl byte-identical; the stopping
// operations terminate the run with the reason visible.

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-stacker-tools-"));
  cwd = dir;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function storeBytes(): string {
  return fs.readFileSync(path.join(cwd, ".goal-stacker", "store.jsonl"), "utf8");
}

function run(op: GoalOperation, sessionId = "s1") {
  return executeOperation(cwd, sessionId, op);
}

function seedRoot(): GoalRecord {
  const rec = ensureRoot([], "demo prompt", "s1", path.join(cwd, ".goal-stacker", "store.jsonl"))!;
  expect(rec).toBeDefined();
  return rec;
}

describe("tool surface: the seven goal_* tools are defined", () => {
  it("registers exactly the seven tool names from the #10 table", () => {
    const names = goalTools().map((t) => t.name).sort();
    expect(names).toEqual([
      "goal_add_and_select",
      "goal_contract_children",
      "goal_drop",
      "goal_end_attempt",
      "goal_expand",
      "goal_select",
      "goal_stop_work",
    ]);
    for (const t of goalTools()) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.parameters).toBeDefined();
    }
  });
});

describe("valid calls append their transition and report the tree state (use case steps 3–5)", () => {
  it("goal_end_attempt: disposition and outcome recorded, no active goal remains", () => {
    const root = seedRoot();
    const res = run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "parsed the module" });
    expect(res.terminate).toBeUndefined();
    expect(res.content[0]).toMatchObject({ type: "text" });
    expect((res.content[0] as { text: string }).text).toContain("root goal is done");
    const tree = deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl")));
    expect(tree.activeGoal).toBeUndefined();
    expect(tree.goals.get(root.id)?.status).toBe("done");
    expect(tree.goals.get(root.id)?.outcome).toBe("parsed the module");
  });

  it("goal_expand: children atomically added under the active goal", () => {
    seedRoot();
    const res = run({ op: "goal_expand", children: [{ statement: "child a" }, { statement: "child b" }], findings: "split" });
    expect((res.content[0] as { text: string }).text).toContain("applied goal_expand");
    const tree = deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl")));
    expect(tree.children.get(tree.rootId!)).toHaveLength(2);
    expect(tree.activeGoal).toBeUndefined();
  });

  it("goal_select: pending leaf becomes active", () => {
    seedRoot();
    run({ op: "goal_expand", children: [{ statement: "child a" }] });
    const res = run({ op: "goal_select", id: deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl"))).children.get(deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl"))).rootId!)![0] });
    expect((res.content[0] as { text: string }).text).toContain("active:");
    const tree = deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl")));
    expect(tree.activeGoal?.status).toBe("active");
  });

  it("goal_add_and_select: adds a pending child under an unfinished parent and activates it", () => {
    const root = seedRoot();
    run({ op: "goal_expand", children: [{ statement: "sibling a" }] });
    const res = run({ op: "goal_add_and_select", parent: root.id, statement: "follow-up child" });
    expect((res.content[0] as { text: string }).text).toContain("active:");
    const tree = deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl")));
    const kids = tree.children.get(root.id)!;
    expect(kids).toHaveLength(2);
    expect(tree.goals.get(kids[1])?.origin).toBe("addition");
    expect(tree.activeGoal?.id).toBe(kids[1]);
  });

  it("goal_drop: pending goal dropped with reason", () => {
    const root = seedRoot();
    run({ op: "goal_expand", children: [{ statement: "child a" }] });
    const kid = deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl"))).children.get(root.id)![0];
    const res = run({ op: "goal_drop", id: kid, reason: "no longer needed" });
    expect((res.content[0] as { text: string }).text).toContain("applied goal_drop");
    const tree = deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl")));
    expect(tree.goals.get(kid)?.status).toBe("dropped");
  });

  it("goal_contract_children satisfied: parent becomes done (2.a.1)", () => {
    const root = seedRoot();
    run({ op: "goal_expand", children: [{ statement: "child a" }] });
    const kid = deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl"))).children.get(root.id)![0];
    run({ op: "goal_select", id: kid });
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "child done" });
    const res = run({ op: "goal_contract_children", parent: root.id, verdict: "satisfied", outcome: "all children collected" });
    expect((res.content[0] as { text: string }).text).toContain("applied goal_contract_children");
    const tree = deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl")));
    expect(tree.goals.get(root.id)?.status).toBe("done");
  });
});

describe("invalid calls return a concise error and leave the store byte-identical (1.a.1)", () => {
  it("goal_select on unknown id", () => {
    seedRoot();
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "done" });
    const before = storeBytes();
    const res = run({ op: "goal_select", id: "g-nope" });
    expect((res.content[0] as { text: string }).text).toContain("error: unknown goal id");
    expect(storeBytes()).toBe(before);
  });

  it("goal_select on a non-leaf goal", () => {
    const root = seedRoot();
    run({ op: "goal_expand", children: [{ statement: "child a" }] });
    // give the child its own child, making it a non-leaf
    run({ op: "goal_add_and_select", parent: deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl"))).children.get(root.id)![0], statement: "grand" });
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "done" });
    const before = storeBytes();
    const mid = deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl"))).children.get(root.id)![0];
    const res = run({ op: "goal_select", id: mid });
    expect((res.content[0] as { text: string }).text).toContain("error:");
    expect(storeBytes()).toBe(before);
  });

  it("goal_expand ends the attempt: after expanding, no goal is active and further expands are invalid (§2.4, §4)", () => {
    seedRoot();
    run({ op: "goal_expand", children: [{ statement: "child a" }] });
    const before = storeBytes();
    const res = run({ op: "goal_expand", children: [{ statement: "x" }] });
    expect((res.content[0] as { text: string }).text).toContain("error:");
    expect(storeBytes()).toBe(before);
  });

  it("goal_contract_children with unfinished children", () => {
    const root = seedRoot();
    run({ op: "goal_expand", children: [{ statement: "child a" }, { statement: "child b" }] });
    const before = storeBytes();
    const res = run({ op: "goal_contract_children", parent: root.id, verdict: "satisfied", outcome: "premature" });
    expect((res.content[0] as { text: string }).text).toContain("error:");
    expect(storeBytes()).toBe(before);
  });

  it("goal_drop on a non-pending goal", () => {
    const root = seedRoot();
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "done" });
    const before = storeBytes();
    const res = run({ op: "goal_drop", id: root.id, reason: "why" });
    expect((res.content[0] as { text: string }).text).toContain("error:");
    expect(storeBytes()).toBe(before);
  });
});

describe("run-stop semantics (2.b.1, 3.a.1)", () => {
  it("goal_stop_work with root not done: run stops with the reason visible", () => {
    seedRoot();
    const res = run({ op: "goal_stop_work", reason: "operator asked to stop" });
    expect((res.content[0] as { text: string }).text).toContain("operator asked to stop");
    expect(res.terminate).toBe(true);
  });

  it("goal_stop_work with root done: successful stop, no terminate", () => {
    seedRoot();
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "all done" });
    const res = run({ op: "goal_stop_work", reason: "finished" });
    expect(res.terminate).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toContain("root goal is done");
  });

  it("goal_contract_children failed verdict: parent failed and the result signals stop (2.b.1)", () => {
    const root = seedRoot();
    run({ op: "goal_expand", children: [{ statement: "child a" }] });
    const kid = deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl"))).children.get(root.id)![0];
    run({ op: "goal_drop", id: kid, reason: "not needed" });
    const res = run({ op: "goal_contract_children", parent: root.id, verdict: "failed", outcome: "children do not cover the parent" });
    expect(res.terminate).toBe(true);
    const tree = deriveTree(readStoreRecords(path.join(cwd, ".goal-stacker", "store.jsonl")));
    expect(tree.goals.get(root.id)?.status).toBe("failed");
  });
});
