# NANI Mathematical Engine

## Implemented

The Rust engine under `src-tauri/src/network_intelligence/` is the authority for technical decisions. It contains:

- `probability.rs` — Beta-Bernoulli and categorical distributions.
- `bayesian.rs` — log-space priors/posteriors, evidence, confidence intervals, KL/JS divergence.
- `math.rs` — log-sum-exp, stable sigmoid, entropy, normalization, finite-value guards.
- `diagnosis.rs` — 17-hypothesis dynamic Bayesian diagnosis, transition model, expected information gain, sequential stopping.
- `robust_stats.rs` — online quantiles, MAD, anomaly scores.
- `changepoint.rs`, `drift.rs` — CUSUM, Page-Hinkley and Bayesian online change-point detection.
- `timeseries.rs` — exponential smoothing and forecasting primitives.
- `graph.rs` — measured network graph traversal and failure propagation.
- `survival.rs` — Kaplan-Meier, Weibull and competing risks with censoring.
- `route.rs`, `bandit.rs` — multi-objective ranking, Pareto, CVaR, Thompson sampling.
- `recovery.rs` — authorized action planning, circuit breakers, verification.
- `config_intelligence.rs` — fingerprinting, validation states, scoring.
- `learning.rs` — local profiles, hierarchical reliability, drift, episodes.

## Changed in this pass

**Correlated evidence in the live posterior.** `DiagnosticEngine::observe` now:

1. Starts a new correlation window after a 5-minute gap.
2. Treats a repeated identical test as new evidence (weight 1.0).
3. Discounts a different test on the same causal path by a calibrated factor.
4. Applies the discount only as the leading hypothesis passes 50% confidence, so corrective probes are never weakened.
5. Stores the applied weight in `last_evidence_weight` for tests and observability.

The history is bounded to 32 entries and uses `&'static str`, so the update allocates nothing per probe.

## Tested

- `cargo test`: **419 passed, 0 failed, 2 ignored**.
- Correlation unit tests cover independent probes, shared transport, overlapping groups, repeated identical tests, non-finite input and the allocation-free `weight_for` path.
- Diagnosis integration test proves shared-resolver evidence receives a weight below 1.

## Benchmarked (debug build, 200 iterations)

From `cargo test network_intelligence::evaluation::tests::benchmarks_are_within_budget -- --nocapture`:

```
bench: update 127.7us, rank 4300.4us, route 0.2us
```

The first correlation implementation allocated per observation and measured 5728.3 µs for ranking; the allocation-free rewrite brought it back under the 5000 µs debug gate. Release performance was not measured.

## Not implemented / deferred

- No unified orchestrator that runs all diagnostic probes automatically.
- No conformal prediction layer.
- No causal effect estimation beyond the existing gated tracker.
- Correlation weights are not persisted or recalibrated from captured outcomes.
- No performance benchmark of the full app, only engine micro-benchmarks.
