# NetPulse — Test Results (measured, 2026-10-13)

Environment: Windows 11 build 26200 · Node v24.18.0 · npm 12.0.2 · vitest 3.2.7 (API/web/shared) · vitest-pool-workers (cloud-worker) · cargo (Rust) · tsc 5.9 · eslint · Vite.

## Suite records

| # | Command | Component | Status | Exit | Passed | Failed | Skipped | Duration | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `npx vitest run` | apps/api | PASSED | 0 | 1007 | 0 | 0 | 113.26s | 94 files; includes new engineFundamentals (53) |
| 2 | `npm run test -w @netpulse/web` | apps/web | PASSED | 0 | 349 | 0 | 0 | 38.04s | 38 files; includes secureStore (5) |
| 3 | `npm test -w @netpulse/shared` | packages/shared | PASSED | 0 | 58 | 0 | 0 | 0.6s | 6 files |
| 4 | `npm run test -w @netpulse/cloud-worker` | cloud/worker | PASSED | 0 | 91 | 0 | 0 | 28.41s | 4 files; miniflare D1 (local substitute, not production D1) |
| 5 | `cargo test --manifest-path src-tauri/Cargo.toml` | src-tauri | PASSED | 0 | 149 | 0 | 2 ignored | 0.82s | ignored tests are pre-existing, platform-gated |
| 6 | `npm run typecheck` (all 4 workspaces) | all | PASSED | 0 | — | — | — | — | tsc --noEmit clean |
| 7 | `npx eslint packages/shared/src apps/api/src apps/web/src` | all TS | PASSED | 0 | — | — | — | — | no errors |
| 8 | `npm run build -w @netpulse/web` | apps/web | PASSED | 0 | — | — | — | 34.36s | production build; main chunk 3,174.16 kB / 917.52 kB gzip (>900 kB warning — P3, roadmap T6.3) |
| 9 | `cargo check --manifest-path src-tauri/Cargo.toml` | src-tauri | PASSED | 0 | — | — | — | 9.94s | |
| 10 | `npm run desktop:build` (release:version → build:desktop-backend → tauri build) | desktop | PASSED | 0 | — | — | — | — | verified 2026-10-12 at v1.1.1; NSIS bundle target |
| 11 | `npx wrangler login` (OAuth, refreshed) | cloud/worker | PASS | 0 | — | — | — | — | token now covers both accounts: `4ca19fcad2d9fb155873fc9e0eb481e6` and `7380a67667052f3a7a3b11301ce7a77b` |
| 12 | `npx wrangler whoami` | cloud/worker | PASS | 0 | — | — | — | — | lists both accounts |
| 13 | `npx wrangler d1 list` | cloud/worker | PASS | 0 | — | — | — | — | `netpulse-cloud` = `31f2435b-3c23-42ad-b5b8-3b7f815d17dc` visible |
| 14 | `npx wrangler d1 migrations list netpulse-cloud --remote` | cloud/worker | PASS | 0 | — | — | — | — | with `CLOUDFLARE_ACCOUNT_ID` set: 0004_admin_plans.sql was pending (0001–0003 already applied) |
| 15 | Remote D1 backup + migration apply | cloud/worker | PASS | 0 | — | — | — | 1.46s | backup 261,852 bytes to `C:\Users\RADIN\AppData\Local\Temp\netpulse-phase2\` (outside repo); 0004 applied (7 commands); verified `users.role`, `plans`/`plan_pro` seed, `d1_migrations` 4/4 |
| 16 | `npx wrangler deploy` (production, top-level env) | cloud/worker | PASS | 0 | — | — | — | ~11s | `netpulse-cloud` @ https://netpulse-cloud.shuridehradin.workers.dev — version `d76fb01a-f775-4ba0-966e-96470f8dbdbd`, 100% traffic, D1 binding attached |
| 17 | Live production verification suite | cloud/worker | PASS | 0 | 9 | 0 | 0 | — | health 200 (`mail:false` honest); register/login 200; wrong-password 401; no-token 401; admin-as-normal 403; logout revokes token (old token 401); cross-account vault isolation (B's delete of A's profile → `removed:false`, A's data intact); bot inbox 401 on missing/fake/empty signature; both test accounts hard-deleted afterwards |
| 18 | Live VPN / TUN / system-proxy verification | desktop | **NOT VERIFIED** | — | — | — | — | — | requires Windows Administrator + authorized nodes |
| 19 | Abystral bot, payment, live entitlement flows | external | **NOT VERIFIED** | — | — | — | — | — | external service, not in repo |

## Baseline vs post-fix

- Baseline (start of audit): API 1007/1007, web 349/349, shared 58/58, worker 91/91, Rust 149/0/2 — all green before any change; the two defects fixed this session were found by code review, not by failing tests (both were latent logic gaps).
- Post-fix: identical counts plus the fixed test defect (worker.test.ts:444 now awaits; the Vitest "not awaited" warning is gone).
- No test was deleted, weakened, or re-scoped. No test was marked passing without execution.

## Which results are baseline vs post-fix

- Rows 1–10 post-fix (run after repairs 7c2a9d9 and the worker-test await fix).
- Row 10 is a carry-over measurement from 2026-10-12 (no source affecting the desktop bundle changed since except dpapi.rs/main.rs, re-verified by rows 9 and 5).
- Rows 11–17 are the 2026-10-13 Phase 2 remote execution and live production verification.

## Phase 2 remote execution summary (2026-10-13)

- **COMPLETE.** Authenticated (OAuth token refreshed to include the target account), backed up remote D1 (261,852 bytes, outside the repo), applied the one pending migration (0004_admin_plans.sql) after the backup, deployed the worker to production (version `d76fb01a-f775-4ba0-966e-96470f8dbdbd`, 100% traffic), and verified the live service: health, registration, login, wrong-password rejection, unauthenticated rejection, admin gating, session listing, logout revocation, cross-account vault isolation, and bot-inbox signature fail-closed — all against the production origin.
- Test accounts (`phase2-a-982180@example.com`, `phase2-b-116537@example.com`) were hard-deleted after verification; login for both returns 401.
- Configuration gaps disclosed (not deploy blockers): RESEND_API_KEY, MAIL_FROM, and EXPECTED_ORIGIN are not set in production, so password-reset email delivery fails closed and reports `mail_unconfigured`; EXPECTED_ORIGIN is an optional reset-origin guard. Staging environment was not deployed (T2.4 decision pending).

## Mocked vs real

- Worker tests run against miniflare's in-memory D1 — a faithful local substitute for D1 semantics, **not** a production database test. The production D1 itself was exercised directly in rows 14–17.
- Engine install tests exercise the real download pipeline guards offline (pin-layer verdicts, extraction, self-checks); live GitHub downloads are exercised only by the pinned-digest test that fetches the real release metadata.
- No end-to-end test in this repo exercises a real VPN node, the real Telegram bot, or real payments. Those are NOT VERIFIED, per the mission's honesty rules.
