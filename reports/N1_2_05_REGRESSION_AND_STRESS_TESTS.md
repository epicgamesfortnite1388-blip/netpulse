# N1_2_05 — Regression and Stress Tests

**Phase:** N1.2 · **Commits:** `c7fe33b`, `d46ece9`

## N1.1 protections — intact, re-verified this phase

| Protection | Test | Status |
|---|---|---|
| Exact Bayesian oracle (1e-9) | `n1_bayesian_engine_drives_the_real_analysis` | **pass** (unchanged tolerance — no justification exists to weaken it) |
| Old-ratio tripwire | `n1_rejects_the_old_ratio_analysis` | **pass** |
| Shared-registry / canonical-bus wiring | `n0_end_to_end_…`, `n0_guard_old_wiring…` | **pass** |
| Refusal preservation | `n1_insufficient_evidence_refusal_preserved` | **pass** |
| Honest rejection + release | `n1_concurrency_limit_rejects_honestly_and_releases` | **pass** |
| Panic cleanup | `n1_panic_produces_honest_failure_and_releases_capacity` | **pass** |
| Latency smoke | `n1_analysis_latency_smoke` | **pass** (80 probes / 20 APIs in 2.47 s, probe-dominated) |

## New N1.2 tests (committed)

**K-1 (5):** helper ms→seconds conversion on the engine clock; five-second
delta preserves the posterior; comparative ms-bug tripwire (converted ~0.42
vs buggy ~0.24 over ten confirming probes); filtered-form parity; zero-delta
identity predict.

**K-2 (1):** 100-thread barrier stress — exactly 4 admitted, 96 honest
rejections, active count == cap, allocator total exact (ids from 1), every
recoverable non-active record marked as rejection. Re-run 4× green.

**K-3 (5):** cases A/B/C asserted on wording content (support-not-proof /
challenges+posterior-updated / absence-is-not-success); floor overrides
verification wording for all outcome combinations; the exactly-0.25 boundary
is a justified conclusion.

## Engine invariants (mission §8)

Untouched by construction and confirmed by the suite: 19 hypotheses,
six-outcome likelihood table, time-scaled transition kernel, correlation
discount, log-space updates, normalization, dedup, verified-only learning,
verification re-entry, post-verification recalculation, insufficient-evidence
refusal. `git diff` across N1.2 commits touches **no line** of
`diagnosis.rs`, `math.rs`, `probability.rs`, or `bayesian.rs`.

## Executed commands and results (this session)

| Command | Result |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml` | **552 passed, 0 failed, 2 ignored** — three consecutive clean runs |
| `cargo test … k1_` | 5 passed |
| `cargo test … k2_` | 1 passed (×4 runs) |
| `cargo test … k3_` | 5 passed |
| `npx vitest run src/features/nani` | 34 passed |
| `npm run e2e` | 44 passed, 0 failed |

One intermediate full-suite run reported 4 failures that were **not
reproducible** and left no captured names (concurrent build activity on the
same machine is the likely cause); three subsequent consecutive full runs
were clean, and the concurrency-stress tests were re-run 4× individually
without a single failure. Recorded for honesty; no flake signature remains.
