# Phase 4C - Numerical Stability

## Objective
Reject invalid parameters and keep posteriors finite.

## Implementation
new() rejects non-positive or non-finite alpha, beta, kappa. Snapshot restore rejects corrupt parameters. Missing observations are no-ops. Probabilities use the existing clamped Beta implementation.

## Tests
Zero/negative prior, zero/NaN kappa, all-success posteriors, invalid snapshot, missing data, ESS and variance formulas. No silent NaN-to-number coercion.

## Limitation
Very large counts are u64 and not stress-tested at overflow; production counts are far below that limit.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3): update 139.2us, rank 4487.7us, route 0.1us.
