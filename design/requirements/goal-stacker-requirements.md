# Goal-stacker — Requirements

Working name for analysis only. The name does not denote a product; below, the
system is "the system" or "the extension". It is the pi extension that
constructs and maintains a goal tree for a session and uses it to continuously
expand and contract the working context.

Status: requirements level. The solution shape summarizes decisions already
recorded in the project notes (referenced by card ID, e.g. `2.29`); the
appendix collects what is still undecided. Companion source documents:
`goal-assisted-work.md` (harness business requirements),
`structured-work-ideas.md` (design ideas).

---

## 1. User-level requirements

### Intent and structure

- **R1 — Intent continuity.** A fresh round must be able to recover what
  unfinished work is being advanced and why, without reconstructing the
  transcript. Context destruction must not destroy intention.
- **R2 — Extend-only history.** Past intentions are never rewritten or
  deleted. When knowledge makes a branch wrong, it is marked with its reason
  and replaced by new nodes; obsolete branches stay visible as provenance.
- **R3 — Progressive elaboration.** Work begins with a coarse direction and
  decomposes as evidence arrives. The system must not require a complete
  upfront plan, and must not reward over-decomposition before research.
- **R4 — Stable addresses.** Every unit of planned work has a stable,
  human-readable address that is never reused or renumbered, so historical
  entries always point at the correct piece of work.

### Execution discipline

- **R5 — Bounded attempts.** One round corresponds to one bounded attempt to
  advance one selected goal. A round may finish the goal, decompose it,
  supersede it, block, or stop at a gate — it may not drift between goals.
- **R6 — No unbounded work.** No piece of work runs without an external
  budget. On exhaustion, the attempt's own transcript becomes evidence for a
  forced re-verdict (act again, expand, or repair) — bounded by construction,
  not by the model's judgment of its own progress.
- **R7 — Act-or-expand allocation.** Each node is either acted on under
  budget or expanded into a single-level list of children. The allocation
  decision must be made on cost grounds — what acting in place costs in
  accumulated context versus what writing and publishing a contract costs —
  and under uncertainty must prefer expansion, because a premature act is the
  expensive error.
- **R8 — Two-part results.** A task's result has a backward-looking part
  (the report its parent's composition consumes) and a forward-looking part
  (information pre-positioned for later steps); either may be empty.

### Context economy

- **R9 — Inherited context.** A node's context is inherited, never assembled:
  ancestor contracts, the parent's collected outcome, and the carried working
  state flow down the lineage. Transcripts are not inherited; the inherited
  unit is the contract-sized summary, not the history.
- **R10 — Compact ambient view.** The context a round starts with carries only
  a bounded projection: root objective, active ancestor path, current goal,
  the local frontier, and recent changes. Everything else is loaded on demand
  through tools. The full tree must never be dumped into context.
- **R11 — Context contracts at planned boundaries.** Completed work collapses
  to its published results at deliberate cut points (contract completions),
  not only at token thresholds. Dropping a round's data must be implemented as
  a custom, LLM-free compaction step through pi's compaction mechanism, so the
  session remains semantically coherent at high drop frequency.
- **R12 — Loss-safe compaction.** Whatever survives a compaction or a round
  drop must exist as published state (contracts, results) before the drop
  happens; nothing may depend on material that only lived in the dropped span.

### Decomposition and completion quality

- **R13 — Asserted completion.** A goal is done only when its completion is
  asserted against its own contract with evidence, honest where verification
  is weak. A parent is never done merely because its children are.
- **R14 — Bad decomposition is caught before it is paid for.** At expansion,
  it must be checkable that the children's contracts together cover the
  parent's output before any child runs. A failed check routes to repair:
  add children, replace a child's work, or re-plan the node.
- **R15 — Failures stay visible.** Dead ends, failed attempts, and bad
  assumptions are durable state. No failure path may be silently absorbed;
  a later round must be able to learn why a branch died and what replaced it.

### Human supervision

- **R16 — Gates are the normal contract.** Meaningful work proceeds as:
  bounded chunk → short report (completed / learned / plan change / evidence
  sample / next) → explicit proceed. Progress-sampling gates fire even when
  nothing is wrong. Supervision must be cheap enough to catch drift early
  without turning every action into an approval ceremony.
- **R17 — Two distinct stop types.** A runtime checkpoint is a sensible
  boundary that may continue automatically after context rebuild; a human
  gate waits for the operator. They must not be conflated.

### Continuation

- **R18 — The model does not decide to continue.** Continuation across rounds
  is an infrastructure decision driven by the tree state, with guards (round
  cap, no-progress detection, blocked stops). The model executes one bounded
  attempt and records its outcome.

### Operational

- **R19 — Cheap instrumentation.** Everything asked of the executor on every
  turn must be small and simple enough that a weak model fills it in
  correctly, never as boilerplate. The command surface admits no edit
  operations, so append-only discipline is mechanical rather than remembered.
- **R20 — Cost discipline.** Context handling follows the inference cost
  model: the running cost of context is paid per decode step, and only
  removing tokens lowers it. Compaction prefers tail cuts that keep the
  retained prefix's cache; summaries are reused from work already paid for
  before any new summarization is commissioned.
- **R21 — Fail open.** A failure in compaction, projection, or any monitoring
  path must never block or crash the session.
- **R22 — Explicit invocation.** The discipline is opt-in per task
  ("work on X with structured work"), not an automatic mode; trivial or
  fully known work should not pay its ceremony.

---

## 2. Solution shape

Based on the decisions recorded in the notes. Card IDs cite the decision.

### 2.1 Data model

- Append-only store over an event-sourced tree: status transitions and
  structure changes append as events; the current tree view is a projection
  (`2.3`). Tree-first, with a small set of typed cross-links
  (depends_on / supersedes / derived_from) — not a graph database (`2.8`).
- Node minimum is tiny: id, parent, one-sentence statement, status, origin.
  Rationale, success criteria, results, evidence, findings, children, and
  status history are loaded on demand (`2.6`).
- Six statuses with hard distinctions: pending / active / done / blocked /
  abandoned / superseded. Completion is asserted, never inferred (`2.7`).
- Findings are node-linked and queryable across the task, in five categories:
  finding, decision, error, evidence, result (`2.10`).
- Address amendment is cancel-then-add, never modify; IDs never reused
  (`2.19.1`).

### 2.2 Contracts: expansion writes the summary

- Expanding a node writes its contract: input, scope, output. There is no
  summarizer in the loop — the output field is the summary, written at
  expansion while the context is clean, instead of extracted from a polluted
  span at collapse. Execution ends by publishing output that satisfies the
  contract; publication is fulfillment (`5.1`).
- Collect is intelligent composition of children's published outputs toward
  the parent's contract, not mechanical assembly (`5.1` verdict 1).
- Results carry both parts (R8): backward-looking into collect,
  forward-looking into the carried state (`5.5`, `5.2`).
- Persistent state is threaded node to node, monad-like; the tree's own
  shape and published outcomes are part of that state (`5.2`). The three
  continuity kinds — working state, intent, history — travel separately and
  are never collapsed (`2.18`).

### 2.3 Allocator: act under budget, or expand one level

- The central runtime decision: every node is either acted on under an
  external token/step budget or expanded into a single-level partition list
  with contracts. The tree emerges from repeated single-level expansions;
  children are disjoint partitions, never whole-task re-descriptions
  (`2.29`).
- Closed-form gate: expand when the subtree's in-place context cost exceeds
  the cost of writing and publishing its contract. The per-node estimate is
  two numbers: how much decode this will take, how much context it will drag
  (`2.29.1`). The practical instantiation is a size estimate — small changes
  (order of hundreds of changed lines, a handful of files) act directly;
  larger ones expand into a plan (`2.29.1.1`).
- Budget exhaustion forces a re-verdict with the attempt's transcript as
  evidence; the failed probe becomes cheap decomposition input rather than
  wasted grind (`2.29`, `2.27.1`).
- The verdict may be delegated to a cheap bounded classifier over a closed
  choice set when one is available; until then the gate's estimate serves,
  and verdicts are logged for later calibration (`3`, `3.5`).

### 2.4 Expansion gate and repair

- Sufficiency gate at expand time: before any child decodes, check coverage
  (every parent output element has a declared source), composability
  (derivations well-typed and non-contradictory), and determinability
  (guarantees entail the fields, not merely fill same-named slots). The "no"
  is sound even where the "yes" carries residual risk; a miss costs latency
  of detection, not correctness, because the same predicate runs again at
  collect on real outputs (`5.1.4`, `5.1.4.1`).
- Feasibility is deliberately not certified at the gate; it is discharged
  downward by recursion — each child faces its own gate and its own budget
  (`5.1.4.2`).
- Collect is a fixpoint: check → compose or repair → re-check. The repair
  ladder, ordered by paid work salvaged: compose (gather what is there),
  augment (add children for missing sources), supersede (replace a child's
  work), re-plan (discard the child set and re-expand). The failure signature
  on the derivation sketch routes to the rung; if repairing means fighting
  the decomposition structure, it is re-plan regardless of how little is
  missing (`5.1.1`, `5.1.3`). All rungs preserve extend-only history.

### 2.5 Context expansion and contraction

- Ambient projection provider: rich external state plus deliberate tools for
  detail access, plus a tiny provider that renders the bounded projection at
  round construction and owns no semantics of its own (`2.16`, `2.17`).
  The projection is a computed view of inherited state, never authored
  context.
- Planned collapse: at contract completions the tree contracts to its
  published outcomes; the collapsed nodes are marked superseded-by-outcome in
  the durable store while only the in-context representation shrinks (`5`,
  `2.29.2`).
- Summary placement ranking: reuse the contract (already paid) before
  in-stream capture; out-of-stream summarization is a quality purchase, not
  an economy (`5.3`).
- Round-data dropping is a custom, LLM-free compaction step: because the
  contracts and outcomes already are the summary, dropping a round is
  loss-safe by construction and may run frequently (`5.6`, `5.1`). Ordering
  constraint: publish, then drop (R12).
- Cost basis: prefill is covered by caching; the running cost is the
  per-step read of the surviving context, and only truncation attacks it.
  Tail truncation keeps the retained prefix's cache; mid-history rewrites
  burn the suffix too and are reserved for cases that pay for themselves
  (`6`, `6.1`, `6.2`, `6.3`). The same mechanism ordering holds locally and
  in the cloud; only the trigger points move (`6.4`).

### 2.6 Rounds, gates, and continuation

- A round is one bounded attempt at one frontier goal (R5). Runtime
  checkpoints and human gates are separate mechanisms with separate triggers
  (`2.12`, `2.15`); gates are the normal execution contract, with a small
  report template and explicit proceed (`2.22`).
- Continuation runs through an armed, state-decided pump at the end of each
  attempt: it reads the frontier and schedules the next attempt, with guards
  (round cap, unchanged frontier ⇒ stop and surface, blocked ⇒ stop,
  terminal ⇒ disarm). The model never decides to keep going (`2.12.1`).
- The in-round work is structured by a lazy goal tree: the leader's brief is
  the root contract, expansion fires only on a budget trip, and the fixed
  cost is bookkeeping. Below the tree, session compaction survives as
  evidence hygiene between contract boundaries (`2.29.2`).

### 2.7 Architecture stance

- Work-decomposition (in-round tree) and deliverable-decomposition (leader's
  job) are separate layers; the system owns the former (`2.29.2`, `2.20.1`).
- Node contracts are model-portable work specifications, so per-node executor
  affinity and any advisory escalation are roster entries over the same
  object, not bespoke mechanisms (`2.20.3`).
- Build now in the leader-locked, serial form, but serialize the in-round
  tree onto the shared graph substrate — same contracts, provenance log, and
  repair operations — so that moving to a concurrent, worker-reachable form
  later is a lift, not a rewrite. Three measurable triggers flip that
  decision: leader round-trips dominating the gate cost, serial wall-clock
  becoming the bottleneck on genuinely fan-out-shaped work, or repair
  handoffs showing up as rework (`2.29.3`, `2.29.3.1`). Concurrency is
  deferred, not rejected; light primitives over heavy session machinery
  (`5.4`).
- Staged delivery: standalone semantics → explicit skill → projection
  provider → machine-enforced checkpoints → optional dispatch. Dogfood on
  real work at each stage; the evaluation targets are refinement behavior and
  intent recovery, not just task completion (`2.24`, `2.25`, `2.26`).

---

## 3. Appendix — open items, future requirements, gaps

### 3.1 Undecided design questions (recorded with defaults, resolved by use)

- Storage engine: event log vs mutable records with status history —
  semantics are append-only either way; avoid over-building (`2.28`).
- `superseded` vs `abandoned` boundary in practice; how reversible status
  changes should be (`2.28`).
- Human-gate frequency policy; whether checkpoints should ever be nodes
  themselves (`2.28`).
- Findings scope: node-linked but cross-queryable is the default; when a
  finding affects several branches, reference vs duplicate is open (`2.28`).
- How explicit success criteria must be per node; how the active goal is
  chosen beyond "model picks from the frontier" (`2.28`).
- Repository/package identity of the implementation (`2.28`).

### 3.2 Failure and lifecycle edges to design for

- **Interrupted attempt.** Every current failure path exits through the
  machinery (budget exhaustion, repair). A crash or interrupt mid-attempt
  leaves an active node with no published evidence: the next round must
  distinguish "failed attempt (transcript is evidence)" from "nothing
  happened". Unpinned.
- **Threaded-state growth.** The forward-looking results ride the carried
  state with no bound or trim policy; the accumulated state becomes exactly
  the context pollution the design exists to avoid. Needs a
  promotion/eviction rule (see also `9.1`, promotion out of the round
  archive).
- **Publish-before-drop ordering.** If round data is dropped before the
  outcome is durably published, loss-safety fails. The drop must be strictly
  downstream of publication; needs a hard ordering guarantee, not a
  convention.
- **One act blowing the context.** A single act can exhaust the context with
  no contract boundary in sight — the tree's blind spot. Whether the
  evidence-hygiene clip can fire mid-act without corrupting the tree's cut
  points is an open trigger-wiring question (`2.29.2`).
- **Attribution fallback.** A round that touches a second goal mid-attempt
  (discovered dependency, side effect) breaks the one-round-one-goal
  invariant with no defined fallback; misattribution to the last active node
  is the failure mode to avoid.
- **Reserved address for orientation work.** Pre-plan exploration has no
  node to sit under; a reserved address keeps it representable and loggable
  instead of misfiled or lost.
- **Executor-relative calibration.** Budgets and verdict thresholds are
  model-relative; histograms calibrated on one executor will misfire on
  another. Calibration data must be per-model, and resampled on model change
  (`2.27.2.2`, `2.29.1`).
- **Gate fatigue.** Gates are meant to be cheap and frequent; nothing bounds
  them yet. Combined with any escalation path, sustained failure can produce
  a nag loop — needs a cooldown/hysteresis policy.
- **Rote compliance.** Under mandatory fields, weak models may settle into
  boilerplate ("continuing investigation"). A repeated boilerplate entry is
  itself a stuck signal and should be treated as one.
- **Standing tension: built vs inherited.** The projection and compact node
  forms are built views; the inheritance principle requires they be computed
  views of inherited state, never authored content (`2.16` ↔ `2.20.2`).
  Resolve before implementation.
- **Standing tension: substrate serialization.** The bridge to the
  concurrent form requires serializing the in-round tree onto the shared
  graph substrate from day one; if the tree stays context-only, the bridge
  is lost (`2.29.3.1`).

### 3.3 Adjacent-layer requirements — decide in-scope or harness-side

These are stated in `goal-assisted-work.md` but not yet reflected in the
system's decisions. Decide whether they belong to this extension or to the
wider harness layer:

- **Address discipline for tool calls:** per-call attribution to a goal
  address; reserved address for orientation; invalid/closed address rejection
  returning the current tree and being logged as a signal in its own right.
- **Detection policy:** two-tier monitoring (free deterministic per-turn
  check plus periodic judge call), typed questions with an explicit
  "uncertain" band, shadow-mode logging for threshold tuning, no re-judging
  of materially unchanged state.
- **Escalation policy:** advisor guidance in two forms (one-off correction
  vs reusable procedure), harness-initiated escalation with cooldown and
  budget.
- **Preference seeding:** a revisable profile of operator conventions, with
  stated exceptions per dimension, shaping any advisory output.
- **Plan-summary reuse:** a compaction-produced summary doubling as the
  situation report handed to an advisor — the mechanism exists (`5.3`), the
  reuse requirement is not yet stated.

### 3.4 Deferred and future options

- **Partial rewind.** Dropping one child's span and re-injecting siblings'
  published outputs makes "supersede" nearly as cheap as "re-plan"
  (`5.1.2`) — an option once the basic ladder is in use.
- **Declared fallback alternatives.** Attaching alternative routes to a node
  at expansion (before execution, still discovered mid-work) refines the
  improvised replaces pattern; reconcile with extend-only history before
  adopting (`2.27.3`).
- **Classifier-delegated verdicts.** The act/expand verdict, escalation
  selection, and gate triage are all closed-choice verdict sites that a small
  dedicated model can staff; which readout wins per site is an open
  experiment (`3.3`, `3.6`, `4.1`, `4.2`).
- **Fan-out dispatch.** Independent discovered subtrees as dispatch units to
  team-mode execution, only after the sequential system works; contracts are
  the handoff unit (`2.20`, `2.20.3`, stage E in `2.25`).
- **Offline calibration from traces.** Tokens-per-node histograms from real
  runs set the budget sizes and verdict thresholds; run once a corpus exists
  (`2.27.2.4`).
- **Scope boundary watch.** The apparatus (contracts, threading, repair) is
  trending from "annotation layer on an agent" toward "the execution runtime
  itself" (`5.2`). That is a product-scope decision to make deliberately,
  not drift into.
