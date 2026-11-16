# Phase 4C - Partial Pooling and Priors

## Objective
Share information without network contamination or double counting.

## Implementation
Default local prior strength is kappa=10. predict uses the child posterior mean only. ProfileStore::record no longer copies child observations into the global profile; independent parent evidence uses record_global.

## Tests
- One local success stays near 0.5.
- 200 successes/failures move predictions above 0.8 / below 0.2.
- Child observations leave the parent posterior exactly unchanged.
- 50 parent successes make a new context predict >0.8.
- Context isolation remains intact.

## Remaining issue
No production caller routes independent device-level outcomes to observe_global, so the parent stays at its configured prior unless evidence is supplied explicitly.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3): update 139.2us, rank 4487.7us, route 0.1us.
