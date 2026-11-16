# NANI Bayesian Intelligence

## Implemented

- Dynamic Bayesian diagnosis over 17 hypotheses (`diagnosis.rs`).
- Log-space prior/posterior updates (`bayesian.rs`), no probability underflow.
- Likelihood table indexed by test, hypothesis and outcome, including distinct auth/rate-limit/server-error outcomes.
- Time-based transition model: persistence decays with elapsed time; a zero interval is an identity update.
- Hierarchical Beta-Bernoulli reliability with partial pooling (`hierarchical.rs`).
- Correlated-evidence model (`evidence/correlation.rs`).

## Changed

Correlated probes no longer multiply the posterior as independent confirmations. The discount is applied to the log-likelihood, is bounded, and is gated on current confidence. It starts a new window after 5 minutes and never discounts a repeated identical test.

## Tested

- Posterior normalization and uniform entropy over the declared hypothesis space.
- MAP determinism (ties resolve to declared order).
- Correlated evidence integration: the HTTP probe sharing the resolver path receives weight < 1 after the DNS diagnosis is confident.
- `cargo test` total: 419 passed, 2 ignored.

## Benchmarked

Deterministic simulator (`evaluate(20)`, 220 scenarios, 11 conditions):

```
NANI 177/220 = 0.805 (95% CI 0.747..0.852) vs fixed first-failure 0.636
Brier 0.152, mean posterior entropy 1.010 nats
```

Per condition highlights: routing 19/20 vs fixed 0/20; MTU 16/20 vs 6/20; upstream proxy 19/20 vs 0/20; DNS 12/20 vs 20/20; TCP 11/20 vs 14/20. The DNS/TCP weaknesses are real and are not hidden: the simulator's DNS evidence is under-weighted by the likelihood table, not by the correlation layer. Fixing those priors is deferred and requires captured real outcomes.

## Deferred

- Prior/likelihood recalibration from production outcomes.
- Full dynamic Bayesian network over time with explicit state dwell distributions.
- Uncertainty-aware abstention threshold tuned per deployment.
