import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GoalRecord, GoalStatus, NewGoal } from "./types.js";

/**
 * Append-only JSON log goal store.
 *
 * The store appends one JSON event per line to `goals.jsonl` under the given
 * session directory. State is never rewritten in place: read-back replays the
 * log and returns exactly the last persisted tree. Corruption fails loud —
 * the store never repairs or reconstructs unreadable state.
 */

export const GOALS_LOG_FILE = "goals.jsonl";

interface LogEvent {
  op: "add" | "update" | "set_status";
  record?: GoalRecord;
  id?: string;
  status?: GoalStatus;
  outcome?: string;
}

/** Legal status transitions — issue #4 status model (architect decision). */
const TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  pending: ["active", "dropped"],
  active: ["expanded", "done", "failed", "blocked"],
  expanded: [],
  done: [],
  dropped: [],
  failed: [],
  blocked: ["active", "dropped"],
};

/** Fields protected from rewriting once a record is written (issue #4 invariant). */
const CONTRACT_FIELDS = ["statement", "done_when", "contributes"] as const;

type UpdatePatch = Partial<Pick<GoalRecord, "outcome">>;

const VALID_ORIGINS: readonly string[] = ["prompt", "expansion", "explicit_add"];
const VALID_STATUSES: readonly GoalStatus[] = [
  "pending",
  "active",
  "expanded",
  "done",
  "dropped",
  "failed",
  "blocked",
];

export class StoreError extends Error {}

export class GoalStore {
  private readonly dir: string;
  private records = new Map<string, GoalRecord>();
  private nextSeq = 1;

  private constructor(dir: string) {
    this.dir = dir;
  }

  /** Load the store from a session directory. An empty directory initializes with no root. */
  static open(dir: string): GoalStore {
    const store = new GoalStore(dir);
    const logPath = join(dir, GOALS_LOG_FILE);
    if (!existsSync(logPath)) {
      return store;
    }
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") {
        continue;
      }
      let event: LogEvent;
      try {
        event = JSON.parse(line) as LogEvent;
      } catch (cause) {
        throw new StoreError(
          `corrupt goal log at ${logPath}:${i + 1}: not valid JSON (${String(cause)})`,
        );
      }
      if (event.op === "add") {
        if (typeof event.record?.id !== "string") {
          throw new StoreError(`corrupt goal log at ${logPath}:${i + 1}: add event without record id`);
        }
      if (!VALID_ORIGINS.includes(event.record.origin) || !VALID_STATUSES.includes(event.record.status)) {
        throw new StoreError(
          `corrupt goal log at ${logPath}:${i + 1}: invalid origin/status in record ${event.record.id}`,
        );
      }
      if (store.records.has(event.record.id!)) {
        throw new StoreError(`corrupt goal log at ${logPath}:${i + 1}: duplicate id ${event.record.id}`);
      }
      store.records.set(event.record.id!, event.record!);
      } else if (event.op === "update" || event.op === "set_status") {
        const target = event.id !== undefined ? store.records.get(event.id) : undefined;
        if (!target) {
          throw new StoreError(
            `corrupt goal log at ${logPath}:${i + 1}: ${event.op} references unknown id ${event.id}`,
          );
        }
        if (event.op === "update") {
          if (typeof event.outcome !== "string") {
            throw new StoreError(`corrupt goal log at ${logPath}:${i + 1}: update event without outcome`);
          }
          store.records.set(event.id!, { ...target, outcome: event.outcome });
        } else {
          if (!VALID_STATUSES.includes(event.status!)) {
            throw new StoreError(
              `corrupt goal log at ${logPath}:${i + 1}: invalid status ${event.status}`,
            );
          }
          store.records.set(event.id!, { ...target, status: event.status! });
        }
      } else {
        throw new StoreError(`corrupt goal log at ${logPath}:${i + 1}: unrecognized event`);
      }
    }
    for (const record of store.records.values()) {
      if (record.parent !== undefined && !store.records.has(record.parent)) {
        throw new StoreError(
          `corrupt goal log at ${logPath}: record ${record.id} references missing parent ${record.parent}`,
        );
      }
    }
    store.nextSeq = maxSeq(store.records) + 1;
    return store;
  }

  /** All records in insertion order. */
  list(): GoalRecord[] {
    return [...this.records.values()];
  }

  get(id: string): GoalRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Validate and append a new goal. Assigns the next stable runtime ID.
   * Rejected inputs leave the log unchanged.
   */
  add(goal: NewGoal): GoalRecord {
    const problems: string[] = [];
    if (typeof goal.statement !== "string" || goal.statement.trim() === "") {
      problems.push("statement must be a non-empty string");
    }
    if (!VALID_ORIGINS.includes(goal.origin)) {
      problems.push(`origin must be one of ${VALID_ORIGINS.join(", ")}`);
    }
    if (goal.status !== undefined && !VALID_STATUSES.includes(goal.status)) {
      problems.push(`status must be one of ${VALID_STATUSES.join(", ")}`);
    }
    if (goal.parent !== undefined) {
      const parent = this.records.get(goal.parent);
      if (!parent) {
        problems.push(`parent ${goal.parent} does not exist`);
      }
    } else if (goal.origin === "prompt" && this.root() !== undefined) {
      problems.push("a root already exists; only one prompt-originated root is allowed");
    }
    if (problems.length > 0) {
      throw new StoreError(`invalid goal: ${problems.join("; ")}`);
    }

    const record: GoalRecord = {
      id: `g${this.nextSeq}`,
      statement: goal.statement,
      origin: goal.origin,
      status: goal.status ?? "pending",
    };
    if (goal.parent !== undefined) record.parent = goal.parent;
    if (goal.done_when !== undefined) record.done_when = goal.done_when;
    if (goal.contributes !== undefined) record.contributes = goal.contributes;
    if (goal.outcome !== undefined) record.outcome = goal.outcome;

    this.append({ op: "add", record });
    this.records.set(record.id, record);
    this.nextSeq++;
    return record;
  }

  /**
   * Update a mutable field (outcome) on an existing record. Any attempt to
   * rewrite the contract fields (statement, done_when, contributes) is
   * rejected with a concise error; the log is unchanged on rejection.
   */
  update(id: string, patch: UpdatePatch): GoalRecord {
    const record = this.records.get(id);
    if (!record) {
      throw new StoreError(`unknown goal id ${id}`);
    }
    for (const field of CONTRACT_FIELDS) {
      if (field in patch) {
        throw new StoreError(
          `cannot rewrite ${field} of ${id}: contract fields are immutable once written`,
        );
      }
    }
    const next = { ...record, ...patch };
    this.append({ op: "update", id, outcome: patch.outcome });
    this.records.set(id, next);
    return next;
  }

  /**
   * Transition a record's status. Only transitions in the #4 status model are
   * legal; anything else is rejected and leaves the log unchanged.
   */
  setStatus(id: string, status: GoalStatus): GoalRecord {
    if (!VALID_STATUSES.includes(status)) {
      throw new StoreError(`unknown status ${status}`);
    }
    const record = this.records.get(id);
    if (!record) {
      throw new StoreError(`unknown goal id ${id}`);
    }
    if (record.status === status) {
      throw new StoreError(`${id}: status is already ${status}`);
    }
    const legal = TRANSITIONS[record.status];
    if (!legal.includes(status)) {
      throw new StoreError(
        `illegal status transition ${id}: ${record.status} -> ${status} (legal: ${legal.join(", ") || "none"})`,
      );
    }
    this.append({ op: "set_status", id, status });
    const next = { ...record, status };
    this.records.set(id, next);
    return next;
  }

  root(): GoalRecord | undefined {
    return this.list().find((r) => r.parent === undefined);
  }

  private append(event: LogEvent): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, GOALS_LOG_FILE), `${JSON.stringify(event)}\n`, {
      flag: "a",
    });
  }
}

function maxSeq(records: Map<string, GoalRecord>): number {
  let max = 0;
  for (const id of records.keys()) {
    const m = /^g(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}
