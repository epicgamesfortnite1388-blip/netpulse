# Subscription Provisioning

**Status:** PARTIAL — Cloudflare Worker and D1 verified; provisioning adapter not implemented.

## Cloudflare Worker

- Worker: netpulse-cloud (deployed)
- URL: https://netpulse-cloud.shuridehradin.workers.dev
- D1: netpulse-cloud database
- Migrations: 0001-0004 applied (0004 admin plans)
- Auth: register/login/logout/refresh working (verified live)
- Cross-account isolation: verified (User B cannot see User A's data)
- Signed inbox: 401 to unsigned requests (verified)

## D1 Schema (relevant tables)

- users, sessions, np_links, np_entitlements, np_events
- np_outbound_log, service_nonces, rate_limits, audit_events
- plans (seeded with plan_pro)

## Purchase/Entitlement Flow

- Bot Phase 6 routes: implemented in Abystral WIP but NOT deployed (404 on live)
- Entitlement snapshot route: implemented, compare logic present
- Drift detection: code present, unit-tested, e2e not demonstrated

## Provisioning Adapter

- No provisioning adapter implemented between Worker and VPS Xray
- No per-user client creation via API
- No profile delivery endpoint integrated with D1
- No automated revocation on expiry
- Manual profile exists (single shared client UUID) — needs per-user provisioning

## Blockers

- B1: No provisioning API on VPS (x-ui has API but not integrated)
- B2: No per-user client creation automated
- B3: No profile delivery endpoint in Worker
- B4: Bot Phase 6 not deployed
- B5: No reconciliation job for drift detection
