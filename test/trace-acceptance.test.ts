import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeOperation, ensureRoot, deriveTree, readStoreRecords, type GoalOperation } from "../src/extension.js";

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
  return path.join(cwd, ".goal-stacker", "store.jsonl");
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
    expect(activeGoal()).toBe(childB);
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "tokenizer memoized" });
    const r9 = run({ op: "goal_contract_children", parent: root.id, verdict: "satisfied", outcome: "both children done" });
    expect(text(r9)).toContain("applied goal_contract_children");
    tree = deriveTree(readStoreRecords(storeFile()));
    expect(tree.goals.get(root.id)?.status).toBe("done"); // explicit collection made the parent done
    expect(tree.activeGoal).toBeUndefined();

    // Invariants across the whole trace: root statement still verbatim;
    // store is append-only JSONL with expand + end_attempt transitions present.
    const records = readStoreRecords(storeFile());
    const rootRec = records.find((r) => r.id === root.id)!;
    expect(rootRec.statement).toBe(PROMPT);
    // expand and end_attempt transitions are recorded: two expansion children
    // under the root, and done-with-outcome records for both children + parent.
    expect(tree.children.get(root.id)).toHaveLength(2);
    const dones = records.filter((r) => r.status === "done" && r.outcome !== undefined);
    expect(dones.length).toBeGreaterThanOrEqual(3); // two children + contracted parent
    // At most one active goal at every recorded state: replay the record set
    // prefix by prefix and count active goals.
    let maxActive = 0;
    for (let i = 1; i <= records.length; i++) {
      const active = deriveTree(records.slice(0, i)).goals;
      let n = 0;
      for (const g of active.values()) if (g.status === "active") n++;
      maxActive = Math.max(maxActive, n);
    }
    expect(maxActive).toBe(1);
  });
});
