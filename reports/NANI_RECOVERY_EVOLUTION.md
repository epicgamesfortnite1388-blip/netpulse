# NANI Recovery Evolution

## Implemented
- Recovery memory module (`recovery_memory.rs`) records verified outcomes and computes empirical success rates and prediction error.
- Existing recovery planner, circuit breaker, retry backoff remain.

## Not implemented
- Automatic policy evolution from recovery memory.
- Recurring failure detection and avoidance of ineffective actions.
- Recovery time prediction models.

## Safety
- Learning only from independently verified outcomes is enforced by API design (`verified_success` field).
- Deterministic recovery remains fallback.
