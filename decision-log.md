## 2026-10-20 | goal-tree-b1/unit-006 | leave
- affected: src/extension.ts
- decision: leave: keep all goal_* tool definitions, store, and extension wiring in a single src/extension.ts (384 lines, no internal module candidates observed)
- reason: single module; no co-change evidence for a split; structure pass reduced: substrate registry generator is Python-AST-only and cannot parse TypeScript, so blast radius was analyzed manually (one source file, all call sites external/rigid)
## 2026-10-21 | goal-tree-b1/pr15-R2F1 | store compaction on root completion
- affected: src/extension.ts
- decision: adopt delete-on-root-completion (review R2.F1, operator-amended): when a root goal is done, the per-session store file is compacted — the root tree's records are rewritten out, one terminal completion record (with outcome) is kept, and other trees sharing the file are untouched. Rewrite is temp-file + fsync + atomic rename. Date-based sweep for abandoned session files is explicitly deferred to a future work item.
- reason: append-only session stores were never garbage-collected; per-root compaction preserves R2's extend-only history within a run while bounding store growth across runs.
