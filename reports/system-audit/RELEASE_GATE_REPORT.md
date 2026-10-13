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
| **Production deploy** | **PASS** — deployed 2026-10-13, verified live | row 16 |
| Production D1 migrations | **PASS** — 4/4 applied (0004 this session, after backup) | row 15 |
| Production auth/isolation smoke | **PASS** — register/login/revoke/isolation/inbox all verified live | row 17 |
| Live VPN/TUN verification | **NOT VERIFIED** — needs Windows admin + authorized nodes | row 18 |
| Live bot/payment/entitlement flows | **NOT VERIFIED** — external Abystral service | row 19 |

## Decisions

- **Internal development: GO.** Every local gate is green.
- **Controlled Alpha (internal testers): CONDITIONAL GO.** Phase 2 is complete (production deploy + live verification), so testers may now use the production-deployed cloud. Remaining scope condition: testers must not depend on live purchases, live entitlement changes, or live VPN connectivity until Phase 3 (bot sandbox) and Phase 4 (live tunnel) complete. No mandatory security gate is waived — the condition restricts scope, it does not excuse verification.
- **Release candidate / general production: NO-GO.** Mandatory criteria unmet: live purchase-to-entitlement chain, live VPN tunnel, and TUN adapter creation unverified. None of these are failures — they are unrun checks, and per the mission's rules they cannot be called passes.

## Phase 2 execution record (2026-10-13)

**Verdict: COMPLETE.** All steps executed against Cloudflare account `7380a67667052f3a7a3b11301ce7a77b` after the OAuth token was refreshed to include that account (the earlier account-boundary block is logged below for the record).

| Step | Result | Evidence |
|---|---|---|
| OAuth login (identity holds membership in both accounts) | PASS | `wrangler whoami` lists `4ca19fcad2d9fb155873fc9e0eb481e6` AND `7380a67667052f3a7a3b11301ce7a77b` |
| D1 visibility | PASS | `wrangler d1 list` shows `netpulse-cloud` = `31f2435b-3c23-42ad-b5b8-3b7f815d17dc` |
| Secret presence | PASS (5 configured) | AUTH_SECRET, NETPULSE_SERVICE_SECRET, OPS_TOKEN, RESET_PEPPER, TELEGRAM_BOT_BASE_URL present. EXPECTED_ORIGIN not set — it is an optional var (reset-origin guard is inert until configured), not a deploy blocker |
| Remote D1 backup (pre-migration) | PASS | 261,852 bytes at `C:\Users\RADIN\AppData\Local\Temp\netpulse-phase2\netpulse-cloud-backup-2026-10-13.sql` (outside the repo) |
| Migrations | PASS | 0001–0003 already applied; 0004_admin_plans.sql applied (7 commands, 1.46ms). Verified remotely: `users.role` column exists, `plans` table seeded with `plan_pro`/Pro, `d1_migrations` lists 4/4 |
| Worker deploy (production, top-level env) | PASS | `netpulse-cloud` at https://netpulse-cloud.shuridehradin.workers.dev — version `d76fb01a-f775-4ba0-966e-96470f8dbdbd`, 100% traffic, D1 binding `env.DB (netpulse-cloud)` attached |
| Health smoke | PASS | GET /api/v1/health → 200 `{"ok":true,"service":"netpulse-cloud","mail":false}` (D1 probe ok; mail honestly reported unconfigured) |
| Auth flows (live, test accounts) | PASS | register → 200 (user, role=normal, tokens, session); login → 200; wrong password → 401; no token → 401; admin route as normal user → 403 `admin_required`; sessions list → 200; logout → 200 and the old token → 401 (revocation works in production) |
| Cross-account isolation (live) | PASS | User B's vault-delete of user A's `profileId` → `{"ok":true,"removed":false}`; A's entry intact and readable by A only; B's own vault empty |
| Bot signed inbox fail-closed (live) | PASS | POST /api/internal/netpulse/v1/events → 401 for missing signature, fake signature, and empty body |
| Test-account cleanup | PASS | both phase2-* test accounts hard-deleted (DELETE /api/v1/account → 200; login afterwards → 401) |

Notes:
- Multi-account environments require `CLOUDFLARE_ACCOUNT_ID=7380a67667052f3a7a3b11301ce7a77b` (or matching config account) for `d1` subcommands; plain `wrangler deploy` targets the top-level (production) environment and warns about the additional `[env.staging]` — the warning is expected and the production environment was the deployed target.
- PowerShell 5.1 drops empty-string arguments to native executables, so `--env ""` fails to parse; plain `wrangler deploy` is the correct production invocation here.
- Staging environment was NOT deployed (see T2.4): staging reuses the production D1 by current design, and the separate-DB decision is still pending the operator.

**Earlier blocked attempt (2026-10-13, superseded):** the first OAuth login authenticated as `radinshurideh@gmail.com` whose token only covered account `4ca19fcad2d9fb155873fc9e0eb481e6`; all D1/Worker calls to `7380a…` failed (7403/10000). A fresh `wrangler login` after the account membership was in place resolved it. No remote state was modified during the blocked window.

**Migration safety review:** all 4 migrations are additive — CREATE TABLE/INDEX only, one `ALTER TABLE users ADD COLUMN role … DEFAULT 'normal'`, and an idempotent `INSERT OR IGNORE` seed row. No DROP, DELETE, UPDATE, column drop, or type change anywhere. Applied only after the pre-migration backup above.

## What would change the decision

- To CONDITIONAL GO → GO (Alpha): complete T3.2/T3.3 (bot sandbox link + idempotency) and T5.2-style isolation tests against the staging deployment (the production isolation half was verified live this session).
- To RC: additionally T4.2/T4.3 (live WireGuard + TUN with cleanup verification).
- Any confirmed premium bypass, cross-account exposure, forged-entitlement grant, or falsely-reported VPN connection is an automatic NO-GO regardless of test counts. None was found; the live isolation half was verified this session, the entitlement half remains unverified (Phase 3).

## Known accepted risks (disclosed, not waived)

1. Client-side secret extraction from a running session is possible (DPAPI protects at rest only).
2. Cloud profile backups are sealed by the API, not end-to-end against the machine (documented trade-off in `syncEngine.ts`).
3. Fixed-window rate limiter read-back is non-atomic under concurrency (acceptable at this traffic level; documented in `auth.ts`).
4. Staging environment reuses the production D1 database by current design (`wrangler.toml` `[env.staging]`) — isolation decision pending (T2.4); staging code was not deployed this session.
5. Password-reset email delivery is unconfigured in production (RESEND_API_KEY / MAIL_FROM / EXPECTED_ORIGIN unset): the reset flow fails closed and reports `mail_unconfigured` honestly — no token is delivered anywhere until mail is configured.
