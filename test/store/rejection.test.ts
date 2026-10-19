import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GoalStore, StoreError } from "../../src/store/store.js";
import type { GoalStatus } from "../../src/store/types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "goal-store-reject-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("contract-rewrite rejection (issue #4 ext 2.a)", () => {
  it("rejects rewriting statement/done_when/contributes with a concise error", () => {
    const store = GoalStore.open(dir);
    store.add({ statement: "root", origin: "prompt" });
    store.add({ parent: "g1", statement: "child", origin: "expansion", done_when: "x", contributes: "y" });

    const attempts = [
      ["g1", { statement: "rewritten" }],
      ["g2", { done_when: "rewritten" }],
      ["g2", { contributes: "rewritten" }],
    ] as const;
    for (const [id, patch] of attempts) {
      // @ts-expect-error deliberately illegal contract rewrite
      expect(() => store.update(id, patch), `${id} ${JSON.stringify(patch)}`).toThrow(/immutable/);
    }
  });

  it("leaves the tree unchanged on rejection", () => {
    const store = GoalStore.open(dir);
    store.add({ statement: "root", origin: "prompt" });
    store.add({ parent: "g1", statement: "child", origin: "expansion" });

    // @ts-expect-error illegal rewrite
    expect(() => store.update("g1", { statement: "nope" })).toThrow(StoreError);

    const reopened = GoalStore.open(dir);
    expect(reopened.get("g1")?.statement).toBe("root");
    expect(reopened.get("g2")?.statement).toBe("child");
  });

  it("allows outcome updates and persists them", () => {
    const store = GoalStore.open(dir);
    store.add({ statement: "root", origin: "prompt" });
    expect(store.update("g1", { outcome: "delivered" }).outcome).toBe("delivered");
    expect(GoalStore.open(dir).get("g1")?.outcome).toBe("delivered");
  });
});

describe("status-model guard (issue #4 status model)", () => {
  /** g1: pending root; g2: active child; g3: expanded child; g4: blocked child. */
  function seeded(): GoalStore {
    const store = GoalStore.open(dir);
    store.add({ statement: "root", origin: "prompt" }); // g1 pending
    store.add({ parent: "g1", statement: "a", origin: "expansion" }); // g2 pending
    store.setStatus("g2", "active"); // active
    store.add({ parent: "g1", statement: "b", origin: "expansion" }); // g3 pending
    store.setStatus("g3", "active");
    store.setStatus("g3", "expanded");
    store.add({ parent: "g1", statement: "c", origin: "expansion" }); // g4 pending
    store.setStatus("g4", "active");
    store.setStatus("g4", "blocked");
    return store;
  }

  const cases: Array<[string, GoalStatus, boolean]> = [
    ["g1", "active", true], // pending -> active (select_goal)
    ["g1", "dropped", true], // pending -> dropped (drop_goal)
    ["g1", "done", false],
    ["g1", "expanded", false],
    ["g2", "expanded", true], // active -> expanded
    ["g2", "done", true],
    ["g2", "failed", true],
    ["g2", "blocked", true],
    ["g2", "active", false], // active -> active self-transition is not a transition
    ["g2", "dropped", false], // active -> dropped is not in the model
    ["g3", "active", false], // expanded has no outgoing transitions
    ["g3", "done", false],
    ["g4", "active", true], // blocked -> active (re-attempt)
    ["g4", "dropped", true], // blocked -> dropped with reason
    ["g4", "done", false],
  ];

  it.each(cases)("transition %s -> %s legal=%s", (id, status, legal) => {
    const store = seeded();
    if (legal) {
      expect(store.setStatus(id, status).status).toBe(status);
    } else {
      expect(() => store.setStatus(id, status)).toThrow(/illegal status transition|status is already/);
    }
  });

  it("rejects unknown status values and unknown ids", () => {
    const store = seeded();
    // @ts-expect-error illegal status
    expect(() => store.setStatus("g1", "archived")).toThrow(/unknown status/);
    expect(() => store.setStatus("g99", "active")).toThrow(/unknown goal id/);
  });

  it("rejections leave the log unchanged (status survives round-trip)", () => {
    const store = seeded();
    expect(() => store.setStatus("g1", "done")).toThrow();
    const reopened = GoalStore.open(dir);
    expect(reopened.get("g1")?.status).toBe("pending");
    expect(reopened.get("g4")?.status).toBe("blocked");
  });
});

describe("corruption diagnostics (issue #4 ext 3.a)", () => {
  function corrupt(content: string): string {
    writeFileSync(join(dir, "goals.jsonl"), content);
    return join(dir, "goals.jsonl");
  }

  it("fails on a line that is not valid JSON, with line number", () => {
    corrupt(
      '{"op":"add","record":{"id":"g1","statement":"x","origin":"prompt","status":"pending"}}\n{not json}\n',
    );
    expect(() => GoalStore.open(dir)).toThrow(/corrupt goal log at .*:2: not valid JSON/);
  });

  it("fails on an unrecognized event", () => {
    corrupt('{"op":"delete","id":"g1"}\n');
    expect(() => GoalStore.open(dir)).toThrow(/unrecognized event/);
  });

  it("fails on duplicate ids", () => {
    corrupt(
      '{"op":"add","record":{"id":"g1","statement":"x","origin":"prompt","status":"pending"}}\n' +
        '{"op":"add","record":{"id":"g1","statement":"y","origin":"prompt","status":"pending"}}\n',
    );
    expect(() => GoalStore.open(dir)).toThrow(/duplicate id g1/);
  });

  it("fails on a dangling parent reference", () => {
    corrupt(
      '{"op":"add","record":{"id":"g1","statement":"x","origin":"expansion","status":"pending","parent":"g7"}}\n',
    );
    expect(() => GoalStore.open(dir)).toThrow(/references missing parent g7/);
  });

  it("fails on invalid origin/status inside a record", () => {
    corrupt('{"op":"add","record":{"id":"g1","statement":"x","origin":"orphan","status":"pending"}}\n');
    expect(() => GoalStore.open(dir)).toThrow(/invalid origin\/status/);
  });

  it("does not repair: the corrupt file is left untouched", () => {
    const path = corrupt("{not json}\n");
    const before = readFileSync(path, "utf8");
    expect(() => GoalStore.open(dir)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("replays update/set_status events across invocations", () => {
    const store = GoalStore.open(dir);
    store.add({ statement: "root", origin: "prompt" });
    store.setStatus("g1", "active");
    store.update("g1", { outcome: "ok" });

    const reopened = GoalStore.open(dir);
    expect(reopened.get("g1")?.status).toBe("active");
    expect(reopened.get("g1")?.outcome).toBe("ok");
  });
});
