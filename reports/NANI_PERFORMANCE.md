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
- Test/rank debug cap (5000 µs) passes.
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

## Not measured

- Release-mode engine latency.
- Full application startup, idle CPU, RAM, UI frame rate, VPN throughput impact.
- LLM first-token/total latency (no model available).
- Memory growth over a long session.

No end-to-end performance improvement is claimed beyond the engine micro-benchmark above.
