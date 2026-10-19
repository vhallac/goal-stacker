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
  op: "add";
  record: GoalRecord;
}

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
      if (event.op !== "add" || typeof event.record?.id !== "string") {
        throw new StoreError(`corrupt goal log at ${logPath}:${i + 1}: unrecognized event`);
      }
      if (store.records.has(event.record.id)) {
        throw new StoreError(`corrupt goal log at ${logPath}:${i + 1}: duplicate id ${event.record.id}`);
      }
      store.records.set(event.record.id, event.record);
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
