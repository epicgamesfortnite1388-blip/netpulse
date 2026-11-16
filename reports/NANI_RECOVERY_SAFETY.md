# NANI Recovery Safety

## Implemented
- Recovery state machine in `recovery.rs` (plan, steps, circuit breaker, rollback scaffolding).
- Bounded retries with jitter (`monitor_loop.rs::retry_backoff`).
- Policy filtering and action ranking with hard constraints (`route.rs`, `recovery.rs`).
- Audit events via `EventBus` (health changed, failure detected, circuit breaker tripped, route selected).

## Safety rules enforced
- No unlimited loops: retry caps and max backoff.
- No uncontrolled retry storms: circuit breaker open/half-open.
- Unauthorized actions filtered before ranking.
- Success requires independent verification in design; `UNVERIFIED` vs `SUCCESS` distinction documented.

## Not implemented
- Automatic system-wide network configuration changes (intentionally not allowed).
- Full rollback execution for all action types.
- User approval flow UI.

## Status
- Implemented and unit-tested: planner, circuit breaker, retry backoff.
- Experimental: full autonomous recovery execution.
