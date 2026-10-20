## 2026-10-20 | goal-tree-b1/unit-006 | leave
- affected: src/extension.ts
- decision: leave: keep all goal_* tool definitions, store, and extension wiring in a single src/extension.ts (384 lines, no internal module candidates observed)
- reason: single module; no co-change evidence for a split; structure pass reduced: substrate registry generator is Python-AST-only and cannot parse TypeScript, so blast radius was analyzed manually (one source file, all call sites external/rigid)
