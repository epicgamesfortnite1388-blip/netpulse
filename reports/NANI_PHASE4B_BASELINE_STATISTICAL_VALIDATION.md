# Phase 4B - Baseline Statistical Validation

## Objective
Ensure baseline summaries are finite, bounded and not fabricated.

## Implementation
MetricProfile tracks count, online median, MAD, min, max, sum, last value and update time. NetworkProfileEngine rejects non-finite, negative or empty metrics before storage. Missing measurements are rejected and never converted to 0.

## Tests
- 850 ms stays 850 ms.
- Missing measurements do not change reliability.
- NaN/negative/empty metrics are refused.
- Context baselines remain isolated.

## Limitation
The online median is an exponentially weighted approximation, not an exact quantile. It is bounded-memory and outlier-resistant but can lag after sustained shifts. Exact P50/P90/P99 would require a bounded sketch, not implemented.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3, 200 iters): update 139.2us, rank 4487.7us, route 0.1us.
