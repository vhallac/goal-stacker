# Decision records

Numbered decision records for goal-stacker. Each record is `proposed` when
written during implementation and flipped to `accepted` at PR merge (or
`rejected` with a one-line reason). Requirements-level decisions live in
[`design/requirements/`](../requirements/) with card IDs citing the decision.

| ID | Title | Status |
|---|---|---|
| [001](001-append-only-jsonl-goal-store.md) | Append-only JSONL goal store | proposed |
| [002](002-loud-corruption-semantics.md) | Loud corruption semantics: no silent repair | proposed |
| [003](003-status-model-as-write-guard.md) | Goal status model enforced as write-time transitions | proposed |
