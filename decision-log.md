## 2026-10-20 | goal-tree-b1/unit-006 | leave
- affected: src/extension.ts
- decision: leave: keep all goal_* tool definitions, store, and extension wiring in a single src/extension.ts (384 lines, no internal module candidates observed)
- reason: single module; no co-change evidence for a split; structure pass reduced: substrate registry generator is Python-AST-only and cannot parse TypeScript, so blast radius was analyzed manually (one source file, all call sites external/rigid)
## 2026-10-21 | goal-tree-b1/pr15-R2F1 | store compaction on root completion
- affected: src/extension.ts
- decision: adopt delete-on-root-completion (review R2.F1, operator-amended): when a root goal is done, the per-session store file is compacted — the root tree's records are rewritten out, one terminal completion record (with outcome) is kept, and other trees sharing the file are untouched. Rewrite is temp-file + fsync + atomic rename. Date-based sweep for abandoned session files is explicitly deferred to a future work item.
- reason: append-only session stores were never garbage-collected; per-root compaction preserves R2's extend-only history within a run while bounding store growth across runs.

## 2026-10-21 | goal-tree-b1/pr15-R3F3 | failure semantics of derive and rewrite (R21 trace)
- affected: src/extension.ts
- decision: record the failure semantics as implemented (PR !15 round-3 finding R3.F3): the derive path is fail-open per R21 — `readStoreRecords` returns `[]` on any read/parse error (an unreadable or corrupt store means no tree, never a crash), `applyOperation` maps a `deriveTree` invariant violation to a concise tool error without appending, and compaction (`compactedRecords`) silently skips on an inconsistent store so the session is never blocked. The rewrite path (`rewriteStore`) is deliberately fail-loud: a failed compaction write raises, because silently swallowing a durability failure could lose completed-tree records while reporting success.
- reason: R21 requires monitoring/projection failures never block or crash the session, but the compaction rewrite is not a monitoring path — it is the durability boundary for record loss, so it must surface its failure instead of fail-open.
