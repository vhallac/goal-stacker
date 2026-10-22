import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  deriveTree,
  renderStateView,
  stateViewInjection,
  STATE_VIEW_TYPE,
  storeFileFor,
  type GoalRecord,
} from "../src/extension.js";

// Behavior under test (goal-tree-mvp.md §6, issue #13):
// Every post-first invocation opens with the §6 state view, rendered purely
// from the durable tree and injected via the #9 mechanism. The store is never
// written by rendering (byte-identical across injection).

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-stacker-state-view-"));
  file = storeFileFor(dir, "sess-1");
  fs.mkdirSync(path.dirname(file), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function rec(patch: Partial<GoalRecord> & { id: string }): GoalRecord {
  return {
    kind: "goal",
    ts: "2026-01-01T00:00:00.000Z",
    sessionId: "sess-1",
    origin: "expansion",
    status: "pending",
    statement: `statement for ${patch.id}`,
    ...patch,
  };
}

const ROOT = rec({ id: "g-root", origin: "prompt", statement: "Ship the goal tree MVP", status: "done" });
const PARENT = rec({ id: "g-parent", parent: "g-root", status: "active" });

describe("renderStateView — execution phase (active goal)", () => {
  it("opens with the root prompt verbatim, shows the active goal with ancestors, pending goals, outcomes, and the execution phase", () => {
    const records = [
      ROOT,
      PARENT,
      rec({ id: "g-child-a", parent: "g-parent", status: "done", outcome: "parsing isolated" }),
      rec({ id: "g-child-b", parent: "g-parent", status: "pending" }),
    ];
    const view = renderStateView(deriveTree(records));

    const lines = view.split("\n");
    expect(lines[0]).toBe("root: g-root Ship the goal tree MVP (done)"); // id + statement + status (#20)
    expect(view).toContain(`active: ${PARENT.id} (active) — ${PARENT.statement}`);
    expect(view).toContain("- g-child-b: statement for g-child-b"); // pending
    expect(view).toContain("- g-child-a [done]: parsing isolated"); // outcome line
    expect(view).toContain("phase: execution");
    expect(view).toContain("goal_end_attempt");
    expect(view).toContain("goal_expand");
  });

  it("ancestor chain is rendered root-first above the active goal", () => {
    const records = [ROOT, PARENT, rec({ id: "g-leaf", parent: "g-parent", status: "pending" })];
    const lines = renderStateView(deriveTree(records)).split("\n");
    const activeLines = lines.filter((l) => l.startsWith("active:"));
    expect(activeLines).toEqual([
      `active: ${ROOT.id} (done) — ${ROOT.statement}`,
      `active: ${PARENT.id} (active) — ${PARENT.statement}`,
    ]);
  });
});

describe("renderStateView — expanded intermediate parents carry ids (#20)", () => {
  it("an expanded parent off the active chain renders under `expanded:` with its id", () => {
    const records = [
      ROOT,
      rec({ id: "g-branch", parent: "g-root", status: "expanded" }),
      rec({ id: "g-branch-kid", parent: "g-branch", status: "pending" }),
      PARENT,
      rec({ id: "g-leaf", parent: "g-parent", status: "pending" }),
    ];
    const lines = renderStateView(deriveTree(records)).split("\n");
    expect(lines).toContain("expanded:");
    expect(lines).toContain("- g-branch: statement for g-branch");
  });

  it("expanded ancestors on the active chain are not duplicated in the expanded section", () => {
    const records = [
      ROOT,
      rec({ id: "g-mid", parent: "g-root", status: "expanded" }),
      rec({ id: "g-leaf", parent: "g-mid", status: "active" }),
    ];
    const lines = renderStateView(deriveTree(records)).split("\n");
    expect(lines.filter((l) => l.startsWith("expanded:"))).toEqual([]);
    expect(lines).toContain(`active: g-mid (expanded) — statement for g-mid`);
  });
});

describe("renderStateView — run-complete state (R2.F2)", () => {
  it("done root with no active goal: root line shows (done) and the root's own terminal outcome appears", () => {
    const records = [
      rec({ id: "g-root", origin: "prompt", statement: "Ship the goal tree MVP", status: "done", outcome: "MVP shipped" }),
      rec({ id: "g-child", parent: "g-root", status: "done", outcome: "parsing isolated" }),
    ];
    const lines = renderStateView(deriveTree(records)).split("\n");
    expect(lines[0]).toBe("root: g-root Ship the goal tree MVP (done)");
    expect(lines).toContain("- g-root [done]: MVP shipped");
    expect(lines).toContain("- g-child [done]: parsing isolated");
  });
});

describe("renderStateView — no-active-goal phase", () => {
  it("lists the five tree-control operations, phrasing aligned with #11", () => {
    const records = [
      ROOT,
      rec({ id: "g-done-kid", parent: "g-root", status: "done", outcome: "collected" }),
    ];
    const view = renderStateView(deriveTree(records));
    expect(view).toContain("phase: no active goal");
    for (const op of ["goal_select", "goal_add_and_select", "goal_drop", "goal_contract_children", "goal_stop_work"]) {
      expect(view).toContain(`- ${op}`);
    }
    // The ending operations are gone — the attempt already ended.
    expect(view).not.toContain("goal_end_attempt");
    expect(view).not.toContain("goal_expand");
    // The named escape (#13, made real by the renewed-root rule) is present.
    expect(view).toContain("starts a new run automatically");
  });
});

describe("renderStateView — compact budget (2.c)", () => {
  it("renders one line per completed-child outcome, none truncated away", () => {
    const records = [ROOT, PARENT];
    for (let i = 0; i < 7; i++) {
      records.push(rec({ id: `g-k${i}`, parent: "g-parent", status: "done", outcome: `outcome ${i} — deliberately long text to prove nothing is cut off mid-outcome` }));
    }
    const view = renderStateView(deriveTree(records));
    for (let i = 0; i < 7; i++) {
      expect(view).toContain(`- g-k${i} [done]: outcome ${i} — deliberately long text to prove nothing is cut off mid-outcome`);
    }
  });
});

describe("stateViewInjection — #9 mechanism", () => {
  it("returns the injection message with the §6 content, display: true", () => {
    fs.writeFileSync(file, JSON.stringify(ROOT) + "\n");
    fs.appendFileSync(file, JSON.stringify(PARENT) + "\n");
    fs.appendFileSync(file, JSON.stringify(rec({ id: "g-leaf", parent: "g-parent", status: "pending" })) + "\n");
    const inj = stateViewInjection(file);
    expect(inj).toBeDefined();
    expect(inj!.message.customType).toBe(STATE_VIEW_TYPE);
    expect(inj!.message.display).toBe(true);
    expect(inj!.message.content).toContain("root:");
  });

  it("empty or unreadable store: no injection (1.a)", () => {
    expect(stateViewInjection(file)).toBeUndefined(); // missing file
    fs.writeFileSync(file, "not json\n");
    expect(stateViewInjection(file)).toBeUndefined(); // unreadable -> no records
  });

  it("store stays byte-identical across injection", () => {
    fs.writeFileSync(file, JSON.stringify(ROOT) + "\n");
    fs.appendFileSync(file, JSON.stringify(PARENT) + "\n");
    const before = fs.readFileSync(file, "utf8");
    stateViewInjection(file);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("inconsistent store (two active goals): rendering fails, never a write", () => {
    fs.writeFileSync(file, JSON.stringify(rec({ id: "g-a", status: "active" })) + "\n");
    fs.appendFileSync(file, JSON.stringify(rec({ id: "g-b", status: "active" })) + "\n");
    const before = fs.readFileSync(file, "utf8");
    expect(() => stateViewInjection(file)).toThrow(); // handler catches -> no injection
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
