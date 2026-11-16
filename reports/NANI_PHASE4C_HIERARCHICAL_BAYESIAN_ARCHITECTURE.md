# Phase 4C - Hierarchical Bayesian Architecture

## Objective
Extend the existing Beta-Bernoulli engine with a hierarchy, not a second inference system.

## Implementation
hierarchical.rs composes probability::BetaBernoulli. The parent is a device-level Beta model; children are per-(NetworkContextId, api_id) models. learning.rs uses the hierarchy for API reliability; diagnostic posteriors remain in diagnosis.rs.

## Evidence separation
- Local outcomes update only the child.
- Parent updates require observe_global.
- Local prior is initialized from the parent mean once.
- Missing outcomes are ignored.

## Tests
Parent/child isolation, sparse shrinkage, kappa behavior, exact posterior moments, snapshot round-trip, invalid parameters.

## Limitation
Kappa is fixed and parent hyperparameters are not jointly re-estimated. This avoids unstable small-sample MCMC but is less expressive than a full hierarchy.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3): update 139.2us, rank 4487.7us, route 0.1us.
