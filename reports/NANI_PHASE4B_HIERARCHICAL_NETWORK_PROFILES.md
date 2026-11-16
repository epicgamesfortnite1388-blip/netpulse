# Phase 4B - Hierarchical Network Profiles

## Objective
Share strength between sparse local profiles and the parent without double counting.

## Implementation
HierarchicalBetaBernoulli holds a global parent and per-(context, API) Beta children. A child is initialized from the parent mean with strength kappa. observe() updates only the child; observe_global() is the only parent update path. predict() returns the child posterior mean directly.

## Math
local_prior = Beta(mean_g*kappa, (1-mean_g)*kappa); posterior = Beta(alpha+s, beta+f); ESS = alpha+beta.

## Tests
Sparse profiles stay near the parent; mature profiles move to local data; larger kappa pools longer; child observations leave the parent bit-identical; new contexts inherit parent evidence; snapshot round-trip preserves posteriors.

## Limitation
Fixed-kappa empirical-Bayes pooling, not full MCMC estimation of a population distribution.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3, 200 iters): update 139.2us, rank 4487.7us, route 0.1us.
