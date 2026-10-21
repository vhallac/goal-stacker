import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Partial node:fs mock: pass everything through, but observe fsyncSync.
const fsyncSpy = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const patched = { ...actual, fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => fsyncSpy(...args) };
  return { ...patched, default: patched };
});
import * as os from "node:os";
import * as path from "node:path";
import { appendRecord } from "../src/extension.js";
import { applyOperation, deriveTree, parseRecordLine, type GoalRecord } from "../src/extension.js";

// Behavior under test (goal-tree-mvp.md §2.2, §4; issue #10 ext 1.a/2.a/2.b/4.a):
// Store transitions validate the operation, enforce the at-most-one-active
// invariant at the transition layer, and append nothing on invalid calls.

const ts = new Date().toISOString();
function rec(partial: Partial<GoalRecord> & { id: string; origin: GoalRecord["origin"]; status: GoalRecord["status"] }): GoalRecord {
  return { kind: "goal", ts, sessionId: "s", id: partial.id, ...partial };
}
function root(): GoalRecord[] {
  return [rec({ id: "g-root", origin: "prompt", status: "active", selected: true, statement: "root" })];
}
const activeTransition = (records: GoalRecord[], id: string, status: GoalRecord["status"]): GoalRecord[] => [
  { ...records.find((r) => r.id === id)!, ts, status },
];

describe("appendRecord durability (review F4)", () => {
  // Weak inspection (per plan): the fsync call is observed at the node:fs
  // seam — the fsync-before-resolve ordering itself is what fsyncSync on the
  // open fd guarantees by contract.
  let dir: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appendRecord fsyncs the store fd before returning", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-stacker-fsync-"));
    const file = path.join(dir, "sub", "store.jsonl");
    const spy = fsyncSpy;
    spy.mockClear();

    appendRecord(file, rec({ id: "g-1", origin: "prompt", status: "active", statement: "x" }));

    expect(spy).toHaveBeenCalled();
    // The record is intact after the durable append.
    expect(fs.readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(1);
  });
});

describe("store transitions: phase and target validation (ext 1.a)", () => {
  it("end_attempt with no active goal is invalid, no transitions", () => {
    const records = [rec({ id: "g-root", origin: "prompt", status: "done", statement: "root" })];
    const res = applyOperation(records, { op: "goal_end_attempt", disposition: "satisfied", outcome: "x" }, "s");
    expect(res).toEqual({ ok: false, error: "no active goal" });
  });

  it("select on unknown id is invalid", () => {
    const res = applyOperation([], { op: "goal_select", id: "g-nope" }, "s");
    expect(res).toEqual({ ok: false, error: "unknown goal id: g-nope" });
  });

  it("select on a non-pending goal is invalid", () => {
    const records = [rec({ id: "g-root", origin: "prompt", status: "done", statement: "root" })];
    const res = applyOperation(records, { op: "goal_select", id: "g-root" }, "s");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("not pending");
  });

  it("select on a non-leaf pending goal is invalid", () => {
    const records = [
      rec({ id: "g-root", origin: "prompt", status: "expanded", statement: "root" }),
      rec({ id: "g-child", parent: "g-root", origin: "expansion", status: "pending", statement: "child" }),
      rec({ id: "g-grand", parent: "g-child", origin: "expansion", status: "pending", statement: "grand" }),
    ];
    const res = applyOperation(records, { op: "goal_select", id: "g-child" }, "s");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("not a leaf");
  });

  it("drop on a non-pending goal is invalid", () => {
    const records = [rec({ id: "g-root", origin: "prompt", status: "done", statement: "root" })];
    const res = applyOperation(records, { op: "goal_drop", id: "g-root", reason: "why" }, "s");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("not pending");
  });
});

describe("store transitions: at-most-one-active invariant (ext 4.a)", () => {
  it("select while a goal is active is rejected as invalid", () => {
    const res = applyOperation(root(), { op: "goal_select", id: "g-root" }, "s");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("already active");
  });

  it("add_and_select while a goal is active is rejected as invalid", () => {
    const res = applyOperation(root(), { op: "goal_add_and_select", parent: "g-root", statement: "x" }, "s");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("already active");
  });

  it("drop while a goal is active is rejected as invalid", () => {
    const res = applyOperation(root(), { op: "goal_drop", id: "g-root", reason: "why" }, "s");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("already active");
  });

  it("expand with an empty children set is invalid", () => {
    const res = applyOperation(root(), { op: "goal_expand", children: [] }, "s");
    expect(res).toEqual({ ok: false, error: "goal_expand: children set is empty" });
  });
});

describe("store transitions: valid operations produce transitions", () => {
  it("goal_end_attempt satisfied: active goal becomes done, deselected, outcome recorded (§4, step 3)", () => {
    const res = applyOperation(root(), { op: "goal_end_attempt", disposition: "satisfied", outcome: "parsed the module" }, "s");
    expect(res.ok).toBe(true);
    const t = (res as { ok: true; transitions: GoalRecord[] }).transitions;
    expect(t).toHaveLength(1);
    expect(t[0].id).toBe("g-root");
    expect(t[0].status).toBe("done");
    expect(t[0].outcome).toBe("parsed the module");
    expect(t[0].selected).toBe(false);
    // Derived tree after applying the transition: no active goal remains.
    const tree = deriveTree([...root(), ...t]);
    expect(tree.activeGoal).toBeUndefined();
  });

  it("goal_expand adds all children atomically, pending, under the active goal (§4, step 4)", () => {
    const res = applyOperation(
      root(),
      {
        op: "goal_expand",
        children: [
          { statement: "child a", done_when: "a done" },
          { statement: "child b", contributes: "parses faster" },
        ],
        findings: "split needed",
      },
      "s",
    );
    expect(res.ok).toBe(true);
    const t = (res as { ok: true; transitions: GoalRecord[] }).transitions;
    expect(t).toHaveLength(3); // parent transition + 2 children
    expect(t[0].id).toBe("g-root");
    expect(t[0].status).toBe("expanded");
    const kids = t.slice(1);
    for (const k of kids) {
      expect(k.parent).toBe("g-root");
      expect(k.status).toBe("pending");
      expect(k.origin).toBe("expansion");
      expect(k.selected).toBeUndefined();
    }
    const tree = deriveTree([...root(), ...t]);
    expect(tree.activeGoal).toBeUndefined();
    expect(tree.children.get("g-root")).toHaveLength(2);
  });

  it("goal_select on a pending leaf activates it (§4, no-active phase)", () => {
    const records = [
      rec({ id: "g-root", origin: "prompt", status: "expanded", statement: "root" }),
      rec({ id: "g-child", parent: "g-root", origin: "expansion", status: "pending", statement: "child" }),
    ];
    const res = applyOperation(records, { op: "goal_select", id: "g-child" }, "s");
    expect(res.ok).toBe(true);
    const t = (res as { ok: true; transitions: GoalRecord[] }).transitions;
    expect(t[0].status).toBe("active");
    expect(t[0].selected).toBe(true);
    expect(deriveTree([...records, ...t]).activeGoal?.id).toBe("g-child");
  });

  it("goal_add_and_select adds one active child under an unfinished parent (§4)", () => {
    const records = [rec({ id: "g-root", origin: "prompt", status: "expanded", statement: "root" })];
    const res = applyOperation(
      records,
      { op: "goal_add_and_select", parent: "g-root", statement: "added child", contributes: "covers parent" },
      "s",
    );
    expect(res.ok).toBe(true);
    const t = (res as { ok: true; transitions: GoalRecord[] }).transitions;
    expect(t).toHaveLength(1);
    expect(t[0].parent).toBe("g-root");
    expect(t[0].origin).toBe("addition");
    expect(t[0].status).toBe("active");
    expect(t[0].selected).toBe(true);
  });

  it("goal_add_and_select on a finished parent is invalid (§2.6: no silent attach)", () => {
    const records = [rec({ id: "g-root", origin: "prompt", status: "done", statement: "root" })];
    const res = applyOperation(records, { op: "goal_add_and_select", parent: "g-root", statement: "x" }, "s");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("finished");
  });

  it("goal_drop marks a pending goal dropped (§4)", () => {
    const records = [
      rec({ id: "g-root", origin: "prompt", status: "expanded", statement: "root" }),
      rec({ id: "g-child", parent: "g-root", origin: "expansion", status: "pending", statement: "child" }),
    ];
    const res = applyOperation(records, { op: "goal_drop", id: "g-child", reason: "no longer needed" }, "s");
    expect(res.ok).toBe(true);
    const t = (res as { ok: true; transitions: GoalRecord[] }).transitions;
    expect(t[0].status).toBe("dropped");
  });

  it("goal_contract_children satisfied: parent becomes done (ext 2.a)", () => {
    const records = [
      rec({ id: "g-root", origin: "prompt", status: "expanded", statement: "root" }),
      rec({ id: "g-a", parent: "g-root", origin: "expansion", status: "done", statement: "a" }),
      rec({ id: "g-b", parent: "g-root", origin: "expansion", status: "dropped", statement: "b" }),
    ];
    const res = applyOperation(records, { op: "goal_contract_children", parent: "g-root", verdict: "satisfied", outcome: "covered" }, "s");
    expect(res.ok).toBe(true);
    const t = (res as { ok: true; transitions: GoalRecord[] }).transitions;
    expect(t[0].status).toBe("done");
  });

  it("goal_contract_children not satisfied: parent becomes failed (ext 2.b)", () => {
    const records = [
      rec({ id: "g-root", origin: "prompt", status: "expanded", statement: "root" }),
      rec({ id: "g-a", parent: "g-root", origin: "expansion", status: "done", statement: "a" }),
    ];
    const res = applyOperation(records, { op: "goal_contract_children", parent: "g-root", verdict: "failed", outcome: "gap found" }, "s");
    expect(res.ok).toBe(true);
    const t = (res as { ok: true; transitions: GoalRecord[] }).transitions;
    expect(t[0].status).toBe("failed");
  });

  it("goal_contract_children with unfinished children is invalid (§2.6)", () => {
    const records = [
      rec({ id: "g-root", origin: "prompt", status: "expanded", statement: "root" }),
      rec({ id: "g-a", parent: "g-root", origin: "expansion", status: "pending", statement: "a" }),
    ];
    const res = applyOperation(records, { op: "goal_contract_children", parent: "g-root", verdict: "satisfied", outcome: "x" }, "s");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("not all done or dropped");
  });

  it("goal_stop_work with root done: no transitions, no stop", () => {
    const records = [rec({ id: "g-root", origin: "prompt", status: "done", statement: "root" })];
    const res = applyOperation(records, { op: "goal_stop_work", reason: "all done" }, "s");
    expect(res).toEqual({ ok: true, op: "goal_stop_work", transitions: [] });
  });

  it("goal_stop_work with root not done: run stops, reason carried (ext 3.a)", () => {
    const res = applyOperation(root(), { op: "goal_stop_work", reason: "operator ended the session" }, "s");
    expect(res).toEqual({ ok: true, op: "goal_stop_work", transitions: [], stopped: "operator ended the session" });
  });
});

describe("deriveTree rootId derivation (review F2)", () => {
  it("rootId survives when the root id's latest record is not prompt-origin (no duplicate root)", () => {
    // Hand-written store: root appended, then the same id re-recorded with a
    // non-prompt origin. The superseded prompt record still anchors the root.
    const records = [
      rec({ id: "g-root", origin: "prompt", status: "active", selected: true, statement: "root" }),
      rec({ id: "g-root", origin: "expansion", status: "active", statement: "root" }),
    ];
    expect(deriveTree(records).rootId).toBe("g-root");
  });

  it("latest prompt-origin record wins among distinct prompt records", () => {
    const records = [
      rec({ id: "g-old", origin: "prompt", status: "done", statement: "old" }),
      rec({ id: "g-new", origin: "prompt", status: "active", selected: true, statement: "new" }),
    ];
    expect(deriveTree(records).rootId).toBe("g-new");
  });

  it("no prompt-origin record: rootId undefined, ensureRoot may create the root", () => {
    const records = [rec({ id: "g-x", origin: "expansion", status: "pending", statement: "x" })];
    expect(deriveTree(records).rootId).toBeUndefined();
  });
});

it("top-level await import", async () => { await import("vitest"); });
describe("store record parsing (§3 generalized records)", () => {
  it("non-goal lines and malformed lines are skipped by read-side parse", () => {
    expect(parseRecordLine('{"kind":"goal","id":"g1","statement":"s","origin":"prompt","status":"active"}')).toBeDefined();
    expect(parseRecordLine('{"kind":"other"}')).toBeUndefined();
    expect(parseRecordLine("not json")).toBeUndefined();
    expect(parseRecordLine('{"kind":"goal"}')).toBeUndefined(); // missing required fields
  });
});
