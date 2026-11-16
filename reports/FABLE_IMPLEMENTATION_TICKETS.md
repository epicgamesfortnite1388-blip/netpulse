# FABLE — Implementation Tickets (contract format)

Each ticket: ID · owner-slot · objective · exact files · symbols · design ref · tests · commands · acceptance · risks · rollback · parallel-class.

| ID | Slot | Objective | Files (modify) | Files (read-only) | Key symbols | Design | Tests to write | Verify commands | Acceptance | Risks | Rollback | Parallel |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| T-01 | A | Gate Node NANI loops in desktop | `apps/api/src/app.ts`, `apps/api/test/naniShadowHealthLoop.test.ts` | `apps/web/src/features/nani/naniApi.ts` | `naniShadowHealth.start` (app.ts:897), `NaniService` (app.ts:608) | Blueprint T-01 | spy test: no `.start()` when `NETPULSE_DESKTOP=1` | `cd apps/api && npx vitest run test/nani*` | no Node NANI timers in desktop; web unchanged | a hidden consumer of shadow events — re-verify desktop UI event feed | single revert | GROUP-A |
| T-02 | B | Adaptive stopping wired | `src-tauri/src/network_intelligence/investigation.rs`, `foundation.rs` | `sequential.rs`, `information_theory.rs`, `diagnosis.rs`, `simulation.rs` | `run_observe_stage` (investigation.rs:528), `should_stop`, `select_best_diagnostic_probe`, `probe_api` | Blueprint T-02 | 15-condition simulator test with measured probe-count ratio | `cd src-tauri && cargo test network_intelligence` | flag-on adaptive runs; flag-off unchanged; no new dead-code | early-stop regression → min-probe floor | flag default off | GROUP-B (after T-01) |
| T-03 | B2 | Delete shelf exports | per `cargo check` dead list | — | listed in Corruption Audit C-02 | Blueprint T-03 | remove their unit tests too | `cargo check` → 0 "never"; `cargo test` green | zero dead-code in `network_intelligence` | symbol used by seam — compiler catches | revert | after T-02 |
| T-04 | B2 | Mixture likelihood | `src-tauri/src/network_intelligence/bayesian.rs` | `diagnosis.rs` (outcome sets) | `bayesian_update` (bayesian.rs:184) | Blueprint T-04 | property tests confidence attenuation; equivalence cfg(test) | `cargo test network_intelligence::bayesian` | property tests green; calibration not regressed | numeric drift in downstream tests | revert | after T-02 |
| T-05 | C | Continuous calibration | `evaluation.rs`, `persistence.rs`, `commands/nani.rs`, `apps/web/src/features/nani/NaniPage.tsx`, `packages/shared` (DTO) | — | evaluation Brier/ECE fns, `nani_math_*` command family | Blueprint T-05 | aggregator unit tests; persistence integration test; UI component test | `cargo test` + `cd apps/web && npx vitest run src/features/nani` | `nani_math_calibration` returns rolling stats; UI labels scores until thresholds | unknown verify outcomes skipped correctly | revert | after T-02/T-04 |
| T-06 | C | Classifier consolidation | `packages/shared/src/failures/*` (new), `apps/web/src/lib/failureIntelligence.ts`, `apps/api/src/services/naniDiagnosticAdapter.ts` | `failure_classifier.rs` | `classify` (Rust), TS mapping fns | Blueprint T-06 | golden fixture test both languages | `cargo test` + `npx vitest run` (api+web+shared) | single taxonomy; fixtures green | none (fixtures) | revert | after T-01 |
| T-07 | B | Pin UX + cache force | `apps/web/src/features/engines/EngineManagerPage.tsx`, `apps/api/src/routes/endpoints.ts` (or engines route), `engineManager.ts` (route glue only) | `engineManager.ts` digest logic (do not alter) | `checkLatestReleases`, `installEngine`, `installedEngineVersions` | Blueprint T-07 | component test unpinned state; cache-force unit test | `cd apps/web && npx vitest run src/features/engines` + api engines tests | refusal explained in UI; post-install versions fresh | none | revert | GROUP-B |
| T-08 | A | Packaging freshness gate | `scripts/desktop-package.mjs` | `scripts/prepare-desktop.mjs` | bundle mtime comparison | Blueprint T-08 | script test | `node scripts/desktop-package.mjs` with a touched source → exit 1 | gate enforced | CI override needed → `NETPULSE_SKIP_BUNDLE_FRESHNESS=1` | revert | GROUP-A |
| T-09 | B | SQLite quarantine | `apps/api/src/db/*` (init path) | `app.ts` | db init fn | Blueprint T-09 | truncated-DB fault test | `cd apps/api && npx vitest run` db tests | corrupt DB → quarantine + honest state, no crash | false-positive integrity fail → investigate before shipping | revert | GROUP-B |
| T-10 | A | Hygiene batch | deletions listed in Blueprint T-10; `.gitignore`; `cloud/worker/migrations` (renumber if needed); `reports/INDEX.md` (new) | `evidence/` review | — | Blueprint T-10 | none (mechanical) | `git status` clean; build + all suites green | junk gone; D1 ordering adjudicated | deleting a still-referenced dist chunk → verify imports first | revert | GROUP-A |
| T-11 | A | Test-suite split | `apps/api/vitest.config.*`, `apps/web/vitest.config.*` | test files | vitest projects config | Blueprint T-11 | none | `npx vitest run` timing + green | API < 120 s; flaky pool identified → keep isolation there | hidden shared-state flake in unit pool → bisect, keep isolate for the offender | revert | GROUP-A |
| T-12 | D | Bot pytest fix | Bot repo `tests/test_resilience.py` (+ conftest if needed) | Bot repo src | — | Blueprint T-12 | the fixed test | `pytest tests -q` in Bot repo | suite collects and passes | changes product code → stop, report | revert | independent |

## Sequencing

```
W0-1 (human/user: commit in-flight work)
   ├─ GROUP-A: T-01, T-08, T-10, T-11        (disjoint files, parallel)
   ├─ GROUP-B: T-02 (after T-01) ─┬─ T-03, T-04 (after T-02)
   │                              ├─ T-07, T-09 (parallel with T-02)
   │                              └─ T-05, T-06 (after T-02 + T-04)
   └─ GROUP-D: T-12 (anytime)
```
