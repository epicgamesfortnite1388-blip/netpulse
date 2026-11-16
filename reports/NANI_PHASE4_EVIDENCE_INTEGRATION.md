# Phase 4 - Evidence Integration

## Objective
Connect validated measurements to personalization and hierarchical learning without bypassing validation.

## Implementation
LearningEngine::ingest runs COLLECT -> VALIDATE -> NORMALIZE, rejects invalid/missing measurements, then records the validated metric under the active context. API probe outcomes feed only the hierarchical reliability model. record_api_probe remains the production path from MonitorLoop.

## Invariants preserved
- Missing is not zero.
- Invalid evidence is rejected before profiles/reliability.
- LLM hypotheses never update counts.
- Child evidence does not update the parent.
- Context-less observations are rejected rather than assigned to context 0.

## Tests
Learning tests cover missing-data rejection, profile magnitude, hierarchical updates, drift, reset and correlated evidence. Context tests cover invalid metrics and missing context.

## Limitation
The diagnostic posterior still consumes explicit observations from its callers; it is not automatically fed by LearningEngine measurements. Integration is at the data-source level, not direct coupling.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3): update 139.2us, rank 4487.7us, route 0.1us.
