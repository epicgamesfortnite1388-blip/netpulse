# 09 — Account and Entitlement Audit

**Verdict:** No client-writable entitlement path found. One P2 privilege-boundary defect was found and fixed by a concurrent agent during this cycle (DD-033 counterpart set).

## Architecture (verified)

- Identity originates from the cloud worker session, never from a client-supplied field: `cloud/worker/src/index.ts` resolves the user from the verified session/D1 record.
- Entitlement enforcement is server-side and fail-closed: provision gate at `index.ts:717-746`, VPS reconciler at `vpn-users.ts:186-219`. Prior accounting audit (DD-018) confirmed no path where local state grants premium access.
- Telegram linking is mediated by the bot; identity is never accepted from the client.
- Expiry: empty/whitespace `expires_at` is contract-defined as open-ended (bot authoritative, DD-014 ACCEPTED RISK); non-empty unreadable dates fail closed.
- Concurrency: unique indexes, status predicates, event dedup, single-flight refresh; the known read-then-upsert race (DD-012) remains a transient, self-healing P3.

## Defect found and repaired this cycle

**AI proxy role escalation (counterpart-set DD-033, P2).** `/api/v1/ai/ask` and `/ai/stream` previously took `role` from the request body and defaulted to `admin`, forwarding the caller's id in `x-ai-admin-telegram-id` to the admin-only upstream. Any authenticated non-admin could ask Copilot to act as an administrator.

**Fix:** `resolveAiRole()` in `cloud/worker/src/index.ts` now derives the effective role from the verified session's D1 `role`. Non-admins requesting `admin`/`developer` are downgraded to `support`; non-privileged roles remain usable; admins retain their requested role.

**Evidence:** `cloud/worker/test/aiRole.test.ts` — 4 tests, all passing. A concurrent agent's mutation check is recorded in the findings register.

## Boundaries respected

No real accounts, payments, subscriptions or production D1 data were touched. All verification used local fixtures and the worker's test suite.

## Residual items

- DD-011 (DPAPI downgrade) was fixed in this cycle with a fail-closed desktop path; see `08_SECURITY_AUDIT.md`.
- DD-012 (concurrent provision read-then-upsert), DD-013 (rate-limiter over-admission), DD-017 (AI header naming wart) remain OPEN/P4 and are documented in `17_REMAINING_RISKS_AND_LIMITATIONS.md`.
