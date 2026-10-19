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

## Status

Design phase. Requirements for the MVP (Slice 1) and Slice 2 are defined;
implementation has not started.

---
🤖 LLM authored
