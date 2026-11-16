# NANI Numerical Stability Report

## Principles applied across the engine
1. **Log space for probabilities.** Likelihoods, priors and posteriors are stored/summed as logs;
   `softmax` converts only at the end. This keeps `1e-300`-scale likelihoods representable.
2. **Max-subtraction in `log_sum_exp`.** `max + ln(Σ exp(xᵢ − max))` avoids overflow for large values and
   underflow for small ones.
3. **Explicit invalidity.** `finite_or_default` makes "invalid" a caller decision. Missing data is `None`,
   never `0.0`.
4. **A single documented probability floor** (`PROB_FLOOR = 1e-12`) used only where `log(0)` would
   otherwise be undefined — never to fabricate evidence.
5. **No silent substitution.** `clamp_latency`, `clamp_probability`, `BetaBernoulli::new`,
   `CusumDetector::new`, `wilson_interval` all return `None`/`Option` on invalid input rather than a
   plausible-looking value.

## Case-by-case behaviour

| Case | Behaviour | Where |
|---|---|---|
| `p = 0` / `p = 1` | clamped to `PROB_FLOOR` / `1 − PROB_FLOOR` so logs stay finite | `math::clamp_probability` |
| NaN probability | mapped to `0.5` (maximum ignorance) by `clamp_probability`; `bernoulli_entropy(NaN) = 0` (no information) | `math.rs` |
| `±∞` input | `log_sum_exp` handles all-`-∞` by returning `-∞`; `softmax` returns `None` when the result is not finite | `math.rs` |
| Underflow in softmax tails | floored at `PROB_FLOOR` then renormalized, so probabilities sum to 1 and none is exactly 0 | `math.rs::softmax` |
| Empty distribution | `softmax`, `normalize_weights`, `kl_divergence`, `Categorical` return `None` | `math.rs`, `probability.rs` |
| Mismatched / non-normalized vectors in KL | `None` unless both lengths match and both sum to 1 within `1e-9` | `math::kl_divergence` |
| Extreme log-probability gap | `softmax(&[1000.0, -1000.0])` yields `[≈1, 1e-12]`, both finite and positive (this was the adversarial case that previously failed and now passes) | `math.rs` |
| NaN / infinite latency | `None` (missing), not 0 ms | `math::clamp_latency` |
| Latency below floor / above cap | clamped only when the caller supplies an explicit physical range | `math::clamp_latency` |
| Non-finite observation in the window | rejected by `observe`, so mean/variance/MAD stay finite | `robust_stats.rs` |
| Zero-dispersion window | `anomaly_score` uses `+1e-6` in the denominator and reports a large score rather than dividing by zero | `robust_stats.rs` |
| Degenerate Beta (α, β ≤ 0, NaN, ∞) | constructor returns `None` | `probability.rs` |
| Zero trials in a proportion | `wilson_interval` returns `None` — no confidence from no data | `probability.rs` |
| `successes > n` | `None` (contradictory counts are an error, not a 100% rate) | `probability.rs` |
| Drift detectors receiving NaN | ignored/neutralized; statistics stay finite (asserted by the adversarial suite) | `drift.rs`, `foundation.rs` |
| Empty evidence set | posterior equals prior; entropy unchanged | `bayesian.rs` |

## Statistical regression tests (samplers)
Random algorithms are validated distributionally, not by exact seeded values:
- Gamma, k = 2: mean within 0.05 of 2, variance within 0.12 of 2 over 40 000 draws.
- Gamma, k = 0.5: mean within 0.03, variance within 0.05 over 40 000 draws.
- Normal: |mean| < 0.03, |variance − 1| < 0.05, mass below zero within 0.02 of 0.5.
- Beta(71,31) draws: mean within 0.005 and variance within 0.0008 of the analytic values.
- Fixed-seed reproducibility asserted bitwise across two identically seeded RNGs.

Tolerances are ~4–5 standard errors at the given sample sizes, so a correct sampler passes
deterministically while a wrong distribution shape fails.

## Property-style assertions present
- Posterior probabilities sum to 1 within tolerance after normalization.
- Entropy is non-negative (uniform maximizes it; `ln n` for `n` outcomes).
- Information gain is non-negative for the implemented estimator.
- Identical correlated probes do not multiply confidence (dependency discount is applied to weight, so
  the posterior moves less than independent observations would).
- A missing measurement cannot become a successful observation (`None` is a no-op; `MeasureState::Unknown`
  maps to `None`).
- Invalid input cannot produce a finite "confident" value — constructors and free functions reject.

These are unit assertions rather than a property-testing framework; no `proptest`/`quickcheck` dependency
was added (the crate keeps its dependency surface minimal).

## Score auditing (per §8)
Separated and not collapsed into a single "confidence" number: evidence strength (likelihood ratio /
log-likelihood delta), posterior probability, measurement reliability (`Evidence.reliability`,
`Provenance`), verification status (`EvidenceQuality`), and operational priority (route/recovery scoring
in `route.rs`). `validation.rs` computes Brier/ECE so posterior calibration can be checked against
outcomes rather than assumed.

## Remaining weaknesses (honest)
- `BetaBernoulli::credible_interval` is a normal approximation with a three-point z table — not exact.
- `PageHinkleyDetector` uses a fixed 0.5 reference (see drift report); fine for success rates, wrong for
  arbitrary series.
- `clamp_probability(NaN) = 0.5` is a deliberate convention; a caller that wants "unknown" must use
  `Option` instead.
- No long-double / compensated summation. Sums are `f64`; with windows bounded to tens of elements this
  is not a practical source of error, but very large accumulation (millions of terms) would drift.
- No property-testing crate, no fuzzing of the numeric entry points.

## Verification
```
cargo test network_intelligence::   →  340 passed; 0 failed
```
including `foundation::tests::foundation_stability_tests_pass` and
`foundation::tests::foundation_adversarial_tests_pass`, which exercise the extreme-value table above
(million-scale log-likelihoods, NaN/∞ observations, empty inputs, extreme drift values).
