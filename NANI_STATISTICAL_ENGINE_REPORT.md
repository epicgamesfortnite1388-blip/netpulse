# NANI Statistical Engine Report

## Scope
Robust descriptive statistics and bounded-proportion estimation for network measurements
(`src-tauri/src/network_intelligence/robust_stats.rs`, `probability.rs`).

## Definitions and implementations

### Window statistics (`RobustStats`, bounded ring buffer)
All statistics are computed over the live window; `observe()` rejects non-finite values, so no
statistic can silently become NaN from bad input.

- Mean: `x̄ = (1/n)·Σ xᵢ`. Present, `None` when empty.
- Unbiased sample variance: `s² = Σ(xᵢ − x̄)² / (n − 1)`. Present, `None` when `n < 2`
  (one sample says nothing about dispersion; returning 0 would claim certainty).
- Standard deviation: `s = √s²`.
- Median: `n` odd → middle element; `n` even → mean of the two middles.
- MAD: `median(|xᵢ − median(X)|)`.
- IQR: `Q3 − Q1` on linearly interpolated quantiles.
- Quantiles p50/p90/p95/p99: linear interpolation at `idx = p·(n−1)`.
- Trimmed mean: sort, drop `k = floor(n·f)` from **each** tail, average the rest. `f ∈ [0, 0.5)`.
- Winsorized mean: replace the `k` lowest by the lowest retained order statistic and the `k` highest by
  the highest retained one, then average over all `n` (every observation keeps its weight).

### Packet loss / success-rate interval
- `wilson_interval(successes, n, z) -> Option<WilsonInterval>` implements

  `[ p̂ + z²/2n ± z·√( p̂(1−p̂)/n + z²/4n² ) ] / (1 + z²/n)`

  Returns `None` for `n = 0`, `successes > n`, or non-positive/non-finite `z`. A missing measurement
  never becomes a confident zero: no trials yields no interval.
- Bounds are clamped to `[0,1]`, so the interval is never degenerate at 0% or 100% loss.

## Rationale for the estimator choice
Naive `p̂ ± z√(p̂(1−p̂)/n)` collapses to a zero-width interval when every probe succeeds, which is
exactly the "we saw 10/10, therefore loss is 0" error this engine must avoid. Wilson stays informative
and keeps coverage near nominal at n ≈ 10, the range NANI actually measures in.

Verified value: `wilson_interval(5, 10, 1.96)` → `(0.2366, 0.7634)`, matching the published Wilson
interval for 5/10 at 95%. `wilson_interval(0, 10, 1.96)` → upper ≈ 0.26, lower 0 — i.e. ten
successes still permit meaningful loss.

## Tests (all passing)
`robust_stats::tests`:
- `mean_and_sample_variance_match_definitions` — mean 5, sample variance 32/7 on a known set.
- `variance_requires_two_observations` — `None` at n=0 and n=1; 2.0 for {1,3}.
- `trimmed_mean_discards_both_tails` — [1..9, 1000] at 10% → 5.5 (raw mean 104.5).
- `trimmed_mean_with_too_small_a_window_keeps_everything` — `floor(3·0.1)=0`, mean unchanged.
- `trimmed_and_winsorized_reject_invalid_fractions` — negative, 0.5, NaN, empty window.
- `winsorized_mean_caps_extremes_instead_of_dropping_them` — spike clamped, result below raw mean.

`probability::tests`:
- `wilson_interval_matches_published_value_for_five_of_ten`
- `wilson_interval_is_bounded_and_non_degenerate_at_extremes`
- `wilson_interval_narrows_with_more_trials` (100 → 1000 trials)
- `wilson_interval_rejects_impossible_input`

Result: 10 new tests, all green (`cargo test network_intelligence::` → 340 passed, 0 failed).

## Units and non-mixing
Latencies stay in milliseconds (`Option<f64>`, `None` for missing), probabilities stay in `[0,1]`,
entropies in nats, information gains in nats. `WilsonInterval` carries `p_hat`, `n` and `z` alongside
the bounds so a displayed interval can always be explained.

## Known limitations
- Quantiles use linear interpolation on the window only; there is no streaming/`P²` estimator, so cost
  is `O(n log n)` per query (window is small and bounded — see performance report).
- Winsorizing is symmetric only.
- The Wilson interval assumes independent Bernoulli trials. NANI's probes are frequently correlated;
  the dependency discount lives in `evidence/correlation.rs` and is applied **before** an observation is
  treated as independent evidence, not inside this interval.
- No bootstrap or BCa intervals.

## Status
- Implemented: mean/variance/std, trimmed mean, winsorized mean, Wilson interval.
- Tested: yes, 10 tests.
- Benchmarked: covered indirectly (`rank`/`route` micro-benchmarks); the new statistics are `O(n log n)`
  over a bounded window and were not separately benchmarked.
- Integrated: available through the `RobustStats` API and `probability`; not yet surfaced in the UI.
- Verified: unit-level.
- Blocked: UI display of distributions/intervals.
