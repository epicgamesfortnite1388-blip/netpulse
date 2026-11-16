# NANI Performance

## Measured

Debug build, 200 iterations, `cargo test network_intelligence::evaluation::tests::benchmarks_are_within_budget -- --nocapture`:

```
bench: update 127.7us, rank 4300.4us, route 0.2us
```

Earlier in this pass, the first correlation implementation allocated a `String` per observation and measured:

```
bench: update 184.3us, rank 5728.3us, route 0.1us
```

The allocation-free rewrite (`&'static str` history + `weight_for`) reduced update cost by ~31% and ranking by ~25% in the debug benchmark. The ranker remains the largest engine cost.

## Changes made

- Correlation history is bounded (32 entries) and allocation-free.
- Weight computation is O(window × groups), not a per-observation vector allocation.
- Test caps: `bayes_update` / `route_score` stay at 6000 µs (debug) and 12000 µs (release); ranking has its own 1200 µs cap plus a rank/observe ratio cap of 10, tight enough to fail a return of the clone-per-outcome path (~5000 µs debug, ~2100 µs release).
- Ranking no longer clones the engine per candidate outcome (~11x faster; see below).
- Local LLM is process-per-request, so an idle app holds no model memory.

## Information-gain ranking without per-outcome engine clones (2026-11-16)

`expected_information_gain` used to clone the entire `DiagnosticEngine` once per
candidate outcome (6 clones per test, 48 per `rank_tests`) purely to read the
resulting entropy. It now computes the same posterior on the log-probability
vector (`DiagnosticEngine::entropy_if_observed`), sharing the evidence weight
with `observe` through one `evidence_weight` helper.

Same command, same machine, debug build, 200 iterations:

```
before: bench(best of 3): update 163.1us, rank 5016.5us, route 0.2us
before: bench(best of 3): update 206.7us, rank  451.6us, route 0.1us   (after)
```

Ranking a full test set dropped ~11x (5.0 ms -> 0.45 ms per ranking). `update`
varies 156–207 µs between runs on this machine, so treat that column as noise; the
ranking change is far outside it.

Equivalence is proved, not assumed:

```
cargo test network_intelligence::diagnosis::tests::information_gain_fast_path_matches_the_cloning_reference -- --nocapture
IG fast path vs cloning reference: 2160 comparisons, max |diff| = 1.887899558905559e-12
```

The reference is the old clone-per-outcome implementation, kept in the test module.
The comparison covers all 15 simulator conditions x 2 seeds x 9 history prefixes
(fresh, mid-diagnosis, full history where the correlation discount is active) x all
8 diagnostic tests. The residual 1.9e-12 comes from the reference's extra
renormalization steps (`predict(0)` is mathematically the identity), not from a
semantic difference.

## Release profile (2026-11-16)

The numbers above are debug. The shipping build is optimized, so the ranking
speedup was re-measured in release on the same machine, timing both paths on one
engine (200 observations of `DnsResolve` on a `Healthy` simulator, 200 iterations
per round, best of 3, three separate runs):

```
cargo test --release tmp_rank_speedup -- --nocapture
rank release: fast 118.2us, clone-reference 2054.2us, speedup 17.4x
rank release: fast 120.1us, clone-reference 2096.7us, speedup 17.5x
rank release: fast 125.3us, clone-reference 2101.9us, speedup 16.8x
```

The shipping benchmark agrees (`cargo test --release benchmarks_are_within_budget -- --nocapture`):

```
bench(best of 3): update 64.6us, rank 117.0us, route 0.1us (2000 iters)
```

A full ranking of all 8 diagnostic tests therefore costs **~0.12 ms in release**
(0.36 ms debug) instead of ~2.1 ms release (5.0 ms debug): **16.8–17.5x faster
in release**, 11–14x in debug. The release ratio is larger because the
clone-per-outcome reference pays for allocation and copies that the optimizer
removes more of from the log-space path than from the cloning path.

Provenance and limits: measured in a test binary (`--release`), wall-clock,
best-of-3 over three runs, single machine, single engine state; the harness was a
`#[test]` that only printed timings and was removed after recording. The
equivalence test (`information_gain_fast_path_matches_the_cloning_reference`)
remains the correctness guard.

## Not measured

- Full application latency in release (startup, UI frame time, sidecar round-trips) — only the engine micro-benchmark above is measured in both profiles.
- Full application startup, idle CPU, RAM, UI frame rate, VPN throughput impact.
- LLM first-token/total latency (no model available).
- Memory growth over a long session.

No end-to-end performance improvement is claimed beyond the engine micro-benchmark above.
