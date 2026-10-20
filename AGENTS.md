# goal-stacker — Agent Configuration

## Development methodology

This project uses emergent contract coding. This is a pilot repository for
the methodology: by reflex, every development activity here starts from the
`emergent-contract-coding` skill — slicing features into issues, writing a
design, implementing a specification, fixing a bug, or restructuring code.
When in doubt about how to do any of these, consult the skill before acting.
The skill covers both the write loop (one specification implemented or
changed, ending in one commit) and the structure pass that ends every work
item.

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

### Slicing features or requirements into issues

- Every issue must be a full behavior: from an input interface, through the
  implemented flow, to one or more output interfaces, and back. Do not slice
  along module, layer, or store boundaries.
- Input interfaces may be lax or rigid. The rigid input interface is the pi
  coding agent's event handling; lax input interfaces are the surfaces this
  project defines itself — tool calls and extension commands. Start slicing
  from an input interface (rigid or lax) and walk backwards from the outputs.
  Never slice bottom-up from an internal store, module, or
  planned-but-unproven internal interface.
- A story anchored on an unproven internal or lax interface is not fit for
  purpose. If a needed interface does not exist yet, define it as a tool
  call (the one sanctioned form of interface-first slicing) or de-risk it
  with a spike that exercises the rigid input interface first.
- Include the de-risking spike in the initial issue set when the input
  interface is not yet proven; do not defer it to a later phase.
- Make dependencies between slices explicit, and keep each slice
  independently verifiable through behavior-level acceptance tests.

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

These lessons motivated the slicing directives above; they are retained as
rationale and remain binding:

- **Story slicing is always an interface to an interface.** A contract has
  no value without evidence; design tasks must start from the rigid input
  interface and walk backwards — never bottom-up from an internal store or
  module.
- **Tool calls and extension commands are the lax input interfaces.** Their
  surfaces are defined by this project, not fixed by the host, so a tool
  call or extension command may be defined as deemed necessary, and a story
  may be written on its behavior. This is the one sanctioned form of
  interface-first slicing.

The skill references substrate scripts (`contracts generate` / `check` /
`affected` / `log append` / `log check`) by name — implement or locate them
as the project reaches the point of needing them.

## Running the substrate scripts

The scripts live in the emergent-contract-coding skill
(`~/.pi/agent/git/github.com/vhallac/lopsided-skills/skills/emergent-contract-coding/scripts/`).
They need `tree-sitter` + `tree-sitter-typescript` for TypeScript extraction;
do not create venvs or install them system-wide — run everything through uv's
ephemeral dependencies instead:

```bash
uv run --with tree-sitter --with tree-sitter-typescript python \
  ~/.pi/agent/git/github.com/vhallac/lopsided-skills/skills/emergent-contract-coding/scripts/contracts-cli.py generate
```

Without the `--with` flags the CLI still works, but skips TS files and the TS
tests are skipped, not failed.
