import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore, StoreError } from "../../src/store/index.js";

function sessionDir(): string {
  return mkdtempSync(join(tmpdir(), "goal-store-test-"));
}

describe("goal store round-trip (MVP §7.5)", () => {
  it("records written in one invocation are read back identically in the next", () => {
    const dir = sessionDir();
    try {
      // Invocation N: write.
      const storeN = GoalStore.open(dir);
      const root = storeN.add({
        statement: "Fix the flaky parser test",
        origin: "prompt",
        status: "active",
      });
      const child = storeN.add({
        parent: root.id,
        statement: "Reproduce the failure",
        done_when: "failing test captured verbatim",
        contributes: "isolates the flake",
        origin: "expansion",
      });
      // Invocation M: fresh load, same session directory.
      const storeM = GoalStore.open(dir);
      expect(storeM.list()).toEqual(storeN.list());
      expect(storeM.get(root.id)).toEqual(root);
      expect(storeM.get(child.id)).toEqual(child);
      expect(storeM.get(root.id)?.statement).toBe("Fix the flaky parser test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an empty session initializes with no root and no records", () => {
    const dir = sessionDir();
    try {
      const store = GoalStore.open(dir);
      expect(store.list()).toEqual([]);
      expect(store.root()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends persist incrementally — each add is readable from a fresh load", () => {
    const dir = sessionDir();
    try {
      const a = GoalStore.open(dir);
      const root = a.add({ statement: "root", origin: "prompt" });
      expect(GoalStore.open(dir).list()).toEqual([root]);
      const child = a.add({ parent: root.id, statement: "child", origin: "expansion" });
      const reloaded = GoalStore.open(dir);
      expect(reloaded.list()).toEqual([root, child]);
      expect(reloaded.root()?.id).toBe(root.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runtime-assigned IDs are stable and monotonic across reloads", () => {
    const dir = sessionDir();
    try {
      const a = GoalStore.open(dir);
      const r1 = a.add({ statement: "one", origin: "prompt" });
      const r2 = a.add({ parent: r1.id, statement: "two", origin: "expansion" });
      expect(r1.id).toBe("g1");
      expect(r2.id).toBe("g2");
      const b = GoalStore.open(dir);
      const r3 = b.add({ parent: r1.id, statement: "three", origin: "explicit_add" });
      expect(r3.id).toBe("g3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("goal store write validation", () => {
  it("rejects a record without a statement, leaving the log unchanged", () => {
    const dir = sessionDir();
    try {
      const store = GoalStore.open(dir);
      expect(() =>
        store.add({ statement: "  ", origin: "prompt" }),
      ).toThrow(StoreError);
      expect(GoalStore.open(dir).list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown origin", () => {
    const store = GoalStore.open(sessionDir());
    expect(() =>
      store.add({ statement: "x", origin: "divine_intervention" as never }),
    ).toThrow(/origin/);
  });

  it("rejects a child whose parent does not exist", () => {
    const store = GoalStore.open(sessionDir());
    expect(() =>
      store.add({ parent: "g99", statement: "orphan", origin: "expansion" }),
    ).toThrow(/parent g99 does not exist/);
  });

  it("allows at most one prompt-originated root", () => {
    const store = GoalStore.open(sessionDir());
    store.add({ statement: "root", origin: "prompt" });
    expect(() => store.add({ statement: "second root", origin: "prompt" })).toThrow(
      /root already exists/,
    );
  });
});
