# FABLE — Implementation Blueprint

For execution by other strong models (GPT-6.1 Terra, Gemini). Each ticket is designed to be implementable **without rediscovering the architecture**: this blueprint + the referenced symbols is sufficient context.

## Global constraints (all agents)

1. Baseline is the working tree **after W0-1 lands** (commit in-flight work). Never rebase over user changes.
2. Never touch: `sidecar.rs`, `elevation.rs`, `dpapi.rs`, `updater_feed.rs`, `killSwitch.ts`, `engineManager.ts` digest logic, cloud worker auth — except where a ticket names a specific line-level change.
3. Every ticket ends with: named tests green + `npx tsc --noEmit` (TS tickets) or `cargo check`/`cargo test` (Rust tickets) + a one-paragraph status note.
4. No new dependencies without a written justification in the ticket.
5. Worktree/file ownership: see `FABLE_AGENT_WORK_ALLOCATION.md` — never two agents in one file.

---

## TICKET T-01 · Desktop gate for Node NANI loops (W0-3)

1. **Objective**: the Node sidecar runs no NANI timers in desktop mode.
2. **Existing**: `app.ts:608` `const nani = new NaniService({...})`; `app.ts:651` `naniShadowHealth`; `app.ts:897` `naniShadowHealth.start()`.
3. **Design**: `const desktopMode = process.env['NETPULSE_DESKTOP'] === '1';` then `if (!desktopMode) naniShadowHealth.start();`. Keep `NaniService` constructed (routes still serve one-shot reads) — only the **loops** stop. If `NaniService` itself has internal timers, gate them identically (search `.start(` in `naniService.ts`).
4. **Files to modify**: `apps/api/src/app.ts`, `apps/api/test/naniShadowHealthLoop.test.ts` (new case).
5. **Files to preserve**: all NANI routes; Rust engine untouched.
6. **Tests to write**: with `NETPULSE_DESKTOP=1`, construct app context → assert `naniShadowHealth.start` not called (inject a spy via the existing deps seam).
7. **Commands**: `cd apps/api && npx vitest run test/nani*`.
8. **Acceptance**: no Node NANI timer starts under desktop env; web mode unchanged.
9. **Risks**: a desktop UI path reading `/nani/*` live data — verified none (`naniApi.ts` routes to Tauri when `hasTauriIpc()`); re-verify by running the desktop and checking `/api/v1/nani/*` returns static-but-honest data.
10. **Rollback**: revert the gate; single commit.

## TICKET T-02 · Adaptive stopping in the investigation loop (W1-1)

1. **Objective**: the automated observe loop selects probes by expected IG/cost and stops by the existing sequential rules.
2. **Existing**: `investigation.rs::run_observe_stage` (line ~528, probes all registered APIs via `probe_api`); `sequential.rs::{should_stop, cost_adjusted_gain, value_of_information}` (tested, unused); `diagnosis.rs::{expected_information_gain, rank_tests}`; `information_theory.rs::select_best_diagnostic_probe`.
3. **Design**: inside `run_lifecycle`'s observe stage, replace the for-all-APIs loop with:
   - `let mut engine = <current posterior>;`
   - `let min_probes = 3; let max_probes = config (default 24); let width_budget = 0.25;`
   - loop: if `should_stop(...)` (min floor respected) or budget exhausted → break; `best = select_best_diagnostic_probe(&engine)`; map best→registered API probe; run `probe_api`; `engine.observe(...)`; emit `Observed` event; update `InvestigationObservation` list.
   - Feature-flag: read env `NANI_ADAPTIVE_STOPPING` (default "0" → keep the old loop; "1" → adaptive). Log which mode ran in the investigation record.
4. **Files to modify**: `investigation.rs` (+ new tests), `foundation.rs` (expose flag knob if needed), `commands/nani.rs` (surface mode in status DTO — optional).
5. **Tests to write**: simulator-driven (`simulation.rs::NetworkSimulator`): for each of the 15 conditions, adaptive mode reaches the same MAP hypothesis with ≤ 60% of the fixed-plan probe count (tune threshold after measurement — record actual numbers in the test comment).
6. **Commands**: `cd src-tauri && cargo test network_intelligence`.
7. **Acceptance**: flag-on runs use adaptive loop and stop; flag-off unchanged; no new dead-code warnings.
8. **Risks**: stopping too early → min-probe floor; probe-API mapping (best probe may be a category without a registered API) → map categories to the closest registered API probe and skip when absent.
9. **Rollback**: default flag-off.

## TICKET T-03 · Shelf-export deletion (W1-2)

1. **Objective**: zero dead-code warnings in `network_intelligence`.
2. **Existing**: the compiler's never-used list (see Corruption Audit C-02; regenerate with `cargo check`).
3. **Design**: delete each symbol + its unit tests unless a W1-1/W1-4 ticket consumes it. Modules kept alive by T-02 (`sequential.rs`) stay. `hierarchical.rs`/`timeseries.rs`: if ALL their production refs are tests, delete the module and its tests (record in the ticket note); if partially used, prune symbols only.
4. **Files**: per compiler output. **Commands**: `cargo check 2>&1 | grep -c "never"` → 0; `cargo test` green.
5. **Risks**: deleting a symbol used by a macro/test seam — compiler re-run catches it.
6. **Rollback**: single revert commit.

## TICKET T-04 · Likelihood noise model (W1-3)

1. **Objective**: replace `ll * c` with a derived mixture likelihood.
2. **Existing**: `bayesian.rs::bayesian_update` lines ~205–208.
3. **Design**: `let eps = 1.0 - confidence.clamp(0.0,1.0); let ll' = log_sum_exp(&[ll + (1-eps).ln(), uninformative_loglik + eps.ln()])` where `uninformative_loglik` is the likelihood under a maximally non-committal outcome model (use `-(outcomes.len() as f64).ln()` of the test's outcome set; the engine knows the set — pass it in `Evidence` or default to a constant agreed with `diagnosis.rs`). Keep old behavior behind `#[cfg(test)]` for an equivalence test.
4. **Tests**: property test — identical `ll`, confidence 0.9 vs 0.3 → posterior moves less with 0.3; extreme confidences (0, 1) behave as no-evidence/full-evidence.
5. **Commands**: `cargo test network_intelligence::bayesian`.
6. **Risks**: changes posterior numerics → calibration suite (T-05) must not regress; run both.

## TICKET T-05 · Continuous calibration (W1-4)

1. **Objective**: every completed real investigation updates a rolling calibration record.
2. **Existing**: `evaluation.rs` (Brier/ECE — implemented, tested); `persistence.rs` (JSON store); `commands/nani.rs` command layer.
3. **Design**: at investigation COMPLETE/FAIL, record `(map_hypothesis, verify_outcome_correct: bool)`; keep rolling window (e.g. last 200) in `PersistenceStore`; add `nani_math_calibration` command returning `{brier, ece, n, window}`; UI: NaniPage shows "calibration: Brier 0.18 (n=87)" and labels posteriors as scores while `n < 100 || ece >= 0.10`.
4. **Files**: `evaluation.rs` (rolling aggregator), `persistence.rs` (record), `commands/nani.rs` (command), `apps/web/src/features/nani/*` (display), `packages/shared` (DTO type).
5. **Tests**: unit test aggregator math; integration test record persistence.
6. **Risks**: verify-outcome may be unknown (user disconnects) — only record investigations with a verified verify-stage result; count skipped separately.

## TICKET T-06 · Classifier consolidation (W1-5)

1. **Objective**: one failure taxonomy; TS becomes display mapping.
2. **Existing**: Rust `failure_classifier.rs` (authoritative for API layers), TS `lib/failureIntelligence.ts` (UI), `naniDiagnosticAdapter.ts` (mapping).
3. **Design**: export the taxonomy as data from `packages/shared` (const map kind→label/severity/icon); TS classifier logic that duplicates Rust semantics is replaced by a thin mapper over shared data. Cross-language golden set: a JSON fixture of probe inputs → expected category, run through both Rust test and TS test to prove equivalence during migration; afterwards the TS test reads only the shared data.
4. **Files**: as listed + `packages/shared/src/failures/*` (new data module).
5. **Tests**: golden fixture test in both languages.
6. **Risks**: low; pure refactor with fixtures.

## TICKET T-07 · Engine pin UX + cache force (W2-1/W2-2)

1. **Objective**: explain refusals; immediate post-install versions.
2. **Design**: `engineManager.checkLatestReleases` already returns `latestTag`; in `EngineManagerPage`, when install result error contains "not pinned", render the explainer state (release X published, pin missing in this build, update the app or wait). After `installEngine` success, call `installedEngineVersions({force:true})` (route-level).
3. **Tests**: component test with mocked outcome; unit test cache-force.
4. **Files**: `EngineManagerPage.tsx`, `engineManager.ts` (route glue), engines route.

## TICKET T-08 · Packaging freshness gate (W0-5)

1. **Objective**: `desktop:package` fails on stale bundle.
2. **Design**: in `scripts/desktop-package.mjs` before packaging: for each `apps/api/src/**/*.ts` newer than `src-tauri/backend/netpulse-backend.js` (mtime compare), exit 1 with instructions (`npm run build:desktop-backend`). Respect CI env override `NETPULSE_SKIP_BUNDLE_FRESHNESS=1` for legacy runs.
3. **Tests**: manual + a node script test (`scripts/*.test.mjs` pattern exists).

## TICKET T-09 · SQLite corruption quarantine (W2-3)

1. **Objective**: a corrupt local DB never crashes the app silently.
2. **Design**: at `apps/api/src/db` init, run `PRAGMA integrity_check` (cheap for this size); on failure: rename file to `corrupt-<ts>.sqlite`, recreate empty, publish event `db:corrupt-recovered`, mission-control row = `blocked` with the path. Never auto-delete user data.
3. **Tests**: fault-injection test writing a truncated DB file.

## TICKET T-10 · Hygiene batch (W0-2/W2-5/W0-4/FABLE-DOC-001)

1. Delete: `nani-reports/`, `aether-*.zip`, `.tmp-desktop-dev.log`, `.scratch-*`, `dist-desktop/`, `.staging-dist/`, stale `apps/api/dist/aetherProvider-*.js` (keep the current hashed set used by `apps/api/dist/index.js` if referenced — verify imports before deleting), add `.gitignore` entries.
2. `evidence/` sensitivity review; move to ignored dir or redact.
3. `wrangler d1 migrations list` adjudication; renumber the duplicate `0005` if D1 accepts both (compare applied list).
4. `reports/INDEX.md` marking each prior report CURRENT/SUPERSEDED.

## TICKET T-11 · Test-suite ergonomics (W3-1)

1. Split vitest projects: `unit` (isolate:false / vmThreads, no jsdom where DOM not needed) and `integration` (full isolation). Keep CI running both. Acceptance: API < 120 s, all green.

## TICKET T-12 · Ecosystem Bot fix (W2-6, separate repo)

1. `E:/Code/Project/Bot/Abystral`: fix `tests/test_resilience.py` collection error (likely import/syntax/conftest path). Reproduce: `pytest tests -q`. No product code changes without reading that repo's conventions first.

## Parallelization map

- Parallel group A (after W0-1): T-01, T-08, T-10, T-11 — disjoint files.
- Parallel group B (after T-01): T-02 (Rust), T-07 (web/engines), T-09 (db) — disjoint.
- Sequential after T-02: T-03 (deletion depends on T-02 consumption), T-04, T-05 (posterior behavior depends on T-02/T-04 numerics), T-06.
- T-12 independent throughout.
