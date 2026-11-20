# FINAL_UI_TEST_REPORT — exact commands and results (updated 08:35 GMT+3:30)

**Reviewer:** Kim · **Environment:** Windows, Node v22.22.2 / npm 10.9.7 / rustc 1.98.1 / cargo 1.98.1 · Workspace `E:\Code\Project\Vpn_app`.
All output below is quoted from actual runs. Earlier 07:44–07:59 runs are retained in `FINAL_UI_BASELINE.md` and `FINAL_UI_FIX_REPORT.md`.

## 1. Frontend unit tests (Vitest)

| Run | Time | Result |
|---|---|---|
| Baseline (during concurrent edits) | 07:44 | 504 passed / **2 failed**, 54 files — `typeScale.test.ts` |
| After Will's first fix set | 07:59 | **506/506**, 54 files |
| After nine new UI_MASTER reports + 3 stricter guard tests | 08:23 (concurrent with 2 other suites) | 508 passed / **1 failed** — `mapClusterPerf.test.ts`: `expected 123.12 to be less than 100` |
| Same test isolated | 08:25 | `1 passed (3 tests) 13ms` — load-induced |
| **Sequential full run (no contention)** | **08:26** | **54/54 files, 509/509 tests passed, 63.82 s** |

The type-scale guard was **strengthened**, not weakened: `apps/web/test/typeScale.test.ts` gained three stylesheet checks (`unscaledFontSizes`, no fixed px in either stylesheet, 12px floor for `calc(rem)`); the original two component assertions are intact. `npx vitest run test/typeScale.test.ts` → 13/13 pass.

## 2. Typecheck

| Run | Result |
|---|---|
| 07:44, 07:59 | **FAIL** — `connectionState.ts(369,5) TS2322` |
| **08:23** | **PASS** — `tsc --noEmit` exits 0 |

Will normalized the two-carrier mutation result type. Kim re-verified the source (`connectionState.ts:363–378`) and the passing command. F-04 is **verified fixed**.

## 3. Production build

| Invocation | Result |
|---|---|
| `npm run build -w @netpulse/web` at 07:59 | FAIL at `tsc` (F-04) |
| `npm run build -w @netpulse/web` at 08:23 | typecheck passed; Vite transformed 2915 modules then **failed** on `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":90,...,"targets":["...apps/web/dist/assets"]}` — sandbox guard, not a code defect |
| **`npx vite build --outDir /e/Code/Project/.final-ui-buildcheck`** at 08:26 | **SUCCESS — `✓ built in 11.36s`**; route chunks emitted (LiveMapPage 1,265.83 kB, three.module 558.22 kB, index 582.91 kB, LatencyChart 350.45 kB, CSS ~124 kB); chunk-size warning >900 kB present |

**Conclusion:** the frontend compiles and bundles. The scripted build failure is environmental (bulk-delete guard on an existing `dist`), not a source defect. No bundle was written into the repository's `dist/`.

## 4. Rust suite

| Run | Result |
|---|---|
| Baseline 07:44 | 550 passed / **2 failed** / 2 ignored — `n1_analysis_latency_smoke` (8.81 s), `n1_bayesian_engine_drives_the_real_analysis` (`ipv4` vs `quic_udp_failure`) |
| 08:23 (3 suites concurrent) | 549 passed / **3 failed** — added `benchmarks_are_within_budget` (rank 3527 µs > 1200 µs) |
| `benchmarks_are_within_budget` isolated 08:25 | **PASS** — rank 372.2 µs; update 164.2 µs |
| Sequential full run 08:26 | 549 passed / **3 failed** / 2 ignored, 15.95 s — `n0_end_to_end…` (6 s timeout), `n1_bayesian_engine_drives_the_real_analysis`, `n1_rejects_the_old_ratio_analysis` |

Across four runs the failing set changed each time and isolated timings were ~10× faster. This **demonstrates environment/load sensitivity** (F-15). The posterior-mismatch failure `ipv4` vs `quic_udp_failure` recurred in two full runs; its root cause remains undemonstrated and is **not** attributed to the uncommitted likelihood change.

## 5. Not run

E2E and Tauri integration (no backend sidecar; the dev server is reachable but API calls return `http_500`), all-workspace `npm test` (service/DB setup, no external calls per mission), `clippy`/`fmt` (non-gating, 270 warnings).

## 6. Current gate summary

| Gate | Baseline | Current |
|---|---|---|
| Web unit tests | 504/506 | **509/509 PASS** |
| Web typecheck | FAIL | **PASS** |
| Vite build | not reached | **PASS to fresh outDir** (script blocked only by sandbox delete guard) |
| Rust tests | 550/552 | **549/552 — 3 FAIL** (flaky set) |
| Visual | not performed | PARTIAL (10 screenshots) |

**Overall: still not a clean gate** — the Rust suite is red and flaky; E2E/data-backed verification unavailable.
