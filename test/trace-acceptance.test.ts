import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeOperation, storeFileFor, ensureRoot, deriveTree, readStoreRecords, type GoalOperation } from "../src/extension.js";

// Scripted-trace acceptance (issue #10 acceptance condition, §7.4/§7.5 spirit
// at unit level): one fixed demo prompt drives the whole tool surface. After
// every step: the root statement is still the prompt verbatim; at most one
// active goal exists; expand/end_attempt transitions are recorded in the
// store; every invalid call returns a concise error and leaves store.jsonl
// byte-identical.

let dir: string;
let cwd: string;
const PROMPT = "refactor the parser module for speed";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-stacker-trace-"));
  cwd = dir;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function storeFile(): string {
  return storeFileFor(cwd, "s1");
}

function storeBytes(): string {
  return fs.readFileSync(storeFile(), "utf8");
}

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content[0]?.text ?? "";
}

function run(op: GoalOperation, sessionId = "s1") {
  return executeOperation(cwd, sessionId, op);
}

function activeGoal(): string | undefined {
  return deriveTree(readStoreRecords(storeFile())).activeGoal?.id;
}

describe("scripted trace over one fixed demo prompt", () => {
  it("root created verbatim; one active goal per step; transitions recorded; invalid calls byte-identical", () => {
    // Step 1: prompt starts the tree — root holds the prompt verbatim.
    const root = ensureRoot([], PROMPT, "s1", storeFile())!;
    const bytes0 = storeBytes();
    expect(deriveTree(readStoreRecords(storeFile())).goals.get(root.id)?.statement).toBe(PROMPT);
    expect(activeGoal()).toBe(root.id);

    // Invalid call 1: select with no pending goals — concise error, byte-identical store.
    const r1 = run({ op: "goal_select", id: "g99" });
    expect(text(r1)).toMatch(/^error: /);
    expect(storeBytes()).toBe(bytes0);

    // Invalid call 2: contract_children naming a nonexistent parent.
    const r2 = run({ op: "goal_contract_children", parent: "g99", verdict: "satisfied", outcome: "x" });
    expect(text(r2)).toMatch(/^error: /);
    expect(storeBytes()).toBe(bytes0);

    // Invalid call 3: drop the active goal without a reason.
    const r3 = run({ op: "goal_drop", id: root.id, reason: "" });
    expect(text(r3)).toMatch(/^error: /);
    expect(storeBytes()).toBe(bytes0);

    // Invalid call 4: add_and_select under a done goal (root not done yet — use
    // a stale id path instead: drop requires reason, so use a bad expand shape).
    const r4 = run({ op: "goal_expand", children: [] });
    expect(text(r4)).toMatch(/^error: /);
    expect(storeBytes()).toBe(bytes0);

    // Step 2: expand the active root into children — attempt ends, tree grows.
    const r5 = run({
      op: "goal_expand",
      children: [
        { statement: "profile the hot loop", done_when: "hot loop identified" },
        { statement: "memoize the tokenizer", done_when: "tokenizer memoized" },
      ],
      findings: "two independent slow paths",
    });
    expect(text(r5)).toContain("applied goal_expand");
    let tree = deriveTree(readStoreRecords(storeFile()));
    expect(tree.activeGoal).toBeUndefined(); // expand ends the attempt (§4)
    expect(tree.children.get(root.id)).toHaveLength(2);
    expect(activeGoal()).toBeUndefined();
    const [childA, childB] = tree.children.get(root.id)!;
    const bytes1 = storeBytes();

    // Invalid call 5: end_attempt with no active goal — byte-identical store.
    const r6 = run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "nope" });
    expect(text(r6)).toMatch(/^error: /);
    expect(storeBytes()).toBe(bytes1);

    // Step 3: select a child, end the attempt with an outcome recorded.
    const r7 = run({ op: "goal_select", id: childA });
    expect(text(r7)).toContain("applied goal_select");
    expect(activeGoal()).toBe(childA);
    const r8 = run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "hot loop is in tokenize()" });
    expect(text(r8)).toContain("applied goal_end_attempt");
    tree = deriveTree(readStoreRecords(storeFile()));
    expect(tree.goals.get(childA)?.status).toBe("done");
    expect(tree.goals.get(childA)?.outcome).toBe("hot loop is in tokenize()");

    // Step 4: select the second child, end its attempt, collect via contract.
    run({ op: "goal_select", id: childB });
    // R3.F2: capture the pre-compaction trace segment — root completion below
    // triggers compaction, so snapshot the full record set now for prefix replay.
    const preCompaction = readStoreRecords(storeFile());
    expect(activeGoal()).toBe(childB);
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "tokenizer memoized" });
    const r9 = run({ op: "goal_contract_children", parent: root.id, verdict: "satisfied", outcome: "both children done" });
    expect(text(r9)).toContain("applied goal_contract_children");
    tree = deriveTree(readStoreRecords(storeFile()));
    expect(tree.goals.get(root.id)?.status).toBe("done"); // explicit collection made the parent done
    expect(tree.activeGoal).toBeUndefined();

    // Invariants across the whole trace: root statement still verbatim.
    // R2.F1: once the root is done, the store is compacted to the terminal
    // completion record — the run's records are rewritten out.
    const records = readStoreRecords(storeFile());
    expect(records).toHaveLength(1);
    const rootRec = records[0];
    expect(rootRec.id).toBe(root.id);
    expect(rootRec.statement).toBe(PROMPT);
    expect(rootRec.status).toBe("done");
    expect(rootRec.outcome).toBe("both children done");
    // The terminal record leaves no active goal behind.
    expect(deriveTree(records).activeGoal).toBeUndefined();

    // R3.F2 invariant replay: over the pre-compaction segment, replay every
    // prefix and assert at most one goal is active in each derived state
    // (requirements §2.2). With the first expansion child done, the tail
    // prefix has zero active goals — the maximum over all prefixes is 1.
    expect(preCompaction.length).toBeGreaterThan(1);
    let maxActive = 0;
    for (let i = 1; i <= preCompaction.length; i++) {
      const tree = deriveTree(preCompaction.slice(0, i));
      let n = 0;
      for (const g of tree.goals.values()) if (g.status === "active") n++;
      maxActive = Math.max(maxActive, n);
    }
    expect(maxActive).toBe(1);
  });

  // Issue #12 acceptance gate (§2.6 extension 2.b, acceptance 3; §2.5/§4):
  // explicit contraction drives root completion — no auto-completion, a
  // non-satisfied verdict fails the parent and stops the run, an invalid
  // contraction is a concise error with a byte-identical store.
  function expandTwoChildren(root: string): [string, string] {
    run({
      op: "goal_expand",
      children: [
        { statement: "profile the hot loop", done_when: "hot loop identified" },
        { statement: "memoize the tokenizer", done_when: "tokenizer memoized" },
      ],
    });
    const tree = deriveTree(readStoreRecords(storeFile()));
    const kids = tree.children.get(root)!;
    return [kids[0], kids[1]];
  }

  function finishChild(id: string, outcome: string): void {
    run({ op: "goal_select", id });
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome });
  }

  it("no auto-completion: all children done leaves the parent unfinished with no tool call", () => {
    const root = ensureRoot([], PROMPT, "s1", storeFile())!.id;
    const [a, b] = expandTwoChildren(root);
    finishChild(a, "hot loop is in tokenize()");
    finishChild(b, "tokenizer memoized");

    // The assertion itself is the proof of 2.b invariant 1: after the last
    // child completes, no further call is made — the parent must already be
    // observed unfinished with no active goal.
    const tree = deriveTree(readStoreRecords(storeFile()));
    expect(tree.goals.get(root)?.status).not.toBe("done");
    expect(tree.activeGoal).toBeUndefined();
  });

  it("non-satisfied verdict: parent failed and the run stops with the reason in the result", () => {
    const root = ensureRoot([], PROMPT, "s1", storeFile())!.id;
    const [a, b] = expandTwoChildren(root);
    finishChild(a, "hot loop is in tokenize()");
    finishChild(b, "tokenizer memoized");

    const res = run({ op: "goal_contract_children", parent: root, verdict: "failed", outcome: "children reveal a deeper redesign" });
    // 2.b.1: parent failed, run stops, reason visible in the result text.
    expect(text(res)).toContain("parent failed");
    expect(text(res)).toContain("run stops");
    const tree = deriveTree(readStoreRecords(storeFile()));
    expect(tree.goals.get(root)?.status).toBe("failed");
    expect(tree.activeGoal).toBeUndefined();
  });

  it("satisfied verdict after children done: parent done, store compacted to the terminal record", () => {
    const root = ensureRoot([], PROMPT, "s1", storeFile())!.id;
    const [a, b] = expandTwoChildren(root);
    finishChild(a, "hot loop is in tokenize()");
    finishChild(b, "tokenizer memoized");

    const res = run({ op: "goal_contract_children", parent: root, verdict: "satisfied", outcome: "both children done" });
    expect(text(res)).toContain("applied goal_contract_children");
    // R2.F1: root completion compacts the store to the terminal record.
    const records = readStoreRecords(storeFile());
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(root);
    expect(records[0].status).toBe("done");
    expect(records[0].outcome).toBe("both children done");
    expect(deriveTree(records).activeGoal).toBeUndefined();
  });

  it("contracting with a still-pending child: concise error, store byte-identical", () => {
    const root = ensureRoot([], PROMPT, "s1", storeFile())!.id;
    expandTwoChildren(root);
    const [a] = deriveTree(readStoreRecords(storeFile())).children.get(root)!;
    finishChild(a, "hot loop is in tokenize()");
    const bytes = storeBytes();

    const res = run({ op: "goal_contract_children", parent: root, verdict: "satisfied", outcome: "premature" });
    expect(text(res)).toMatch(/^error: /);
    expect(storeBytes()).toBe(bytes);
  });
});
