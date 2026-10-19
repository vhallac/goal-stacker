# 003 — Goal status model enforced as write-time transitions (proposed)

Status: proposed (promoted from findings during goal-store-4 implementation; flips to accepted at PR merge)

## Decision

Goal statuses (`pending`, `active`, `expanded`, `done`, `dropped`, `failed`,
`blocked`) form a state machine enforced at write time:

```
pending → active | dropped
active → expanded | done | failed | blocked
blocked → active | dropped
expanded, done, dropped, failed  (terminal — no outgoing)
```

Illegal transitions are rejected with a concise error; the log is unchanged.

## Rationale

Per groomed issue #4: `blocked → active` exists via `select_goal`, and
`expanded` is a status (not a separate record kind) reflecting the MVP's
progressive elaboration. Making this a write-time guard (not a doc-only
convention) keeps the store's persisted history always transition-legal.

## Consequences

`setStatus` is the only mutation path for status; a status change that the model
later rules out requires an explicit new decision and a migration, not a code
tweak.

Implementation: `TRANSITIONS` map in `src/store/store.ts`; all 15 legal/illegal
cases tested in `test/store/rejection.test.ts`.
