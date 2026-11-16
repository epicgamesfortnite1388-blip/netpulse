# NANI Prediction and Optimization

## Implemented

- Route scoring (`route.rs`): success probability, latency, jitter, loss, stability, freshness, uncertainty, resource cost, security risk.
- Pareto frontier and confidence-aware ranking.
- CVaR and lower-confidence-bound scoring.
- Contextual bandit with Thompson sampling and safety filtering (`bandit.rs`).
- Survival models with right-censoring (`survival.rs`): Kaplan-Meier, Weibull, competing risks.
- Change-point detection and exponential smoothing.
- Hierarchical reliability prediction per API/context (`learning.rs`).

## Tested

- Route scoring, Pareto dominance, CVaR monotonicity, bandit selection.
- Kaplan-Meier survival/median, Weibull survival/median and invalid parameters, competing-risk cumulative incidence.
- BOCPD run-length statistics and changepoint validation.
- Full suite: 419 passed, 0 failed.

## Benchmarked

- Route scoring: **0.2 µs** per candidate in the debug benchmark.
- Diagnosis accuracy: 80.5% vs 63.6% fixed baseline over 220 simulated scenarios.
- No end-to-end VPN throughput or recovery-time benchmark was run.

## Limits

- Predictions are only as good as the likelihood/feature tables; no production calibration was performed.
- Survival data for real configurations was not available, so survival accuracy is not claimed.
- Optimization is not yet used to rank the free-configuration gatherer's output in a single integrated path.

## Deferred

- Quantile latency forecasting.
- Robust multi-objective optimization with measured resource costs.
- Online learning of route weights from verified recovery outcomes.
