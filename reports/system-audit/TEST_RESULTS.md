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
| 11 | `npx wrangler login` (interactive OAuth) | cloud/worker | PASS (auth) | 0 | — | — | — | — | authenticated as `radinshurideh@gmail.com` (account `4ca19fcad2d9fb155873fc9e0eb481e6`) |
| 12 | `npx wrangler whoami` | cloud/worker | PASS (auth) / FAIL (account match) | 0 | — | — | — | — | logged in, but config account `7380a67667052f3a7a3b11301ce7a77b` "does not match any of your authenticated accounts" |
| 13 | `npx wrangler d1 list` | cloud/worker | **FAIL (10000)** | 1 | — | — | — | — | authentication error — configured account not accessible to the authenticated identity |
| 14 | `npx wrangler d1 migrations list netpulse-cloud --remote` | cloud/worker | **FAIL (7403)** | 1 | — | — | — | — | "The given account is not valid or is not authorized to access this service" |
| 15 | Migration safety review (offline, 0001–0004) | cloud/worker/migrations | **PASS** | — | — | — | — | — | all additive; no DROP/DELETE/UPDATE; idempotent seed; safe order |
| 16 | `npx wrangler deploy` | cloud/worker | **BLOCKED** | — | — | — | — | — | not attempted: target account inaccessible; deploying into the personal account would create a wrong, non-production worker |
| 17 | Remote D1 backup / secret presence check / HTTP smoke | cloud/worker | **BLOCKED** | — | — | — | — | — | same account-authorization boundary |
| 18 | Live VPN / TUN / system-proxy verification | desktop | **NOT VERIFIED** | — | — | — | — | — | requires Windows Administrator + authorized nodes |
| 19 | Abystral bot, payment, live entitlement flows | external | **NOT VERIFIED** | — | — | — | — | — | external service, not in repo |

## Baseline vs post-fix

- Baseline (start of audit): API 1007/1007, web 349/349, shared 58/58, worker 91/91, Rust 149/0/2 — all green before any change; the two defects fixed this session were found by code review, not by failing tests (both were latent logic gaps).
- Post-fix: identical counts plus the fixed test defect (worker.test.ts:444 now awaits; the Vitest "not awaited" warning is gone).
- No test was deleted, weakened, or re-scoped. No test was marked passing without execution.

## Which results are baseline vs post-fix

- Rows 1–10 post-fix (run after repairs 7c2a9d9 and the worker-test await fix).
- Row 10 is a carry-over measurement from 2026-10-12 (no source affecting the desktop bundle changed since except dpapi.rs/main.rs, re-verified by rows 9 and 5).
- Rows 11–17 are the 2026-10-13 Phase 2 remote-execution attempt (see below).

## Phase 2 remote execution summary (2026-10-13)

- Completed independently: preflight (clean tree at d1a54e2), OAuth login, offline migration review, local regression (typecheck + worker 91/91 re-run).
- Blocked at the account-authorization boundary: the authenticated identity (`radinshurideh@gmail.com` / account `4ca19fcad2d9fb155873fc9e0eb481e6`) has no access to Cloudflare account `7380a67667052f3a7a3b11301ce7a77b`, which owns worker `netpulse-cloud` and D1 `31f2435b-3c23-42ad-b5b8-3b7f815d17dc`.
- No remote state was modified: no backup, no migration apply, no secret read/write, no deploy. The wrong-account deploy was deliberately refused.
- Unblock: authenticate an identity belonging to account `7380a…`, or set `CLOUDFLARE_API_TOKEN` to a token created in that account (Workers:Write, D1:Write, Account Settings:Read), then rerun the row 13–17 commands.

## Mocked vs real

- Worker tests run against miniflare's in-memory D1 — a faithful local substitute for D1 semantics, **not** a production database test.
- Engine install tests exercise the real download pipeline guards offline (pin-layer verdicts, extraction, self-checks); live GitHub downloads are exercised only by the pinned-digest test that fetches the real release metadata.
- No end-to-end test in this repo exercises a real VPN node, the real Telegram bot, or real payments. Those are NOT VERIFIED, per the mission's honesty rules.
