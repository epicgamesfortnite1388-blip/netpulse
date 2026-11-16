# N0_07 — Regression Test Results (executed this session)

All commands run from the repository root; exact results below. **No historical counts are claimed as fresh runs.**

| # | Command | Exit | Result | Delta vs pre-N0 |
|---|---|---|---|---|
| 1 | `cd src-tauri && cargo test investigation` | 0 | **10 passed, 0 failed** (6.10 s) | was 8 → +2 new (E2E + guard), all pre-existing still green |
| 2 | `cd src-tauri && cargo test` (full suite) | 0 | **532 passed, 0 failed, 2 ignored** (6.32 s) | was 530 pre-N0 in the user's report → +2 = exactly the two new N0 tests; **zero regressions** |
| 3 | `cd apps/web && npx vitest run src/features/nani` | 0 | **34 passed** | was 30 at audit time; +4 from the user's concurrent agent's in-flight tests (not mine) |
| 4 | `cd packages/shared && npx tsc --noEmit` | 0 | clean | unchanged |
| 5 | `cd apps/api && npx tsc --noEmit` | 0 | clean | unchanged |
| 6 | `cd apps/web && npx tsc --noEmit` | **2** | 1 type error in `src/features/connection/connectionState.ts:369` | **NOT MINE**: that file is untracked, created 22:30 by the user's concurrent agent (new `features/connection/` work). My changes are Rust-only. Recorded as a concurrent-work limitation, not a regression. |

## Mathematical protections — verified untouched

The N0 diff touches no algorithm code: `bayesian.rs`, `math.rs`, `robust_stats.rs`, `probability.rs`, `diagnosis.rs` (engine half), `learning.rs`, `evaluation.rs` are byte-identical to their pre-N0 state from MY changes (`git diff` attribution: my edits = main.rs, investigation.rs, api_intelligence/registry.rs, api_intelligence/monitor.rs, events/mod.rs only). Time-scaled transitions, log-space semantics, −inf/NaN handling, dedupe, verified-only learning, the 6-outcome superset, insufficient-evidence refusal — all exercised by the still-green 532-test suite.

## Blocked / environmental notes

- Full-suite Rust runs were twice interrupted by transient compile errors in the user's **in-flight** `diagnosis.rs` calibration test (fixed by their agent at 23:22 while I worked; I never edited that file — my one attempted edit failed its own safety assertion and applied nothing). Final runs above are clean.
- Web full-suite run skipped in favor of the NANI-relevant subset + typecheck (the failing unrelated type error is concurrent work; documented rather than "fixed" by me).
