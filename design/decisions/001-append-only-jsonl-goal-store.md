# 001 — Append-only JSONL goal store (proposed)

Status: proposed (promoted from findings during goal-store-4 implementation; flips to accepted at PR merge)

## Decision

The durable goal store is an **append-only JSONL log**: one JSON event per line in
`goals.jsonl` under the session directory. State is never rewritten in place;
read-back replays the log and returns exactly the last persisted tree.

- Event ops: `add` (full record), `update` (id + outcome), `set_status` (id + status).
- Record IDs are stable, runtime-assigned (`g<seq>`); the next sequence is derived
  from the maximum persisted id on reload — no separate id file.
- Path convention: `<session-dir>/goals.jsonl`.

## Rationale

Preserves provenance of every mutation (MVP §7.5 persistence across invocations)
and keeps writes O(1) appends. The rejected alternative — a single-file JSON
snapshot rewritten per mutation — loses provenance and is not crash-safer for our
fail-loud semantics.

## Consequences

Corruption (unparseable line, duplicate id, unknown op, dangling reference, invalid
origin/status) fails loud with `file:line` diagnostics; the store never silently
repairs or truncates (see decision 002). Contract fields (`statement`, `done_when`,
`contributes`) are immutable once written (issue #4 ext 2.a).

Implementation: `src/store/store.ts` (`GOALS_LOG_FILE`, `GoalStore.open`).
