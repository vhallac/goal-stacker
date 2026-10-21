import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  phaseBlockReason,
  phaseBlockMessage,
  NO_ACTIVE_GOAL_BLOCK_OPERATIONS,
  storeFileFor,
  ensureRoot,
  executeOperation,
  readStoreRecords,
  type GoalOperation,
  type GoalRecord,
} from "../src/extension.js";

// Phase boundary (issue #11 acceptance condition): after an attempt ends, every
// ordinary tool call is blocked with a concise phase message and the store is
// byte-identical across the blocked call; after a successful selection the same
// ordinary tool call executes again; invalid tree-control calls surface through
// the existing error path with the store byte-identical.

let dir: string;
const cwd = () => dir;
const SID = "s1";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-stacker-phase-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function storeFile(): string {
  return storeFileFor(cwd(), SID);
}

function storeBytes(): string {
  return fs.readFileSync(storeFile(), "utf8");
}

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content[0]?.text ?? "";
}

function run(op: GoalOperation): ReturnType<typeof executeOperation> {
  return executeOperation(cwd(), SID, op);
}

/** Ordinary (task) tool — not a goal_* tool. */
const ORDINARY_TOOL = "bash";

describe("phase boundary between execution and tree control", () => {
  it("ordinary tool executes while a goal is active (1.a: no gating overhead)", () => {
    ensureRoot([], "refactor the parser module for speed", SID, storeFile());
    expect(phaseBlockReason(cwd(), SID, ORDINARY_TOOL)).toBeUndefined();
    expect(phaseBlockReason(cwd(), SID, "goal_end_attempt")).toBeUndefined();
  });

  it("after goal_end_attempt: ordinary tool blocked with phase message; store byte-identical; then goal_select reopens execution", () => {
    ensureRoot([], "refactor the parser module for speed", SID, storeFile());
    // Expand first: pending children exist for the later selection; the root is
    // expanded (not done), so no root-completion compaction runs.
    run({ op: "goal_expand", children: [{ statement: "sub-goal" }] });
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "done for now" });
    const bytes = storeBytes();

    const reason = phaseBlockReason(cwd(), SID, ORDINARY_TOOL);
    expect(reason).toBe(phaseBlockMessage());
    // Message names the phase and lists one line per available operation.
    expect(reason).toContain("no active goal");
    for (const op of NO_ACTIVE_GOAL_BLOCK_OPERATIONS) {
      expect(reason).toContain(`- ${op}`);
    }
    // The two ending operations are NOT offered — the attempt has ended.
    expect(reason).not.toContain("goal_end_attempt");
    expect(reason).not.toContain("goal_expand");

    // Blocked call left the store byte-identical.
    expect(storeBytes()).toBe(bytes);

    // goal_select on the pending leaf re-opens the execution phase.
    const child = readStoreRecords(storeFile()).filter((r) => r.status === "pending")[0];
    expect(child).toBeDefined();
    const r = run({ op: "goal_select", id: child.id });
    expect(text(r)).toMatch(/^applied goal_select/);
    expect(phaseBlockReason(cwd(), SID, ORDINARY_TOOL)).toBeUndefined();
  });

  it("after goal_expand: ordinary tool blocked; store byte-identical", () => {
    ensureRoot([], "refactor the parser module for speed", SID, storeFile());
    run({ op: "goal_expand", children: [{ statement: "sub-goal" }] });
    const bytes = storeBytes();

    expect(phaseBlockReason(cwd(), SID, ORDINARY_TOOL)).toBe(phaseBlockMessage());
    expect(storeBytes()).toBe(bytes);
  });

  it("failed goal_select keeps the no-active-goal phase blocking (4.a)", () => {
    ensureRoot([], "refactor the parser module for speed", SID, storeFile());
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "done" });
    const r = run({ op: "goal_select", id: "g-nonexistent" });
    expect(text(r)).toMatch(/^error: /);
    expect(phaseBlockReason(cwd(), SID, ORDINARY_TOOL)).toBe(phaseBlockMessage());
  });

  it("invalid tree-control call in no-active-goal phase: existing error path, store byte-identical", () => {
    ensureRoot([], "refactor the parser module for speed", SID, storeFile());
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "done" });
    const bytes = storeBytes();
    // Invalid per #10's validation: select requires a pending leaf; drop likewise.
    const r = run({ op: "goal_drop", id: "g-nonexistent", reason: "not needed" });
    expect(text(r)).toMatch(/^error: /);
    expect(storeBytes()).toBe(bytes);
  });

  it("goal_* tools are never blocked by the phase gate; all seven pass through", () => {
    ensureRoot([], "refactor the parser module for speed", SID, storeFile());
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "done" });
    for (const name of [
      "goal_end_attempt",
      "goal_expand",
      "goal_select",
      "goal_add_and_select",
      "goal_drop",
      "goal_contract_children",
      "goal_stop_work",
    ]) {
      expect(phaseBlockReason(cwd(), SID, name)).toBeUndefined();
    }
  });
});

describe("phase gate at the rigid pi tool_call boundary (PR !17 F1/F2)", () => {
  /** Minimal fake of the pi ExtensionAPI: captures tool_call handlers only. */
  function fakePi(): { on: (ev: string, fn: unknown) => void; registerTool: () => void; toolCallHandler: () => unknown } {
    let handler: unknown;
    return {
      on: (ev, fn) => {
        if (ev === "tool_call") handler = fn;
      },
      registerTool: () => {},
      toolCallHandler: () => handler,
    };
  }
  const ctx = () => ({ cwd: dir, sessionManager: { getSessionId: () => SID } }) as never;

  it("registered handler blocks ordinary calls with {block:true, reason} and passes allowed calls as undefined", async () => {
    const { default: goalStacker } = await import("../src/extension.js");
    const fake = fakePi();
    goalStacker(fake as never);
    const handler = fake.toolCallHandler() as (e: unknown, c: unknown) => Promise<{ block: boolean; reason: string } | undefined>;
    expect(handler).toBeTypeOf("function");

    // Active goal -> allowed (undefined return).
    ensureRoot([], "refactor the parser module for speed", SID, storeFile());
    await expect(handler({ toolName: ORDINARY_TOOL }, ctx())).resolves.toBeUndefined();
    // goal_* tool passes through even in the blocked phase.
    run({ op: "goal_end_attempt", disposition: "satisfied", outcome: "done" });
    await expect(handler({ toolName: ORDINARY_TOOL }, ctx())).resolves.toEqual({ block: true, reason: phaseBlockMessage() });
    await expect(handler({ toolName: "goal_select" }, ctx())).resolves.toBeUndefined();
  });

  it("corrupt store (two active goals) fails closed: blocked with a corrupt-store reason, not a throw", async () => {
    const { default: goalStacker } = await import("../src/extension.js");
    const fake = fakePi();
    goalStacker(fake as never);
    const handler = fake.toolCallHandler() as (e: unknown, c: unknown) => Promise<{ block: boolean; reason: string } | undefined>;

    // Corrupt the store: two records with status=active at once.
    const root: Pick<GoalRecord, "kind" | "ts" | "sessionId" | "id" | "statement" | "origin" | "status" | "selected"> = {
      kind: "goal",
      ts: new Date().toISOString(),
      sessionId: SID,
      id: "g-1",
      statement: "root",
      origin: "prompt",
      status: "active",
      selected: true,
    };
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify({ ...root, id: "g-1" }) + "\n" + JSON.stringify({ ...root, id: "g-2", origin: "derived", selected: false }) + "\n");

    const res = await handler({ toolName: ORDINARY_TOOL }, ctx());
    expect(res).toEqual({ block: true, reason: expect.stringContaining("corrupt goal store") });
  });
});
