import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureRoot, readStoreRecords, deriveTree, type GoalRecord } from "../src/extension.js";

// Behavior under test (goal-tree-mvp.md §2.1, issue #10 use case step 1):
// A prompt starts a tree — the store holds one root goal record with the
// verbatim prompt, origin=prompt, status=active, selected — and a later
// before_agent_start in the same session appends no duplicate root.

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-stacker-root-"));
  file = path.join(dir, "store.jsonl");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("root-goal creation", () => {
  it("a prompt starts a tree: root record with verbatim prompt, active, selected", () => {
    const prompt = "Refactor the parser module and add regression tests";
    const rec = ensureRoot([], prompt, "sess-1", file);

    expect(rec).toBeDefined();
    expect(rec!.statement).toBe(prompt); // verbatim
    expect(rec!.origin).toBe("prompt");
    expect(rec!.status).toBe("active");
    expect(rec!.selected).toBe(true);
    expect(rec!.id).toBeTruthy();
    expect(rec!.parent).toBeUndefined(); // root has no parent

    // Durable: the store on disk holds exactly this record.
    const records = readStoreRecords(file);
    expect(records).toHaveLength(1);
    expect(records[0].statement).toBe(prompt);
    const tree = deriveTree(records);
    expect(tree.rootId).toBe(rec!.id);
    expect(tree.activeGoal?.id).toBe(rec!.id);
  });

  it("no duplicate root on a later before_agent_start in the same session", () => {
    const first = ensureRoot([], "first prompt", "sess-1", file);
    expect(first).toBeDefined();
    const before = fs.readFileSync(file, "utf8");

    const second = ensureRoot(readStoreRecords(file), "second prompt", "sess-1", file);
    expect(second).toBeUndefined(); // tree exists -> nothing appended

    const after = fs.readFileSync(file, "utf8");
    expect(after).toBe(before); // store byte-identical
    expect(readStoreRecords(file)).toHaveLength(1);
  });

  it("empty prompt line / missing store: treated as no tree, root created", () => {
    const rec = ensureRoot(readStoreRecords(file), "boot the goal tree", "sess-2", file);
    expect(rec).toBeDefined();
    expect(rec!.statement).toBe("boot the goal tree");
  });

  it("a store with records but no root yet still gets exactly one root (invariant guard)", () => {
    // Adversarial entry: records exist but none is a prompt-origin root.
    const orphan: GoalRecord = {
      kind: "goal",
      ts: new Date().toISOString(),
      sessionId: "sess-3",
      id: "g-orphan",
      statement: "orphan child",
      origin: "expansion",
      status: "pending",
    };
    fs.writeFileSync(file, JSON.stringify(orphan) + "\n");
    const rec = ensureRoot(readStoreRecords(file), "the real prompt", "sess-3", file);
    expect(rec).toBeDefined();
    const records = readStoreRecords(file);
    const roots = records.filter((r) => r.origin === "prompt");
    expect(roots).toHaveLength(1);
    expect(roots[0].statement).toBe("the real prompt");
  });
});
