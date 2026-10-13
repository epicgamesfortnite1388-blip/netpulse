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

## Mission 3 closeout — integration audit (2026-10-13, session 2)

**Repos:** Vpn_app `main @ 8ff3f75` (clean tree before the report edits in this commit); Abystral `main @ 5343e1b` + 48 uncommitted Phase 6 files (reviewed, NOT committed here — the Phase 6 work remains the owner's uncommitted WIP in the Abystral repo).

### Gate results (Mission 3 additions)

| Gate | Result | Evidence |
|---|---|---|
| Bot netpulse unit tests (3 files, individual) | **PASS** — 16/16, 14/14, 13/13 (the no-charge guard), exit 0 each | TEST_RESULTS.md rows 20–22 |
| Bot full unit suite | **PASS with 1 pre-existing defect** — 3328/3329, exit 1; the failure is a stale hardcoded date in a baseline test, byte-identical logic at `5343e1b` (not a Phase 6 regression, not a security gap) | row 23 |
| Bot stress suites | **PASS** — 3/3, exit 0 | row 24 |
| Bot typecheck (Phase 6 tree) | **PASS** — `tsc --noEmit` exit 0 | row 25 |
| End-to-end harness | **SKIP (exit 2)** — stages 0–3 executed 8/8 PASS against production; stage 4 intentionally skipped (bot-authority refusal, by design); stages 5–8 not run; NOT a successful purchase | TEST_RESULTS.md § e2e harness |
| Live adversarial inbox (production) | **PASS** — 10/10 signed probes; bot Phase-6 routes 404 (not deployed — expected) | TEST_RESULTS.md § adversarial |
| Live Worker smoke (production) | **PASS** — 6/6, throwaway account deleted, D1 left clean | TEST_RESULTS.md § smokes |
| Live Bot smoke (production) | **PASS** — 7/7 | TEST_RESULTS.md § smokes |
| NetPulse Worker regression | **PASS** — 91/91, exit 0; typecheck exit 0 | rows 26–27 |
| Phase 6 purchase-request code review | **PASS** — intent-only surface, three anti-double-charge layers, fail-closed HMAC, no path implies payment success before provider verification | below |
| Purchase-to-entitlement flow | **BLOCKED** — stage 4 needs a bot-side staging environment or a real Telegram test user | limitation L1 |
| Live VPN/TUN | **NOT VERIFIED** — needs Windows Administrator + authorized nodes (Phase 4) | row 18 |

### Phase 6 purchase-request review (static inspection of the uncommitted Abystral WIP)

- **Migration 0063** — scoped one-row flip (`solo_1ip` `config_access` 0→1, guarded by `AND config_access = 0`) plus `netpulse_purchase_requests`, an intent-only table: `token_hash` (SHA-256, raw token never stored), `UNIQUE(idempotency_key)`, price snapshots (cents + nanoton), status machine `pending|redeemed|expired|cancelled|failed`. No money column, no debit path.
- **Routes** — `GET /plans` (read-only catalog), `POST /purchase-request` (mint intent + `nppurq_` deep link), `GET /purchase-request/{id}` (status), `POST /purchase-request/{id}/cancel` (guard-shaped: a redeemed request can never be cancelled). All behind the signed service wall; all failures are stable codes with no data leakage.
- **Service (`netpulse.ts`)** — replay-first idempotency (a retried POST returns the ORIGINAL row with `duplicate:true` and no second token), per-account issuance cap, plan existence/active validation, price snapshotted at request time. The class never imports `WalletRepository` and never calls `beginPurchaseAtomically`.
- **Auth (`netpulse-auth.ts`)** — fail-closed (503 `service_auth_not_configured` when the secret is unset), ±5-minute timestamp window, single-use KV nonce (15-min TTL, burned only after every other check passes), constant-time signature compare, canonical string binds version·ts·nonce·method·path+query·SHA-256(body).
- **Identity binding** — redemption hashes the FULL `nppurq_` payload (the prefix is part of the match, so an identity-link token can never be presented as a purchase token), a guarded UPDATE binds `user_id`, and all failure replies are identical (no oracle).
- **Money path** — the debit happens ONLY in the unchanged Telegram buy flow, keyed `buy:${planCode}:${requestId}` (the request ID), whose UNIQUE index is the outermost anti-double-charge layer. **No code path implies payment success before provider verification** — the request stays `pending` until the bot's buy flow completes.
- **Production routes return 404** — CONFIRMED expected: the deployed bot bundle has the signed wall (401 to unsigned requests) but not the Phase 6 routes. Phase 6 is not deployed; this closeout does not deploy it.

### Updated release gates

- **Backend/service integration: PASS** — live smoke (Worker 6/6, Bot 7/7) + adversarial inbox (10/10) + Worker regression (91/91) against production, plus the bot unit/stress/typecheck evidence above.
- **Purchase-to-entitlement flow: BLOCKED** — the e2e harness proved stages 0–3 against production, but stage 4 (link/confirm) is bot-authority-gated: it needs a staging bot with stubbed Telegram identity verification, or a real Telegram test user. No staging bot or test user is available (external dependency).
- **VPN/TUN: NOT VERIFIED** — Phase 4 (Windows Administrator + authorized nodes) has not run.
- **Release candidate: NO-GO** — mandatory purchase-flow and VPN gates remain unresolved. Neither is a test failure; both are unrun checks and cannot be called passes.

### The three remaining purchase-flow limitations and the exact evidence to unblock each

- **L1 — Purchase-to-entitlement is bot-authority-gated.** The e2e harness's stage 4 requires a REAL Telegram user to tap the bot screen (or a staging bot whose Telegram identity verification is stubbed). *Evidence required:* a staging bot worker (with `TELEGRAM_BOT_BASE_URL` pointed at it) or an authorized Telegram test user; then rerun `node scripts/e2e-telegram-vpn.mjs` to completion (stages 4–7) — a live link claim, a delivered `subscription.activated` event, the mirrored entitlement, and the sidecar egress read.
- **L2 — No payment provider sandbox.** TONAPI is mainnet-only in the current integration; executing a real purchase moves real money. *Evidence required:* a TONAPI testnet/sandbox endpoint with a funded test wallet (or a provider sandbox), then a $0-value purchase executed end-to-end through the bot's buy flow.
- **L3 — Bank-card and C2C payments require human administrator approval.** They cannot be automated or simulated in production. *Evidence required:* a staging environment with the admin approval queue and an authorized administrator, observing a card/C2C approval through the queue.

**No production deployment, no production D1 mutation, and no real payment occurred during this mission.** The only production writes were: one throwaway e2e account (harness design, documented above) and one throwaway smoke account (hard-deleted, verified gone).

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
