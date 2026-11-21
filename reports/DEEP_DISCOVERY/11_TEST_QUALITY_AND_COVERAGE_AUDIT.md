# 11 — Test Quality and False-Green Elimination

## Fresh baseline counts (no reliance on prior reports)

| Suite | Command | Result |
|---|---|---|
| Rust | `cargo test --manifest-path src-tauri/Cargo.toml` | most recent clean rerun: **560 passed / 0 failed / 2 ignored** (`gp3-rust-rerun.log`) |
| Web | `npm run test -w @netpulse/web -- --run` | **61 files / 598 passed / 4 skipped / 0 failed** (`gp3-web-test.log`) |
| API | `npm run test -w @netpulse/api -- --run` | **118 files / 1271 passed** (`baseline-api-tests.log`; earlier full run captured) |
| Web typecheck | `npm run typecheck -w @netpulse/web` | PASS |
| API typecheck | `npm run typecheck -w @netpulse/api` | PASS |
| Root lint | `npm run lint` | PASS, 0 errors |
| Release gates | test:signing / test:release / test:pipeline | 0 / 0 / 0 (`probe-release-gates.log`) |
| Build-gate honesty | `npm run test:build-gates` | **10 assertions pass** |
| secureStore regression | `vitest run test/secureStoreFailClosed.test.ts` | **4 tests pass** |

## False-red investigation (not a code defect)

One full Rust run reported 2 failures: `evaluation::tests::benchmarks_are_within_budget` (rank 6204us vs 1200us budget) and `investigation::tests::n1_analysis_latency_smoke` (5.18s). Both are wall-clock assertions. The clean rerun passed 560/0, and the same tests pass in isolation. Cause: multiple test suites ran concurrently on the same machine, inflating timings. Recorded as an environment artifact; both measurements are legitimately load-sensitive, so they should be run without competing suites. No source change was made to weaken them.

## False-green defects found and repaired

| ID | Test weakness | Correction |
|---|---|---|
| DD-004 | `audit-ci.sh` printed PASS for ts-prune gates that could never fail | Now honestly labeled ADVISORY (non-gating); a genuine hard gate would be permanently red on this monorepo (Kim P2) |
| DD-001/003/005 | No test pinned release-gate failure behavior | `build-gate-honesty.test.mjs` with 10 source-level assertions; Kim's mutation checks confirmed each assertion fails on revert |
| DD-011 | No test covered the desktop protection-failure path | `secureStoreFailClosed.test.ts` — 4 tests incl. Kim's transient-failure case (valid blob preserved) |
| DD-049 | Elevation tests only covered parameter quoting, not the nonce contract | Rust `pending_url_always_carries_the_nonce...`; API `elevationBroker.test.ts` asserts the UI-supplied nonce round-trips |
| Counterpart DD-032/033/034/035 | Concurrent agent added mutation-verified regressions for NANO K-1, AI role, OpenVPN directives and background-test state | See reports 06/08/07 and their test files |

## Known weak assertions remaining (OPEN)

- DD-042: NANI accuracy suite asserts only aggregate accuracy/Brier; `server_failure` 0/10 and `remote_endpoint` 0/10 blind spots stay green (`evaluation.rs:452-480`).
- DD-044: proxy-bypass test uses `include_str!("monitor.rs")` (source text, not behavior) — production code is sound.
- DD-050: `e2e-desktop.mjs` accepts `200||404` / `400` status codes, proving well-formedness rather than behavior.
- DD-045: `Prior::from_probs` has no NaN-rejection test.

## Mutation experiments

Mutation testing was performed on isolated fixtures/by concurrent agents (details in the findings register), never on production source. No assertion was weakened to obtain a green result. The `build-gate-honesty` Cargo assertion was strengthened after Kim showed it was satisfiable by an incidental version string.
