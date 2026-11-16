# Phase 4 - Simulation and Validation

## Objective
Measure diagnostic quality against a deterministic first-failure baseline.

## Method
evaluation.rs runs 11 network conditions x 20 chronological trials with NetworkSimulator and the diagnostic engine. Truth comes from the simulation condition; no future observations are used.

## Actual result
NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; mean posterior entropy 1.119.

Per-condition misses remain: TCP 12/20, remote endpoint 0/20, and others vary. Overall accuracy is not evidence that every condition is diagnosed well.

## Calibration
ECE 0.191 over 10 bins is poor: confidence is not yet reliable enough to treat a 90% MAP as 90% empirical accuracy. This is a measured gap, not a pass.

## Limitations
Simulator likelihoods are engineering priors, not field data. No real-world labeled dataset, no cross-network holdout, no complete hierarchical-vs-global ablation.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3): update 139.2us, rank 4487.7us, route 0.1us.
