# NANI Performance Report

## Methodology
Numbers come from the in-crate micro-benchmark `evaluation::benchmark(iterations)` executed as the
existing test `evaluation::tests::benchmarks_are_within_budget`, which:

- runs 200 iterations per operation (debug build; the code selects 2000 under `--release`),
- repeats the whole benchmark 3 times and reports the **best** run (tests run in parallel, so a single
  sample can include scheduler contention),
- uses `std::hint::black_box` so the optimizer cannot delete the measured work.

Exact command run:

```
cargo test network_intelligence::evaluation::tests::benchmarks_are_within_budget -- --nocapture
```

## Measured results (debug build, Windows, this machine)

```
bench(best of 3): update 161.1us, rank 5007.6us, route 0.1us (200 iters)
test result: ok. 1 passed; 0 failed
```

| Operation | What it does | Debug time |
|---|---|---|
| `update` | one `DiagnosticEngine::observe` on an 8-probe engine | 161.1 µs |
| `rank` | `rank_tests` — expected information gain for all 8 diagnostic tests | 5007.6 µs |
| `route` | `score_candidate` for one route candidate | 0.1 µs |

These are **debug** timings with overflow checks and no optimization; they overstate release cost by
roughly an order of magnitude on typical Rust code. No release figure is claimed here because it was not
measured.

## Analysis

`rank_tests` dominates: ~626 µs per test. The cause is visible in
`diagnosis.rs::expected_information_gain` — for each of the 6 possible outcomes it **clones the whole
engine** and calls `observe()` on the clone to obtain the hypothetical posterior entropy:

```
6 outcomes × 8 tests = 48 full DiagnosticEngine clones per ranking
```

Each clone copies the bounded probe history (VecDeque of up to 32 `ProbeResult`s containing `String`s), the
correlation model and the calibrator map. The arithmetic itself (12 hypotheses × 6 outcomes likelihood
lookups) is trivial by comparison.

**Optimization identified but deliberately not applied.** Removing the clones means re-deriving the
posterior update analytically for a hypothetical observation, which must reproduce exactly what
`observe()` does (dependency weighting, decay, timestamp handling, calibration). Any divergence between
the fast path and the real path would make the selection score disagree with the actual update — a
correctness risk for a ~5 ms debug saving. Since `rank_tests` is **not** on the IPC path today
(only `foundation`/`information_theory` call it, not any per-tick command), the trade is not justified yet.

If it later lands on a hot path, the safe shape is: cache `engine.uncertainty()` and the prior vector once
per ranking (currently recomputed inside every test), then evaluate the per-outcome posterior entropy
without cloning history — and validate equality against the clone path with a test over random engines.

## Memory
- All histories are explicitly bounded: probe history (32), correlation history (32), `CausalTracker`
  (default 1000 records), `RobustStats` window (caller-sized), drift history, learning queues.
- Conjugate counts (Beta) are `O(1)` per API/context instead of storing raw samples.
- No allocation-free claim is made: `softmax`, `rank_tests` and likelihood evaluation allocate `Vec`s per
  call. Allocation counts were not measured (no allocator instrumentation in this project).

## Scaling
- `DiagnosticEngine::observe` — `O(hypotheses × outcomes)` for the likelihood update plus `O(history)` for
  the correlation window: constant in the number of past measurements (bounded history).
- `expected_information_gain` — `O(outcomes × hypotheses)` arithmetic plus the clone cost above; linear in
  hypothesis count.
- BOCPD — `O(max_run_length)` per observation, the only structure that grows with configuration.
- `RobustStats` quantiles — `O(n log n)` per query over a bounded window (sorting on demand).

## Worst case
The pathological input for `rank_tests` is a large probe history (clone cost) combined with many
hypotheses; both are bounded by configuration, so worst-case time is bounded, not growing with runtime.

## Benchmarks that do not exist yet
- No allocation/peak-memory measurement.
- No release-mode comparison recorded.
- No end-to-end investigation latency benchmark (event → diagnosis → probe selection) from the UI.

## Status
- Benchmarked: 3 core operations, debug only, best-of-3, real output quoted above.
- Optimized: nothing in this phase — no speedup is claimed.
- Open opportunity: avoid the 48 engine clones per ranking (documented, not implemented).
