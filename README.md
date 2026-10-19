# goal-stacker

A pi extension that constructs and maintains a **goal tree** for a session and
uses it to continuously expand and contract the working context.

The core idea: a model directs multi-step work more reliably when it works
through a persistent, progressively elaborated goal tree — it attempts one
selected goal under a bounded budget, records an explicit outcome, and
explicitly decides what work exists and what runs next. Intent survives
context destruction; the tree, not the transcript, is the source of continuity.

## Requirements documents

All requirements live under [`design/requirements/`](design/requirements/):

| Document | Contents |
|---|---|
| [`goal-stacker-requirements.md`](design/requirements/goal-stacker-requirements.md) | Full user-level requirements (R1–R22) and the solution shape, with an appendix of open items and future gaps. Source document for all implementation slices. |
| [`goal-tree-mvp.md`](design/requirements/goal-tree-mvp.md) | **Slice 1 — the goal tree (MVP).** Persistent, progressively elaborated tree; explicit attempt endings; tree-control operations; the phase boundary between execution and tree control; persistence across model invocations. |
| [`goal-tree-slice-2-tool-guardrails-and-evidence.md`](design/requirements/goal-tree-slice-2-tool-guardrails-and-evidence.md) | **Slice 2 — tool policy and completion evidence.** Per-attempt tool-call budget, tool intent labels, a runtime-owned call ledger, outcome claims with reference checks, and verification-freshness labelling. |

Future slices are selected from the main requirements as experiments reveal
what is needed — they are not pulled forward merely for completeness.

## Decision records

Implementation decisions live under [`design/decisions/`](design/decisions/),
indexed in its [`README.md`](design/decisions/README.md). Records are `proposed`
when written during implementation and flipped to `accepted` at PR merge.

## Implementation

The durable goal store (MVP Slice 1, issue #4) lives in `src/store/`:

- **Location:** `src/store/store.ts` (store behavior and public exports:
  `GoalStore`, `StoreError`, `GOALS_LOG_FILE`), `src/store/types.ts` (record
  types). TypeScript — pi extension runtime (decision: language assumption
  approved by the operator). There is no barrel module: consumers import from
  these files directly.
- **Loading:** `GoalStore.open(sessionDir)` reads the goal log from the given
  session directory and replays it to the last persisted state. An empty or
  absent log initializes an empty tree (no root). Corruption fails loud —
  no silent repair.
- **JSON log path convention:** `<session-dir>/goals.jsonl` — append-only, one
  JSON event per line (`add`, `update`, `set_status`). See decision 001.
- **Status model:** `pending/active/expanded/done/dropped/failed/blocked` with
  legal transitions enforced at write time. See decision 003.
- **Contract immutability:** `statement`, `done_when`, `contributes` are
  immutable once written (issue #4 ext 2.a).
- **Tests:** `npx vitest run` (round-trip persistence per MVP §7.5, rejection,
  corruption diagnostics); type gate `npx tsc --noEmit`.

## Status

Requirements for the MVP (Slice 1) and Slice 2 are defined. The MVP goal store
(`src/store/`) is implemented; the rendered invocation view and tree-control
operations are not yet started.

---
🤖 LLM authored
