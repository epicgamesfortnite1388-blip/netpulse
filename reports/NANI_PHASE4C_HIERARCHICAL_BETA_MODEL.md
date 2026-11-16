# Phase 4C - Hierarchical Beta Model

## Objective
Provide the full Beta posterior contract.

## Implementation
BetaPosterior exposes alpha, beta, effective sample size, mean, variance, credible bounds and predictive probability. posterior(context, api, level) returns the child; with no local data it returns the parent.

## Math
mean = a/(a+b); variance = ab/((a+b)^2(a+b+1)); ESS = a+b; predictive = mean.

## Tests
Beta(5,5) local prior + 12 successes/3 failures yields Beta(17,8), mean 0.68, variance 136/(625*26), ESS 25, and a credible interval containing the mean.

## Limitation
Credible bounds use the existing normal approximation, adequate for ranking but not an exact incomplete-beta quantile.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3): update 139.2us, rank 4487.7us, route 0.1us.
