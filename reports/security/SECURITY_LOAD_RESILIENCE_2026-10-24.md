# NetPulse — Security, Load & Resilience Tests
**Date:** 2026-10-24  
**Scope:** tested boundaries and remaining live verification.

## Executed
- Full workspace test run: **1535 tests passed**.
- Cloud worker: **95 passed** (auth, rate limits, inbox idempotency, linking, entitlements, admin, password reset, vaults, provision).
- API: **1013 passed** (VPN lifecycle, self-test, tunnel/gateway, whitedns service, security).
- Web: **363 passed** (subscription view, cloud sync, UI states).

## Verified behaviors
- Signed service inbox rejects unsigned, stale, tampered, and replayed requests.
- Link/unlink/sync flows are idempotent and event-sourced.
- Profile upserts handle same-name re-import without 409.
- Admin plan patch validates JSON array defaults.
- Password reset is single-use and does not leak tokens in audit logs.

## Open live verification
- External DDoS/live-load soak is out of scope for unattended execution and should be gated behind a separate stress environment.
