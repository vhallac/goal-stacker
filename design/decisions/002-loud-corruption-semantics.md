# 002 — Loud corruption semantics: no silent repair (proposed)

Status: proposed (promoted from findings during goal-store-4 implementation; flips to accepted at PR merge)

## Decision

On unreadable or integrity-failed goal state, the store throws a diagnostic error
identifying the file and line and **never repairs, truncates, or reconstructs**
state. Rejection of an illegal mutation leaves the tree unchanged.

## Rationale

Issue #4 ext 3.a (extend-only history, R2): the goal tree is the source of
continuity across context destruction; silently repairing it would fabricate
continuity the model cannot trust. This deliberately rules out opportunistic log
truncation as an error-recovery strategy.

## Consequences

A corrupt `goals.jsonl` blocks all store operations until a human intervenes.
If crash-recovery UX later demands soft failure, this decision must be revisited
explicitly — `veto at review` scope.

Implementation: `src/store/store.ts` replay + write-time guards; tests in
`test/store/rejection.test.ts`.
