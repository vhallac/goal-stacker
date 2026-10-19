# Goal-tree MVP — Slice 1: The Goal Tree

Status: implementation slice derived from `goal-stacker-requirements.md`.

This document defines the first testable slice, not a replacement for the main requirements. Future slices should be selected from the main requirements as experiments reveal what is needed; they should not be pulled into this slice merely for completeness.

## 1. Hypothesis

A model can direct multi-step work more reliably when it works through a persistent, progressively elaborated goal tree: it attempts one selected goal, records an outcome, and explicitly decides what work exists and what runs next.

The first slice tests whether the tree changes how the model approaches and carries out work. It deliberately does not attempt context compaction, inference-cost optimization, advanced verification, automatic retry, or concurrency.

## 2. Required behaviour

1. **A prompt starts a tree.** The runtime creates a root goal from the prompt and selects it.
2. **At most one goal is active.** A goal is either pending, active, expanded, done, dropped, failed, or blocked.
3. **Work proceeds through the tree.** The model can act on the active goal or expand it one level into child goals. No complete plan is required up front.
4. **An attempt must end explicitly.** Ending an attempt or expanding a goal leaves no active goal. The model must use a tree-control operation before ordinary work can resume.
5. **Tree changes use operations.** Prose cannot create or change goals. Invalid operations leave the tree unchanged and return a concise error.
6. **Parents are completed explicitly.** Finishing all children does not automatically finish their parent; the model must contract their outcomes against the parent's goal.
7. **The tree persists across model invocations.** A later invocation receives enough of the current tree and its outcomes to choose the next action.

## 3. Minimal goal record

Each goal has:

- `id`: stable, runtime-assigned identifier;
- `parent`: parent ID, absent for the root;
- `statement`: concise description of the work;
- `done_when`: optional observable completion conditions;
- `contributes`: for children, what they contribute to the parent;
- `origin`: prompt, expansion, or explicit addition;
- `status`;
- `outcome`: a compact report when the attempt ends.

The root statement preserves the user's prompt verbatim. Existing goal contracts are not silently rewritten. Add child goals to elaborate work, or start a new run if the direction itself must change.

An outcome need only report what was accomplished, what was learned, and what remains. Strict evidence validation is deferred to Slice 2.

## 4. Operations

### While a goal is active

- **`end_goal_attempt(disposition, outcome)`** — ends the current attempt as `satisfied`, `failed`, or `blocked`, and records its outcome.
- **`expand_goal(children, findings)`** — atomically adds a non-empty set of pending children under the active goal, records any useful findings, and ends the attempt. Either all children are added or none are.

### While no goal is active

- **`select_goal(id)`** — selects a pending leaf.
- **`add_and_select_goal(parent, contract)`** — atomically adds one goal under an eligible, unfinished parent and selects it.
- **`drop_goal(id, reason)`** — drops a pending goal that is no longer needed; the reason states why the parent remains covered.
- **`contract_children(parent, verdict, outcome)`** — evaluates the completed or dropped children against the parent's goal. The parent becomes done only if the verdict is satisfied; otherwise it becomes failed and the run stops for inspection.
- **`stop_work(reason)`** — ends the run. A run is successful only if the root is done; otherwise the run stops with the reason visible.

A parent may be contracted only when all its children are done or dropped. New work cannot be attached silently to a completed parent; use an unfinished parent or start a new run.

## 5. The phase boundary

The runtime enforces the distinction between execution and tree control:

- With an active goal, ordinary task tools and the two ending operations are available.
- With no active goal, only tree-control operations are available.
- After an ending operation, an ordinary tool call must not execute until a goal is selected again.

This is a functional requirement; the implementation may handle conflicting or batched calls internally. The model does not need to follow a separate tool-call ordering protocol.

## 6. What the next invocation sees

Provide a compact current-state view containing:

- the original root prompt;
- the active goal and its ancestors, if any;
- pending goals available for selection;
- relevant completed child outcomes;
- the current phase and available tree operations.

Keep the durable tree separate from this rendered view. Do not implement transcript dropping or compaction in this slice; historical context may continue to grow.

## 7. Acceptance tests

1. **Direct work:** a small task can finish in one attempt without unnecessary expansion.
2. **Progressive elaboration:** an ambiguous task can expand into useful children and select them one at a time.
3. **Explicit collection:** completed children do not make the parent done automatically; an explicit contract operation is required.
4. **Phase boundary:** after an attempt ends, ordinary tool calls are rejected until a goal is selected. Invalid calls do not corrupt the tree.
5. **Persistence:** the tree and published outcomes are available on the next model invocation.
6. **Useful direction:** trace inspection shows that earlier outcomes influence later goal selection or changes to the tree.

Run a small fixed set of multi-step coding tasks and inspect the traces manually. The question is whether the tree changes how work is directed, not how many goals are created.

## 8. Out of scope for this slice

- Strict evidence ledger and verification rules;
- per-tool intent classification and goal-type tool policy;
- attempt tool-call budgets;
- automatic successor-tree minting or retry loops;
- advanced interruption recovery and branch-navigation handling;
- user steering during a run;
- context dropping, compaction, and cost optimization;
- automated continuation, concurrency, and dispatch.
