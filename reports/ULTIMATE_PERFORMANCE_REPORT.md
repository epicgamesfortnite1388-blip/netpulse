# ULTIMATE PERFORMANCE REPORT

**Audit date:** 2026-11-16. This report distinguishes **measured** numbers (executed here) from **design claims** (read from code/benchmarks) and **not measured** (would require hardware/live tunnel).

---

## 1. Measured in this session

| Measurement | Value | Method |
|---|---|---|
| Rust test suite wall time | ~4.3–8.9 s (529 tests) | `cargo test` |
| shared TS suite | 3.28 s (212 tests) | `vitest` |
| web TS suite | ~58–66 s (502 tests, jsdom) | `vitest`; 89–90% of time is jsdom environment creation |
| api TS suite | ~387 s (1264 tests) | `vitest`; 115 workers × ~296 ms startup |
| cloud worker suite | 33.6 s (126 tests) | `vitest` |
| Full web typecheck | ~ tens of seconds | `tsc --noEmit` |

## 2. Test-infra performance notes (actionable, not product perf)

- **Web:** jsdom created 54 times (89% of tracked time). Vitest suggests `pool: 'vmThreads'` or `isolate: false` to reuse workers → large speedup.
- **API:** 115 workers spawned, ~296 ms each (~34 s avoidable) — `isolate: false` would reuse workers.
- **These are test-harness inefficiencies, not application hot paths.**

## 3. Design-level performance evidence (read from code/benchmarks, not re-run)

- **NANI hot paths:** Bayesian update is log-space, allocation-light (`&'static str` correlation history, bounded `MAX_CORRELATION_HISTORY=32`), `observe` is O(hypotheses) with no per-session growth. The fast-path information-gain estimator is proven equal to the cloning reference to 1e-9 (`diagnosis.rs` test) — i.e., the optimization is validated, not assumed.
- **Rust release profile:** LTO, `codegen-units=1`, `opt-level="s"`, `strip`, `panic=abort` — size-optimized.
- **Sidecar:** bounded restart budget, readiness polling with widening cadence, bounded output capture.
- **Engine cleanup:** idempotent, 24 h stale-core sweep, per-engine orphan sweeps — bounded resource growth.
- **Persistence:** bounded observations (`MAX_OBSERVATIONS`), periodic compaction, atomic rename.

Prior `reports/NANI_PERFORMANCE.md` / `NANI_PERFORMANCE_BENCHMARKS.md` exist; **not re-run** in this audit and not relied upon.

## 4. Not measured (honest gaps)

| Item | Why not |
|---|---|
| VPN connect latency / throughput | needs live tunnel + real endpoints |
| NANI end-to-end diagnosis latency on real networks | needs real probes |
| Desktop app startup / memory / FPS | needs launched Tauri app |
| Bundle size / installer size | needs `tauri build` |
| DB query latency at scale | needs populated DB |

## 5. Assessment
No performance regression was introduced by the repairs (they are correctness-only, O(1) changes). The measurable inefficiencies found are in the **test harness**, not the product. Real product performance claims require a live environment and are explicitly not made here.
