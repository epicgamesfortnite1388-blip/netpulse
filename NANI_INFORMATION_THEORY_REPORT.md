# NANI Information Theory Report

## Definitions implemented

### Entropy
`H(H) = −Σ pᵢ ln pᵢ` in nats.
- `Prior::entropy` / `Posterior::entropy` (hypothesis uncertainty).
- `Categorical::entropy` (distribution uncertainty).
- `math::bernoulli_entropy`.
- `DiagnosticEngine::uncertainty()` returns the current hypothesis entropy; the uniform 12-hypothesis
  prior gives exactly `ln 12 ≈ 2.4849` (asserted in `information_theory.rs::diagnostic_engine_uncertainty_matches_foundation`).

### Expected information gain
For test `T`:

```
IG(T) = H(H) − Σ_o P(o | T, D) · H(H | o, T, D)
P(o | T, D) = Σ_h P(o | h, T) · P(h | D)
```

Implemented in `diagnosis.rs::expected_information_gain`. Outcome space is six-valued, so an
`AuthRejected` probe and a `Failure` probe carry different information — a 401 is not evidence of
connectivity loss.

### KL / JS divergence
`math::kl_divergence` returns `∞` when Q assigns no mass where P does; `js_divergence` is symmetric and
always finite (used by drift to compare distributions without singularities).

### Cost-adjusted utility
`sequential::cost_adjusted_gain(IG, cost, ε) = IG / (cost + ε)`.
`sequential::value_of_information(prior_loss, posterior_loss, cost) = prior_loss − posterior_loss − cost`;
negative VOI means the probe is not worth running (test: `value_of_information_negative_when_cost_exceeds_benefit`).

### Stopping
`sequential::should_stop(best_gain, gain_threshold, confidence, confidence_target)` — stop when the best
available gain falls below threshold **or** confidence already exceeds target.
`information_theory::should_stop_by_budget(accumulated_ig, ig_budget, marginal_efficiency, threshold)` —
stop when the information budget is spent or marginal efficiency collapses. Both prevent unbounded probing.

### Unified cross-category selection
`information_theory::select_best_probe_unified(engine, routes, apis, recovery_actions)` scores
diagnostic tests, routes, API endpoints and recovery actions on one axis (`IG` per unit cost) and returns
a `ScoredProbe { category, id, expected_information_gain, cost, efficiency, net_value }`, so the engine can
compare "ping the gateway" against "retry through upstream B" on information-theoretic grounds rather than
a hardcoded order.

## Adaptive loop (as implemented)
1. Posterior from prior + evidence (`bayesian_update`).
2. Uncertainty (`DiagnosticEngine::uncertainty`).
3. Candidate generation (`rank_tests` / `select_best_probe_unified`).
4. Expected IG per candidate (with cost).
5. Safety/authorization filter (probe must be authorized; recovery actions come from the planner).
6. Select max efficiency.
7. Execute (caller).
8. Validate (`evidence/validation.rs`).
9. Update beliefs (with dependency discount).
10. Repeat while `should_stop` is false.

## Tests
- `information_gain_matches_ranker` — a single test's IG equals its value in the ranking (shared estimator).
- `expected_information_gain_diagnostic_wraps` — IG is present and non-negative.
- `rank_route_probes_sorted_by_efficiency` — sorted by efficiency.
- `cost_adjusted_gain_prefers_lower_cost`.
- `should_stop_when_confident`, `should_stop_by_budget_test`.
- `value_of_information_negative_when_cost_exceeds_benefit`.
- `categorical_entropy_is_maximal_for_uniform` (ln 3 within 1e-9).
- `kl_divergence_same_distribution_is_zero`, `js_divergence_is_symmetric_and_finite`.

## Honest caveats
- `expected_information_gain_route` computes `KL(posterior || prior)` where the "posterior" is derived from
  candidate reliability. This is a **heuristic sharpening score**, not a rigorous expected IG over route
  outcomes: the candidate index does not change the value, so all routes currently share one IG and
  ranking is effectively by cost. It is defensible as a divergence-from-baseline measure, but it should
  not be described as a Bayesian expected information gain. Flagged, not silently accepted.
- Entropy is in nats everywhere; any UI that shows bits must divide by `ln 2`.
- IG is not clamped: an IG of exactly 0 is possible for a probe that cannot change beliefs, and is
  treated as "not worth running" by the stopper.

## Status
- Implemented: entropy, IG, KL/JS, cost-adjusted utility, VOI, two stopping rules, unified ranking.
- Tested: yes.
- Benchmarked: `rank_tests` ≈ 5007.6 µs in a **debug** build (200 iterations, best of 3) — dominated by
  per-outcome engine cloning; route scoring 0.1 µs.
- Integrated: `foundation.rs`, `information_theory.rs`, Tauri commands `nani_math_select_probe`,
  `nani_math_should_stop`, `nani_math_entropy`.
- Verified: unit level. Not verified end-to-end in the desktop UI.
- Blocked: none functionally; UI surfacing of "why this probe" is pending.
