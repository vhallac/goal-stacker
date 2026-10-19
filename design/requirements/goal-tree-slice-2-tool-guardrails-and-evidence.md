# Goal-tree — Slice 2: Tool Policy and Completion Evidence

Status: follow-on slice built on `goal-tree-mvp.md` (Slice 1).

The main requirements remain the source for this and future slices. This document adds a small set of execution guardrails and evidence checks; it does not attempt to implement the entire runtime described in `goal-stacker-requirements.md`.

## 1. Purpose

Slice 1 establishes a persistent tree and the phase boundary between execution and tree control. Slice 2 adds per-call tool policy, a simple attempt budget, and inspectable evidence for outcomes.

## 2. Tool policy

Slice 1 already defines the phase boundary: ordinary task tools are available only while a goal is active, and tree-control operations are available after the attempt ends. This slice does not prescribe how that boundary is implemented. It adds policy based on the active goal and a simple attempt budget.

### Basic attempt budget

Each attempt has a configurable tool-call cap. Near the cap, the model receives a warning; at the cap, only the ending operations remain available. The ending outcome records the workspace condition as `clean`, `dirty`, or `unknown`, with a short explanation when it is not clean.

Start with one simple cap. Separate budgets by goal type or calibrate them from traces only if the first runs show a need.

### Tool intent

For tools whose intent cannot be inferred reliably, the call declares `read`, `mutate`, or `verify`. Obvious read/edit/write operations may use fixed intent mappings. The runtime uses the intent label for policy and measurement; it should not treat a model-provided label as proof that a verification was meaningful.

A knowledge-goal mutation restriction is optional within this slice: add it only if the first pilot actually uses knowledge goals and benefits from this distinction.

## 3. Basic completion evidence

### Runtime ledger

The runtime records tool calls for each attempt, with a stable ID, tool name, arguments summary, success/error status, sequence, and a link to the corresponding session entry where available. The model cannot edit ledger records.

### Outcome claims

An outcome may contain concise claims with references to supporting tool calls or previously published child outcomes. The runtime checks that references exist and point to the stated source. Claims from parent collection may reference child outcome IDs. A claim based on already-present contract/context need not invent a new tool call as evidence.

Do not build a general evidence graph or proof system. The purpose is to make the trace inspectable and catch missing or invalid references.

### Verification freshness

For a change goal, label completion `verified` when at least one successful `verify` call occurs after the last `mutate` call. Otherwise label it `unverified`; do not reject the outcome solely for being unverified.

This is a freshness heuristic, not a correctness proof. Keep that distinction visible in results.

A parent still requires explicit collection against its own goal. Its status must not be inferred solely from the statuses of its children.

## 4. Acceptance tests

1. At the attempt cap, ordinary tools are unavailable and the outcome records the workspace condition.
2. Ledger records are runtime-owned and remain available for inspection.
3. Invalid evidence references are rejected; valid references to tool calls and child outcomes are accepted.
4. A verification call that precedes the last mutation does not label the result verified.
5. Unverified completion remains possible and is clearly labelled.

## 5. Out of scope

- Proving that a `verify` action genuinely establishes correctness;
- automatic retry or successor-tree minting;
- full crash and branch-navigation recovery;
- detailed user-steering and interjection classification;
- calibrated, model-specific budgets;
- automated judging, advisors, escalation, and concurrency;
- context compaction or inference-cost optimization.

Use traces from Slice 1 to decide whether further guardrails are justified. Do not add policy merely because the main requirements describe a possible future need.
