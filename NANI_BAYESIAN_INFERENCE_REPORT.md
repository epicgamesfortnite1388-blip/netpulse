# NANI Bayesian Inference Report

## Implementation
`src-tauri/src/network_intelligence/bayesian.rs`, `probability.rs`, `diagnosis.rs`, `evidence/correlation.rs`.

### Priors
- `Prior::uniform(labels)` — equal mass over hypotheses.
- `Prior::from_probs(labels, probs)` — validated and normalized; `None` on bad input (empty,
  non-finite, negative, zero total).
- Stored as **log-probabilities**, so extreme priors do not underflow.

### Likelihoods
- `DiagnosticEngine` holds `P(outcome | test, hypothesis)` over 6 outcomes
  (`Success, Failure, Missing, AuthRejected, RateLimited, ServerError`) × 8 tests × 12 hypotheses.
- `LikelihoodCalibrator` (Dirichlet-multinomial) rewrites rows from verified observations, seeded with a
  1.0 pseudocount per outcome, so rows with no data keep their structural prior.

### Update
Bayes' rule in log space, per observation:

```
log P(H_i | E) ∝ log P(H_i) + w · log P(E | H_i, T)
```

then `softmax` normalizes across hypotheses so `Σ P(H_i|E) = 1` within floating-point tolerance.
`w` is the dependency/reliability weight from the correlation model.

### Evidence dependence (the critical requirement)
`CorrelationModel::weight_for(prior_tests, test_id)`:

```
w = 1 / (1 + 0.5 · #{prior observations on the same causal path, excluding the same test})
```

- Repeating **the same** test over time keeps full weight (that is genuinely new evidence about the
  network at a later time).
- A different test on the same dependency (e.g. HTTPS and TLS both behind one resolver) is discounted.
- Consequence: three correlated successes cannot multiply into artificial certainty. This is
  conservative aggregation — where dependence cannot be modelled, confidence is understated, never
  overstated.

`adjusted_weights()` applies the same rule to a chronological sequence and returns aligned weights.

### Measurement reliability vs posterior probability
Kept as separate fields: `Evidence.reliability` weights the likelihood; the posterior is the
hypothesis probability. NANI does not report "87% confident" by conflating the two.

### Contradictory evidence
Handled naturally by subtraction in log space: a contradicting observation lowers the matching
hypothesis's posterior and, after normalization, raises the others. No special-case logic.

### Decay
`decay_log_likelihood(ll, age_seconds, λ)` shrinks stale evidence, so an old outage does not dominate a
current diagnosis.

## Tests
- `bayesian.rs` unit tests: normalization, entropy, ranking, invalid input rejection, decay monotonicity.
- `probability.rs`: `beta_bernoulli_update_moves_mean_toward_observed_frequency`,
  `missing_data_is_a_noop`, `variance_shrinks_with_more_data`, `credible_interval_contains_mean`,
  `beta_sample_matches_posterior_mean`.
- `evidence/correlation.rs`: independence, correlated discount, same-test full weight.
- `diagnosis.rs`: posterior normalization, auth/rate-limit/server-error separation.
- `foundation.rs`: uniform prior → posterior sum-to-one and entropy properties.

All green in the phase run: `cargo test network_intelligence::` → 340 passed; 0 failed.

## Calibration
`validation.rs` provides Brier score, log loss, ECE and MCE over 10 equal-width bins, plus
`CalibrationReport`. `evaluation.rs` reports a Brier score and ECE for the MAP diagnosis across
deterministic simulator seeds, and a Wilson 95% interval for accuracy.

## Known limitations
- Fixed dependence discount (0.5), not a learned covariance matrix; strong vs weak dependence cannot be
  distinguished.
- Credible intervals use a normal approximation (three-point z table), not the exact Beta quantile.
- Hierarchical priors exist (`hierarchical.rs`) but the diagnostic hypothesis prior is not yet pooled
  from verified history — `Prior` is structural unless a caller supplies `from_probs`.
- Post-hoc calibration rewrites likelihood rows; it does not recalibrate the posterior directly.

## Status
- Implemented: priors, likelihoods, log-space updates, dependence discount, decay, calibration metrics.
- Tested: yes.
- Benchmarked: `bayes_update` measured at 161.1 µs/update in a **debug** build (200 iterations, best of 3).
- Integrated: `foundation.rs` facade + `nani_math_rank_hypotheses` / `nani_math_entropy` Tauri commands.
- Verified: unit/integration level; **not** verified in the UI (no posterior display yet).
- Blocked: Hypothesis Explorer rendering of prior/posterior/evidence contributions.
