# goal-stacker — Agent Configuration

## Development methodology

This project uses emergent contract coding; always use the
`emergent-contract-coding` skill for development. The skill covers both the
write loop (one specification implemented or changed, ending in one commit)
and the structure pass that ends every work item.

### Write loop

For every work item, execute the write loop in full, in the skill's step
order: read the specification and identify its input and output interfaces;
walk the contracts backwards from the output interfaces, collecting
contracts only; judge whole-contract fit before reusing any lax interface;
write the flow as one linear check-then-act function with external effects
late; handle capability wishes strictly in the skill's 5.a–5.d order; author
behavior-level verification as part of the work item; then hand off to the
structure pass. Do not skip, reorder, or partially apply these steps.

### Structure pass

Every work item ends with the structure pass, in the skill's step order:
regenerate and check the registry; list the blast radius; give every
relevant call site an explicit outcome; run the interface-change check;
run the merge test with its exclusions; make exactly one structure decision
per candidate and record it via `contracts log append`; shape the outcome;
run the liveness check where callers were removed; then commit with the
full gate green. The commit gate (`npm run verify`) runs `contracts check`
and `contracts log check` together with typecheck and the full test suite.

### Rigid interfaces

Classify as rigid interfaces — never change their contracts, route wishes
through the write loop's 5.c — all boundaries to code this project does not
own:

- **Input:** the pi coding agent's event handling — the session/tick
  lifecycle, event payloads, and control flow by which the agent invokes
  this code.
- **Output:** the pi coding agent's API surface (its exports, session APIs,
  and extension/tool contracts) and every npm library API surface this
  project depends on (e.g. `node:fs`, `node:path`, `node:os`, `vitest`,
  `typescript`), at the exact API level the code calls.

The general rule: any function call that leaves the program — to the host
agent, the runtime, or a third-party library — crosses a rigid interface.
Record each such surface as a rigid interface when first called. Never
introduce a wrapper or invented middle layer to soften one; call rigid
interfaces directly, and satisfy new needs through their existing contracts
or the skill's capability-wish order.

### Experiment lessons (goal-stacker experiment #1)

- **Story slicing is always an interface to an interface.** Any story or
  feature request anchored on an unproven internal / lax interface is not fit
  for purpose on this repo. A contract has no value without evidence; design
  tasks must start from the rigid input interface (the pi coding agent's
  event handling) and walk backwards — never bottom-up from an internal
  store or module.
- **Tool calls are lax input interfaces.** We define the tool-call surface
  ourselves, so any tool call may be defined as deemed necessary, and a
  story may be written on its behavior. This is the one sanctioned form of
  interface-first slicing.

The skill references substrate scripts (`contracts generate` / `check` /
`affected` / `log append` / `log check`) by name — implement or locate them
as the project reaches the point of needing them.
