# FABLE — Corruption and Correctness Audit

Evidence classes used: compiler output (`cargo check`), live test runs, reachability tracing, working-tree diff inspection. Severity in brackets. Every finding cites the exact symbol.

## A. Compiler-proven dead or disconnected code (Rust)

| ID | Finding | Evidence | Impact |
|---|---|---|---|
| C-01 [HIGH] | **Sequential-analysis layer disconnected**: `value_of_information` (2×), `should_stop` (2×), `cost_adjusted_gain` (2×) reported *never used* by `cargo check` (`sequential.rs`, re-exported through `information_theory.rs`). | Compiler warnings, 2026-11-16 | Early stopping and VOI — the theoretical core of "when do we stop probing" — are implemented and tested but the production investigation loop never calls them. The investigation therefore probes on a fixed plan rather than an adaptive stopping rule. |
| C-02 [MEDIUM] | ~15 `new` constructors, 7 `observe`, 3 `predict`, 3 `update`, `identity`, `hazard`, `survival`, `wilson_interval`, `with_correlation`, `with_groups`, `fit`, `apply_all` never used across `network_intelligence/*`. | `cargo check` warnings | Suggests several modules (`hierarchical`, `timeseries`, `changepoint` internals, `probability`) are larger than their production usage. Not bugs — bloat + maintenance risk. |
| C-03 [LOW] | `unix_now_ms` defined 4× (investigation.rs, monitor.rs, api_intelligence/*) — one copy never used. | warnings | Duplication, trivial. |
| C-04 [LOW] | 2 `unreachable pattern` warnings; unused variables (`timeout`, `stage`, `run_length`, `rng`, `query`, `outcome`, `now_unix`). | warnings | Cosmetic but signals partially-rewritten modules. |

## B. Structural duplication (compile-clean, but real)

| ID | Finding | Evidence | Impact |
|---|---|---|---|
| C-05 [CRITICAL] | **Two NANI engines run simultaneously in the desktop app.** Node sidecar: `app.ts:897 naniShadowHealth.start()` (plus `NaniService` loop) starts unconditionally — no `NETPULSE_DESKTOP` gate. Rust: `main.rs` wires `MonitorLoop` + `NaniMathEngine`. Both probe the same registered APIs on timers, keep separate registries, posteriors, persistence. | `app.ts:608,651,897`; `main.rs` imports; `commands/nani.rs:37` state | Double network probing (bandwidth, rate-limit burn, log noise); divergent conclusions possible between the two engines; double maintenance of the same math in two languages (Rust 19,315 LOC vs TS 2,419 LOC — the frontend's claim in `naniApi.ts` that web mode serves "the same capabilities" is false: the TS core is a strict subset). |
| C-06 [MEDIUM] | **Failure classification duplicated in two languages**: Rust `api_intelligence/failure_classifier.rs` vs TS `lib/failureIntelligence.ts` + `naniDiagnosticAdapter.ts` mapping. | read | Drift risk: the two classifiers will diverge silently; no shared golden test set cross-checked between implementations. |
| C-07 [MEDIUM] | Two persistence systems for NANI-shaped data: Rust `PersistenceStore` (JSON files) and SQLite repo tables (shadow loop). | `persistence.rs`, `naniService.ts` | Two sources of truth for "what does NANI know". |
| C-08 [LOW] | `unix_now_ms` duplicated (see C-03); zip-extraction logic exists in `engineManager.ts` (hand-rolled) — fine, but any future archive type will tempt copy-paste. | read | Minor. |

## C. Working-tree / hygiene correctness issues

| ID | Finding | Evidence | Impact |
|---|---|---|---|
| C-09 [MEDIUM] | **36 files, +2,656/−493 uncommitted** at review time (diagnosis.rs +812, validation.rs +364, main.rs +138, copilot +329, naniService +329…). Any execution stage that starts from HEAD will collide with in-flight work. | `git diff --stat` | Merge-conflict and regression risk; also means "verified" state is the working tree, not a commit. **Action: commit or branch before execution tickets touch these files.** |
| C-10 [LOW] | Committed junk: `aether-*.zip` stubs (`Not Found`), `.tmp-desktop-dev.log`, `.scratch-*`, stale `dist-desktop/`, `.staging-dist/`, dozens of stale `apps/api/dist/aetherProvider-*.js` chunks. | filesystem | Confuses audits; small repo bloat. |
| C-11 [LOW] | CRLF/LF churn across Windows checkout (`git status` warnings on 36 files). | git | Diff noise; consider `.gitattributes` normalization. |

## D. Correctness observations that compile and pass tests but deserve scrutiny

| ID | Finding | Assessment |
|---|---|---|
| C-12 [MEDIUM] | `bayesian_update()` weights evidence by `ll * confidence` (`bayesian.rs:205-208`). Multiplying a log-likelihood by a 0..1 confidence is a **tempered/pseudo-likelihood heuristic, not a Bayesian operation**: for negative `ll` it *increases* the evidence's weight magnitude toward 0 (attenuates), but for positive `ll` it also attenuates — i.e., low confidence shrinks likelihood ratios toward 1, which is directionally reasonable but not derived from a proper likelihood model (a proper treatment uses mixture-of-models or explicit noise rate). Impact: posteriors are directionally sane but their numeric values are not calibrated probabilities in the strict sense. The `evaluation.rs` ECE/Brier machinery exists to measure exactly this — but see C-01: calibration evaluation is wired to test/simulation runs, not continuously to production. |
| C-13 [MEDIUM] | API test suite duration: **360 s** for 1,264 tests (jsdom churn ~90 s in web suite as well). No correctness bug, but it makes red-green loops expensive enough that contributors will batch changes — historically how regressions sneak in. |
| C-14 [LOW] | `src-tauri` ships `opt-level="s"`, `panic=abort` — good for size; note `panic=abort` means any NANI panic kills the app, so panic-freedom of the math core is load-bearing (tests cover it; keep it that way). |
| C-15 [LOW] | `engineManager` version cache TTL 30 s and release cache 10 min — correct given GitHub 60 req/h; no issue, documented here so nobody "fixes" it. |

## E. Explicitly checked and found NOT corrupted

- Drizzle migration chain `0000–0013` consistent with `_journal.json` (no broken migration order).
- D1 migrations `0001–0005` (note: two `0005_*` files exist — `0005_reset_atomic` and `0005_vpn_credentials` — same number; verify with `wrangler d1 migrations list` whether this is a real ordering hazard) [C-16, MEDIUM suspicion, not proven].
- All 34 API route files registered; 27 web routes mapped; 20/20 e2e-relevant scripts present.
- Test counts in prior phase reports matched live runs (see Previous Work Review).

## F. Recommended immediate actions (non-destructive)

1. C-09: land the in-flight work as a commit/branch **before** any cleanup ticket runs.
2. C-05: gate `naniShadowHealth.start()` behind `process.env['NETPULSE_DESKTOP'] !== '1'` (or a config flag) — one-line change, immediately halves desktop probing.
3. C-01: wire `should_stop`/`cost_adjusted_gain` into the investigation loop **or** delete them with their tests if the design decision is a fixed probe plan.
4. C-02/C-10: deletion candidates list in the Architecture Critique.
5. C-16: run `wrangler d1 migrations list netpulse-cloud` to adjudicate the duplicate `0005` numbering.
