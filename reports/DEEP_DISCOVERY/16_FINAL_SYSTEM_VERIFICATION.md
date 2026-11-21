# 16 — Final System Verification

**Date:** 2026-11-21
**HEAD:** `354034747b8fff87be94d4f34c635f3efc0a2bcd` (branch `main`; no commits were made by this operation)
**Method:** full-suite runs against the final working tree, including concurrent-session changes. No build was deployed or installed.

## Gate results (final)

| Gate | Command | Result |
|---|---|---|
| Rust | `cd src-tauri && cargo test --workspace` | **560 passed / 0 failed / 2 ignored** (1 ignored test needs tauri-driver) |
| Web | `cd apps/web && npx vitest run` | **61 files passed / 1 skipped; 598 tests passed / 4 skipped** |
| API | `cd apps/api && npx vitest run` | **118 files passed / 118; 1274 tests passed** |
| Cloud worker | `npm exec --workspace @netpulse/cloud-worker -- vitest run` | **7 files passed; 130 tests passed** (clean rerun; see flakiness note) |
| Typecheck | `npm run typecheck -w` for api / web / shared / cloud-worker | **4/4 PASS** |
| Lint | `npm run lint` | **PASS, 0 errors** (one ESM reparsing warning only) |
| Release gate honesty | `node scripts/build-gate-honesty.test.mjs` | **10 assertions passed** |

Baseline before this cycle: Rust 558, Web 592, API 1271. The deltas are the new regression tests added by this and the concurrent cycle.

## Focused regression evidence

| Fix | Test command | Result | Mutation check |
|---|---|---|---|
| DD-032 NANI correlation unit | `cargo test diagnosis::tests` | 22/0 | restoring 300_000 → `six_minute_gap...` FAILS (`left=[dns-lookup,tcp-connect,tls-handshake]`) |
| DD-033 AI role | `vitest run test/aiRole.test.ts` | 4/0 | role derivation exercised directly |
| DD-034 OpenVPN import | `vitest run test/vpnImportHardening.test.ts` | 15/0 | removing guard → HTTP test FAILS (`expected 201 to be 400`) |
| DD-035 background test state | `vitest run test/backgroundTestState.test.tsx` | 3/0 | removing reset → 2/3 FAIL (`expected { v: 'A' } to be null`) |
| DD-010 elevation params (prior) | `cargo test elevation` | 11/0 | prior independent review APPROVED |
| DD-020 graceful sidecar stop (prior) | `cargo test sidecar` | 32/0 | — |
| DD-049 elevation nonce (concurrent) | Rust elevation + API elevation suites | 12/0 + 12/0 | Kim reviewed |

## Flakiness observed and investigated

- First full worker run: 2 tests failed (`rate limits brute-force login per email`, `password reset: token …`). Each passed **in isolation** and the whole suite passed **130/130 on a clean rerun** with unchanged source. Root cause is load-sensitive D1/miniflare timing, not a product defect; recorded as a test-quality risk in report 11 and finding register.
- API suite: a sandbox policy blocked `reg.exe` during one run (a test probing Windows proxy state); the suite still completed 118/1271 green. Later run: 118/1274 green with clean capture.
- Repeated `cargo test` commands emitted a sandbox notice after successful completion; exit status and test summaries were green and are the evidence used.

## Boundaries respected

No commits, pushes, force-push, resets, clean, history rewrite, deployment, release publication, real payment, account mutation, production D1/VPS/Cloudflare change, or OS route/DNS/proxy modification occurred. Pre-existing dirty state (41 files at session start, 78 paths at end including new reports/tests and concurrent edits) was preserved; exact-string edits were used throughout.

## Verdict

All available local regression gates pass at the final tree. Live installer/e2e traffic proof and a real WebView2 run remain outside this environment and are explicitly unverified, not assumed.

## Supplement — independent final rerun (16:12 local, integration owner)

A second, independent final rerun was performed after all Kim corrections were applied:

| Gate | Command | Result | Log |
|---|---|---|---|
| Rust, uncontended | `cargo test --manifest-path src-tauri/Cargo.toml` | **560 passed / 0 failed / 2 ignored, 15.35 s, EXIT 0** | `reports/DEEP_DISCOVERY/final-rust-solo.log` |
| Rust, run concurrently with the web suite | same | 558 passed / **2 failed** / 2 ignored, 35.64 s | `reports/DEEP_DISCOVERY/final-rust.log` |
| Web | `npm run test -w @netpulse/web -- --run` | **61 files / 599 passed / 4 skipped / 0 failed** | `reports/DEEP_DISCOVERY/final-web.log` |
| Typechecks (api/web/shared/cloud-worker) | `npm run typecheck -w …` | **4/4 PASS** | — |
| Lint | `npm run lint` | PASS, 0 errors (ESM reparsing warning only) | — |
| Gate honesty | `npm run test:build-gates` | **10 assertions pass** | — |
| secureStore regression | vitest targeted | **4 tests pass** | — |

The two contended failures were again exclusively `evaluation::tests::benchmarks_are_within_budget` (rank 5718.6us vs 1200us) and `investigation::tests::n1_analysis_latency_smoke` (8.54 s); the same suite passed 560/0 when run alone immediately after. This is reproducible measurement contamination, not a regression: no budget was relaxed and no source was changed between the two runs. CI already runs Rust and Node suites in separate sequential steps.

The following corrections were applied AFTER the earlier gate table above and are covered by this supplement: `audit-ci.sh` advisory labeling (Kim P2), `SystemHealthPage` inline confirmed reset (Kim P2), `secureStore` transient-failure preservation (Kim P2 + 4th regression test), `[package]`-scoped Cargo version check (Kim P3), and removal of the no-op replace in `build-gate-honesty.test.mjs`. See `15_INDEPENDENT_KIM_REVIEW.md`.

**Final verdict (supplement):** all available local gates green on a stable, uncontended run; no P1 remains open; DD-060 (committed credential) remains BLOCKED pending owner action explicitly outside mission scope.
