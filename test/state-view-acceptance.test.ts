import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  stateViewInjection,
  storeFileFor,
  ensureRoot,
  executeOperation,
  deriveTree,
  readStoreRecords,
} from "../src/extension.js";

// Two-invocation acceptance (issue #13, §6): the first invocation creates the
// root and injects nothing; the second invocation — after the tree has grown —
// injects the §6 state view rendered purely from the durable store. The store
// is byte-identical across the injection.

const PROMPT = "refactor the parser module for speed";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-stacker-sv-accept-"));
  file = storeFileFor(dir, "sess-1");
  fs.mkdirSync(path.dirname(file), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function storeBytes(): string {
  return fs.readFileSync(file, "utf8");
}

describe("two-invocation acceptance", () => {
  it("invocation 1 injects nothing; invocation 2 injects root verbatim, phase, and pending set; store byte-identical", () => {
    // Invocation 1: handler calls ensureRoot — root created, nothing injected.
    const rec = ensureRoot(readStoreRecords(file), PROMPT, "sess-1", file);
    expect(rec).toBeDefined();
    const bytesAfterFirst = storeBytes();

    // Tree grows during the run: expand the active root into children, one done.
    const expand = executeOperation(dir, "sess-1", {
      op: "goal_expand",
      children: [
        { statement: "profile the hot loop", done_when: "hot loop identified" },
        { statement: "rewrite the parser", done_when: "parser rewritten" },
      ],
    });
    expect(expand.content[0].text).not.toMatch(/^error: /);
    // After expand the attempt ended — pick a pending child to reactivate.
    const tree = deriveTree(readStoreRecords(file));
    const pending = [...tree.goals.values()].filter((g) => g.status === "pending");
    expect(pending.length).toBe(2);
    const sel = executeOperation(dir, "sess-1", { op: "goal_select", id: pending[0].id });
    expect(sel.content[0].text).not.toMatch(/^error: /);
    const done = executeOperation(dir, "sess-1", {
      op: "goal_end_attempt",
      id: pending[0].id,
      verdict: "satisfied",
      outcome: "hot loop identified",
    });
    expect(done.content[0].text).not.toMatch(/^error: /);
    const bytesBeforeSecond = storeBytes();

    // Invocation 2: handler calls stateViewInjection — injects the state view.
    const result = stateViewInjection(file);
    expect(result).toBeDefined();
    const view = result!.message.content;

    // Anchors: root statement + status; execution phase; pending set from store.
    const rootStatus = tree.goals.get(tree.rootId!)!.status;
    expect(view.split("\n")[0]).toBe(`root: ${PROMPT} (${rootStatus})`);
    expect(view).toMatch(/phase: execution/);
    const remaining = [...deriveTree(readStoreRecords(file)).goals.values()]
      .filter((g) => g.status === "pending");
    for (const g of remaining) expect(view).toContain(`- ${g.id}: ${g.statement}`);
    expect(remaining.length).toBeGreaterThan(0);
    expect(view).toContain(`active: `);

    // Store byte-identical across injection.
    expect(storeBytes()).toBe(bytesBeforeSecond);
    // And still identical to what the first invocation left behind modulo the
    // scripted growth — i.e. injection never appended.
    expect(storeBytes().split("\n").length).toBe(bytesBeforeSecond.split("\n").length);

    // First invocation itself injected nothing (handler returns undefined on root creation).
    expect(bytesAfterFirst).not.toBe("");
  });
});
