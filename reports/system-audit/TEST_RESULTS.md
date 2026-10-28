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

## Mission 3 closeout — bot tests, e2e harness, live smokes, Worker regression (2026-10-13, session 2)

Repos at closeout: **Vpn_app** `main @ 8ff3f75`, working tree clean before this report edit. **Abystral** `main @ 5343e1b` + 48 uncommitted Phase 6 files (migrations 0062/0063, purchase-request handlers/services/tests) — untouched by this session; that work remains the owner's uncommitted WIP and is reviewed, not committed, here.

### Bot tests (Abystral `workers/src/telegram` — Node v24.18.0, vitest 3.2.7)

| # | Command | Target | Exit | Passed | Failed | Notes |
|---|---|---|---|---|---|---|
| 20 | `npx vitest run tests/netpulse-service.test.ts` | netpulse-service | 0 | 16 | 0 | catalog, purchase-request mint/redeem, idempotency-key derivation |
| 21 | `npx vitest run tests/netpulse-repository.test.ts` | netpulse-repository | 0 | 14 | 0 | purchase-request CRUD, guarded redemption, expiry sweeps |
| 22 | `npx vitest run tests/netpulse-no-charge.test.ts` | netpulse-no-charge | 0 | 13 | 0 | **the 13/13 no-charge guard** — no NetPulse path debits a wallet, creates a subscription, or touches the panel |
| 23 | `npm test` (= `test:unit && test:stress`) | full unit suite | 1 | 3328 | 1 | 157/158 files, 198.62s; the single failure is a PRE-EXISTING stale-date test defect (below); the stress stage was not reached because the unit stage exited 1 |
| 24 | `npm run test:stress` | stress suites | 0 | 3 | 0 | buy-flow / stress-flow / user-api-load-stress, 12.21s |
| 25 | `npm run typecheck` (`tsc --noEmit`) | Abystral telegram | 0 | — | — | the Phase 6 working tree compiles clean |

**The single unit failure — investigated; NOT a Phase 6 regression, NOT a security gap.** `tests/admin-api.test.ts:707` ("subscription.extend … extends to an exact end date") expects 200, got 400. Root cause: the describe-block fixture anchors the subscription expiry at `now + 9 days` (≈ 2026-10-22 08:00 UTC) while the test hardcodes `to_date: '2026-10-15'` — a date the wall clock passed around 2026-10-06. The production guard (executor in `admin-api.ts`: "`to_date` must be after the current expiry") correctly rejects it. Evidence it is pre-existing: `admin-api.test.ts` is unmodified, and `git diff HEAD -- src/handlers/admin-api.ts` contains no extend/to_date/renew hunks — the logic is byte-identical at baseline `5343e1b`. Fix (test-only, owner's): derive the test's `to_date` from the anchored fixture (e.g. fixture expiry + 2 days). Not repaired in this session: the file is baseline code in the Abystral repo, and this closeout commits to the NetPulse repo only.

### End-to-end harness (`scripts/e2e-telegram-vpn.mjs`)

- Command: `node scripts/e2e-telegram-vpn.mjs --keep` with `NP_SERVICE_SECRET_FILE` pointing at the gitignored `Abystral/workers/src/telegram/.netpulse-secret.local` (the shared 64-char service secret, present locally, never printed).
- **Exit 2 = SKIP (an honest skip is not a pass). 8/8 executed checks passed, 1 environment skip, 0 failures.**
- Stage-by-stage (stages run against PRODUCTION services — `netpulse-cloud` and the real `abystralbot`; the harness mocks only the Bot API transport and the VPN proof node):
  - preflight **PASS** — secret loaded; sidecar = `src-tauri/backend` (the packaged sidecar: `netpulse-backend.js` + `node.exe` + `drizzle/`); cloud health 200.
  - staged 0 **PASS** — inbox rejects an unsigned delivery (401 `missing_signature_headers`) and a forged signature (401 `invalid_signature`) — fail-closed.
  - staged 1 **PASS** — registered throwaway `e2e-tgvp+…@example.com` (201, `usr__deeJTpZCNW2i8GU`); wrong password 401 `invalid_credentials`; valid login 200.
  - staged 2 **PASS** — `GET /subscriptions` 200 with **0 entitlements before any purchase**.
  - staged 3 **PASS** — the worker's signed outbound reached the REAL production bot and returned a one-time code (`nplink_a2cafe…`) + deep link `https://t.me/abystralbot?start=nplink_…`.
  - staged 4 **SKIP — bot-authority refusal (400 `invalid_or_expired`)**, by design: `/link/confirm` succeeds only when a REAL Telegram user taps the bot screen; no Telegram user exists in this environment. The harness's own `botAuthorityRefusal` branch records this as an environment skip, and its NB(deploy coupling) comment documents it as the expected outcome. This is a test-stage skip, **not** a successful end-to-end purchase — no purchase event was delivered and no entitlement was created.
  - staged 5–8 **NOT RUN** — unreachable without an active link; the sidecar/VPN leg never started.
- Safety properties held: no money moved, no real entitlement created, no customer record mutated. Footprint: one throwaway cloud account (`usr__deeJTpZCNW2i8GU`, no data, no entitlements) remains in production D1 by the harness's documented design ("nothing is deleted on the worker"); the bot-side link code expired after its 15-minute TTL.
- Evidence: `%TEMP%\netpulse-tgvpn-e2e\evidence\telegram-vpn-e2e.json`.

### Live adversarial inbox probes (production `netpulse-cloud`, signed with the real service secret)

**10/10 PASS** (probe script `%TEMP%\netpulse-phase3\adversarial.mjs`): stale timestamp → 401 `timestamp_out_of_window`; future timestamp → 401 `timestamp_out_of_window`; malformed JSON → 400 `invalid_json`; GET /events → 405 `method_not_allowed`; oversized payload → 413 `payload_too_large`; missing eventId → 400 `missing_required_fields`; unknown event type → 422 `unknown_event_type:…`; unsupported version → 422 `unsupported_event_version:…`; first delivery for an unknown account → 200, parked `no_link`; duplicate eventId → 200 `duplicate:true` (dedup no-op).
Bot signed-API probes: `GET /plans` and `POST /purchase-request` → **404 `not_found`** — Phase 6 is NOT deployed to the production bot: the signed wall answers 401 to unsigned requests (it is live), then the router 404s because the Phase 6 routes are absent from the deployed bundle. Expected deployment state, not a defect.

### Live production smokes

- **Worker 6/6 PASS** (production `netpulse-cloud`): health 200 `ok:true`; register 201 (throwaway `m3-smoke+…@example.com`); login 200; wrong password 401; no-token 401; inbox unsigned 401 `missing_signature_headers`. Cleanup: account hard-deleted (200) and post-delete login 401 — production D1 left clean.
- **Bot 7/7 PASS** (production `abystral-telegram`): `/health` 200 `status:ok`; public netpulse `/health` 200 (contract `netpulse-integration`, eventVersion 1, 12 event types); `/plans` unsigned 401 `missing_signature_headers`; webhook with no secret-token 401; webhook with wrong secret-token 401; `/webhook-info` unauthenticated 401; `/plans` signed 404 `not_found` (Phase-6 deployment-status probe).

### NetPulse Worker regression (Vpn_app `cloud/worker`)

| # | Command | Exit | Passed | Failed | Notes |
|---|---|---|---|---|---|
| 26 | `npm run test -w @netpulse/cloud-worker` | 0 | 91 | 0 | 4 files, 32.84s, miniflare D1 (local substitute, not production D1) |
| 27 | `npm run typecheck -w @netpulse/cloud-worker` | 0 | — | — | `tsc --noEmit` clean |

The 91 re-verify: missing/invalid signatures rejected; stale/future timestamps rejected (±5-min window); event payloads and event types validated; duplicate event IDs idempotent; unknown linked identities parked `no_link`; account authorization and cross-account isolation; service-auth failures fail closed (`service_auth_not_configured` 503). The no-charge guard (row 22, 13/13) proves NetPulse cannot autonomously initiate charges through the tested paths. What the tests do NOT prove: a real provider callback, a real TON deposit, or a real card/C2C approval — those need a payment sandbox that does not exist (limitation L2, REMAINING_ROADMAP.md).

## 2026-10-24 — bundle split, dependency audit, full gate re-run

Environment: Windows 11 · Node v24.18.0 · npm 12 · vitest 3.2.7 · Vite 7.3.7 · tsc 5.9 · eslint.

| # | Command | Target | Exit | Result | Notes |
|---|---|---|---|---|---|
| 28 | `npm run build -w @netpulse/web` | apps/web | 0 | PASSED | final entry chunk (after dependency update) **548,802 B / 169.8 kB gzip** (was 3,184,410 B / 920.1 kB). 22 lazy route chunks + shared vendor chunks. Only remaining over-limit warning is the 3D map route (1,265,870 B / 368.8 kB gzip), loaded on demand |
| 29 | Production bundle in a browser (`127.0.0.1:8787`, API-served `dist`) | apps/web | — | PASSED | initial `index-*.js` then `VpnPage-*.js` on navigation; VPN page rendered live API state; no console errors. Dev server (`vite --host 127.0.0.1`) also loaded `/` and `/vpn` through the lazy boundary |
| 30 | `npm run test:all` | 4 workspaces | 0 | PASSED | **1,527 tests, 0 failed**: api 1,013 · web 356 · shared 66 · cloud-worker 92. Parallel run, 114 s (api) |
| 31 | Typechecks (api, web, shared, cloud-worker) | all | 0 | PASSED | `tsc --noEmit` clean in all four projects after the dependency update |
| 32 | `npm run lint` | TS sources | 0 | PASSED | eslint clean |
| 33 | `npm audit` / `npm audit fix` | repo | 0 | PARTIAL | production tree now **0 vulnerabilities** (fastify 5.12.7, zod 4.6.7, ip-address 10.7.4, fast-uri 3.1.9/4.2.3, source-map-js 1.2.2, vite 7.3.7). 14 dev-only advisories remain (vitest 3→5, `@cloudflare/vitest-pool-workers` 0.9→0.23, wrangler/miniflare chain) and require major upgrades — not forced |

### Test-harness and flake repairs

- `scripts/test-all.mjs` parsed only the `Tests N passed` summary line, so every workspace reported “0 tests” and the totals were meaningless. It now reads the parenthesised total and the failed half of the same line.
- `apps/api/test/egressThroughProxy.test.ts` “does not touch the proxy when none is configured” failed (`503` instead of `200`) on this machine because a system proxy (`127.0.0.1:10809`) is enabled and refuses loopback targets. The test now measures `currentProxy()` first: the fixture listener must never be used (`connects === 0`) whether the machine is direct or proxied, and `200` is only required on a direct machine. The failure was environmental, not an egress defect — the production path correctly uses the system proxy.

### What this does not prove

Rows 18–19 remain **NOT VERIFIED** (live VPN/TUN with administrator rights, Abystral bot + payments); the dependency upgrades were not exercised against a deployed Worker.

## 2026-10-24 — dev toolchain upgrade (Vitest 5 + Cloudflare Vitest plugin)

Environment: Windows 11 · Node v24.18.0 · npm 12 · **vitest 5.0.5** · @cloudflare/vitest-plugin 1.4.7 · wrangler 4.152.0 · Vite 7.3.7.

| # | Command | Target | Exit | Result | Notes |
|---|---|---|---|---|---|
| 34 | `npm install` / `npm ci --dry-run` | repo | 0 | PASSED | vitest 3.2.7→**5.0.5** in all four workspaces; `@cloudflare/vitest-pool-workers` 0.9.14→`@cloudflare/vitest-plugin` 1.4.7 (upstream rename); wrangler 4.136.1→4.152.0. Lockfile re-resolved; `npm ci --dry-run` resolves cleanly |
| 35 | `npm run test -w @netpulse/cloud-worker` | cloud/worker | 0 | PASSED | 92/92 in 7.0 s. Required two migration changes, below |
| 36 | suite runs (api, web, shared) | 3 workspaces | 0 | PASSED | api 1,013 · web 356 · shared 66 — vitest 5 with `maxWorkers: 1` preserving the API's single-worker socket/SQLite discipline. No v5-specific breakage: the only config work was the v4 pool/plugin migration above |
| 37 | `npm run test:all` | 4 workspaces | 0 | PASSED | **1,527 tests, 0 failed** after the upgrade |
| 38 | Typechecks (4 projects) + `npm run lint` | all | 0 | PASSED | `tsc --noEmit` clean; eslint clean |
| 39 | `npm run build -w @netpulse/web` | apps/web | 0 | PASSED | entry chunk 548,802 B / 169.8 kB gzip unchanged; only the lazy 3D-map chunk warning |
| 40 | `npm audit` / `npm audit --omit=dev` | repo | 0 | prod clean | production **0 vulnerabilities**; 9 dev-only advisories remain (plugin, miniflare, undici, nested zod, wrangler, drizzle-kit esbuild chain). `npm audit`'s only "fixes" are downgrades (plugin 0.0.0, wrangler 4.35.0, drizzle-kit 0.18.1), so they are disclosed rather than applied |

### Migration notes (why the worker tests changed)

- **Config API moved.** `defineWorkersConfig` and its `poolOptions.workers` no longer exist; `cloud/worker/vitest.config.ts` now registers `cloudflareTest()` from `@cloudflare/vitest-plugin` as a Vite plugin, with the same wrangler path, local D1 and test bindings. `test/defineConfig.ts` (a CJS/ESM interop shim) was deleted.
- **Test typing moved.** The plugin types `cloudflare:test.env` as `Cloudflare.Env`, not the removed `ProvidedEnv`. `test/env.d.ts` now extends `Cloudflare.Env`, and the tsconfig includes `worker-configuration.d.ts` plus `@cloudflare/vitest-plugin/types`.
- **Isolation scope changed, deliberately restored.** The new integration isolates storage per test *file*; the old release rolled state back after every test, and these suites depend on that (registration is 5/hour/IP, login 20/15 min, and several tests exhaust a limiter on purpose). The first post-upgrade run failed 42/92 with 429/409. `test/applyMigrations.ts` now resets all tables and re-seeds the migration's `plan_pro` row in `beforeEach`; the suites are back to 92/92. Every file's `beforeAll` only deletes state and seeds inside test bodies, so the reset is safe.

### What this does not prove

Rows 18–19 remain **NOT VERIFIED** (live VPN/TUN with administrator rights, Abystral bot + payments). The wrangler upgrade was not exercised against a deployed Worker; `cargo audit` was not run.
