# FABLE — Agent Work Allocation

Rule: **never two agents in the same file concurrently.** Ownership is by file, not by ticket.

## Slot definitions

| Slot | Suggested model | Rationale |
|---|---|---|
| A (mechanical/build) | Gemini (or any capable fast model) | file deletions, config changes, script edits — low ambiguity, needs care not skill |
| B (Rust systems) | GPT-6.1 Terra | investigation lifecycle surgery, numerics — needs strong Rust reasoning |
| B2 (Rust numerics) | GPT-6.1 Terra | same file-family as B → same agent, sequential |
| C (cross-language consolidation) | GPT-6.1 Terra or Fable | taxonomy/data design across Rust+TS |
| D (ecosystem) | Gemini | separate repo, independent |
| Human | RADIN | W0-1 commit decision, wrangler access for W0-4, evidence review |

## File ownership map

| Files | Owner slot |
|---|---|
| `apps/api/src/app.ts`, `apps/api/test/nani*` | T-01 (A) → then C |
| `scripts/desktop-package.mjs`, `.gitignore` | T-08/T-10 (A) |
| `apps/api/vitest.config.*`, `apps/web/vitest.config.*` | T-11 (A) |
| `apps/web/src/features/nani-reports/`, root junk, `apps/api/dist/*`, `evidence/` | T-10 (A) |
| `cloud/worker/migrations/` | T-10 (A, with human for wrangler) |
| `src-tauri/src/network_intelligence/investigation.rs`, `foundation.rs`, `sequential.rs`, `information_theory.rs`, `simulation.rs` | T-02, T-03 (B/B2 — same agent sequential) |
| `src-tauri/src/network_intelligence/bayesian.rs`, `math.rs` | T-04 (B2) |
| `src-tauri/src/network_intelligence/evaluation.rs`, `persistence.rs`, `src-tauri/src/commands/nani.rs` | T-05 (B2) |
| `src-tauri/src/network_intelligence/api_intelligence/failure_classifier.rs` | T-06 (C) |
| `packages/shared/*`, `apps/web/src/lib/failureIntelligence.ts`, `apps/api/src/services/naniDiagnosticAdapter.ts` | T-06 (C) |
| `apps/web/src/features/engines/EngineManagerPage.tsx`, `apps/api` engines route glue | T-07 (B) |
| `apps/api/src/db/*` | T-09 (B) |
| `apps/web/src/features/nani/NaniPage.tsx` + nani feature | T-05 (B2) — coordinate with C if T-06 touches shared nani types (it doesn't; failures only) |
| Bot repo | T-12 (D) |

## Parallel batches

1. **Batch 1** (after W0-1): A runs T-01 → then T-08, T-10, T-11. D starts T-12 immediately (independent repo).
2. **Batch 2** (after T-01 merges): B starts T-02 (Rust) while A finishes Batch 1 leftovers and B runs T-07/T-09? — No: B and B slots conflict only if same files; T-07 (web/engines) and T-09 (db) are disjoint from T-02 (Rust) → they can run in parallel with T-02, assigned to a second agent (Terra if two instances, else sequential after).
3. **Batch 3** (after T-02): B2 sequential chain T-03 → T-04 → T-05.
4. **Batch 4**: T-06 consolidation (C) — after T-01, any time; conflicts only with T-05 over `packages/shared` if both edit shared simultaneously → sequence T-05 before T-06, or keep T-06 to `src/failures/*` subtree (disjoint from T-05's nani DTO). Prefer: run T-06 after T-05 to keep `packages/shared` single-writer.

## Forbidden overlaps (hard rules)

- `packages/shared/src/nani/**` (T-05) and `packages/shared/src/failures/**` (T-06) are different subtrees, but `packages/shared/package.json` is shared → sequence, don't parallelize.
- Rust `mod.rs` may be touched by T-03 only (module deletion); T-02 must not rename modules.
- Never touch `sidecar.rs`/`elevation.rs`/`dpapi.rs`/`updater_feed.rs`/`killSwitch.ts`/`engineManager.ts` digest logic — none of the tickets require it; any perceived need escalates to the human.
