# NetPulse — Release Gate Report

PROJECT: NetPulse (Vpn_app) v1.1.1
GIT COMMIT: 7c2a9d9f8ffd591d515f5ed9f1a445a68d3631fa
DATE: 2026-10-13
DECISION OWNER: this audit (evidence below)

## Gate results

| Gate | Result | Evidence |
|---|---|---|
| API test suite | PASS — 1007/1007 (94 files, 113s) | TEST_RESULTS.md row 1 |
| Web test suite | PASS — 349/349 (38 files, 38s) | row 2 |
| Shared package tests | PASS — 58/58 | row 3 |
| Cloud worker tests | PASS — 91/91 (local miniflare D1) | row 4 |
| Rust tests | PASS — 149 passed / 0 failed / 2 ignored | row 5 |
| Type checks (all workspaces) | PASS | row 6 |
| Lint | PASS | row 7 |
| Web production build | PASS (34.4s; chunk-size warning noted, P3) | row 8 |
| Desktop (Tauri/NSIS) build | PASS (verified 2026-10-12) | row 10 |
| Security review (auth, crypto, install pipeline, secrets) | PASS — no open P0/P1 findings | SYSTEM_AUDIT_REPORT.md §8 |
| Secret scan | PASS — no high-confidence patterns in source | audit session |
| **Production deploy** | **BLOCKED** — Cloudflare auth token expired | row 11/12 |
| Live VPN/TUN verification | **NOT VERIFIED** — needs Windows admin + authorized nodes | row 13 |
| Live bot/payment/entitlement flows | **NOT VERIFIED** — external Abystral service | row 14 |

## Decisions

- **Internal development: GO.** Every local gate is green.
- **Controlled Alpha (internal testers): CONDITIONAL GO.** Scope condition: testers must not depend on live purchases, live entitlement changes, or production-deployed cloud state until Phase 2 (deploy) and Phase 3 (bot sandbox) complete. No mandatory security gate is waived — the condition restricts scope, it does not excuse verification.
- **Release candidate / general production: NO-GO.** Mandatory criteria unmet: production deploy not executed; live purchase→entitlement chain, live VPN tunnel, and TUN adapter creation unverified. None of these are failures — they are unrun checks, and per the mission's rules they cannot be called passes.

## Phase 2 execution record (2026-10-13)

| Step | Result | Evidence |
|---|---|---|
| `wrangler login` (OAuth) | PASS — authenticated as `radinshurideh@gmail.com` | wrangler whoami |
| Authenticated account | `4ca19fcad2d9fb155873fc9e0eb481e6` | wrangler whoami |
| Configured target account | `7380a67667052f3a7a3b11301ce7a77b` (worker `netpulse-cloud`, D1 `31f2435b-3c23-42ad-b5b8-3b7f815d17dc`) | `cloud/worker/wrangler.toml` |
| `wrangler d1 migrations list … --remote` | **FAIL (7403)** — "not valid or is not authorized to access this service" | command output |
| `wrangler d1 list` | **FAIL (10000)** — "account_id … does not match any of your authenticated accounts" | command output |
| Remote D1 backup | **BLOCKED** — requires access to account `7380a…` | — |
| Remote migrations apply | **BLOCKED** — same | — |
| Worker deploy | **BLOCKED** — same | — |
| Secret presence check (`wrangler secret list`) | **BLOCKED** — same | — |
| HTTP smoke tests | **BLOCKED** — no deployment performed | — |

**Phase 2 verdict: BLOCKED at the authorization boundary.** The authenticated identity belongs to account `4ca19…`, which has no access to the configured account `7380a…` that owns the production worker and D1 database. Deploying into `4ca19…` was correctly refused: it would create a new, non-production worker with no production database — not the intended target.

**To unblock (exactly one of):**
1. Authenticate an identity that belongs to Cloudflare account `7380a67667052f3a7a3b11301ce7a77b` (`wrangler login` with that account's credentials), or
2. Set `CLOUDFLARE_API_TOKEN` to an API token created **in account `7380a…`** with `Workers:Write`, `D1:Write`, `Account Settings:Read` (for `secret list`), then rerun:
   - `npx wrangler d1 export netpulse-cloud --remote --file <secure-path-outside-repo>` (backup)
   - `npx wrangler d1 migrations list netpulse-cloud --remote` (pending list — expect 0001–0004 if never applied)
   - `npm run db:migrate:remote -w @netpulse/cloud-worker`
   - `npx wrangler deploy --env ""` (explicit production target; the config now defines multiple environments)
   - `npx wrangler secret list` (verify AUTH_SECRET, RESET_PEPPER, NETPULSE_SERVICE_SECRET, TELEGRAM_BOT_BASE_URL, EXPECTED_ORIGIN presence — names only)

**Migration safety review (completed offline):** all 4 migrations are additive — CREATE TABLE/INDEX only, one `ALTER TABLE users ADD COLUMN role … DEFAULT 'normal'`, and an idempotent `INSERT OR IGNORE` seed row. No DROP, DELETE, UPDATE, column drop, or type change anywhere. Safe to apply once access exists.

## What would change the decision

- To CONDITIONAL GO → GO (Alpha): complete roadmap T2.1–T2.3 (deploy + production health) and T5.2 (staging isolation tests).
- To RC: additionally T3.2/T3.3 (bot sandbox link + idempotency) and T4.2/T4.3 (live WireGuard + TUN with cleanup verification).
- Any confirmed premium bypass, cross-account exposure, forged-entitlement grant, or falsely-reported VPN connection is an automatic NO-GO regardless of test counts. None was found; the isolation and entitlement paths are unit-tested, but their live halves remain unverified.

## Known accepted risks (disclosed, not waived)

1. Client-side secret extraction from a running session is possible (DPAPI protects at rest only).
2. Cloud profile backups are sealed by the API, not end-to-end against the machine (documented trade-off in `syncEngine.ts`).
3. Fixed-window rate limiter read-back is non-atomic under concurrency (acceptable at this traffic level; documented in `auth.ts`).
4. Staging environment reuses the production D1 database by current design (`wrangler.toml` `[env.staging]`) — isolation decision pending (T2.4).
