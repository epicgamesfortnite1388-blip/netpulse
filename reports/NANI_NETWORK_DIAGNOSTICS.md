# NANI Network Diagnostics

## Implemented
- DNS/TCP/TLS/HTTP layer probes in `api_intelligence/monitor.rs`.
- Failure classification (`failure_classifier.rs`) distinguishing DNS, TCP, TLS, HTTP status, auth, rate limit, server errors.
- API health state machine and circuit breakers (`registry.rs`, `recovery.rs`).
- IPv4/IPv6 and routing data structures in `api_model.rs` / `route.rs`.

## Scientific handling
- A successful TCP connection is not treated as API health; application-level verification required.
- Auth failures do not trigger route recovery.
- Retry-After and idempotency safeguards are part of retry policy design.

## Not implemented
- Full traceroute/MTU probing in production (simulated scenarios exist).
- QUIC/UDP deep diagnostics beyond classification scaffolding.
- Real packet capture (intentionally avoided).

## Status
- Implemented and unit-tested: registry, monitor, failure classifier, retry backoff.
- Experimental: end-to-end real network probing against live endpoints.
