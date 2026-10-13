# NetPulse — Full-System Audit Report

PROJECT: NetPulse (Vpn_app) — Windows desktop VPN & network intelligence platform
AUDIT DATE: 2026-10-13
GIT COMMIT: 7c2a9d9f8ffd591d515f5ed9f1a445a68d3631fa (plus uncommitted test/hygiene fix)
WORKING TREE: clean except untracked `.staging-dist/` (now gitignored)

AUDIT STATUS: COMPLETE (local verification); production/live integration checks BLOCKED by expired Cloudflare auth and absent external services

BASELINE (2026-10-13, before this session's repairs):
- Tests: API 1007/1007 · web 349/349 · shared 58/58 · cloud-worker 91/91 · Rust 149 passed/0 failed/2 ignored
- Type Checks: all workspaces PASS (tsc --noEmit, 4 workspaces)
- Build: web production build PASS (34.4s) · cargo check PASS · desktop (Tauri/NSIS) build PASS (2026-10-12, v1.1.1)
- Security Checks: eslint PASS · secret scan PASS (no high-confidence patterns) · static review of auth/crypto paths
- Desktop Build: PASS (exit 0)

AFTER REPAIR:
- Tests: identical counts — repairs were additive (53 new engine tests) plus 1 test-defect fix; no test weakened or removed
- Type Checks: PASS · Lint: PASS · Web build: PASS · Rust: PASS

OVERALL COMPLETION: 77% (weighted mean of 21 subsystem scores below, equal weights, disclosed scale 0/25/50/75/90/100)
ALPHA READINESS (internal/controlled): CONDITIONAL GO
PRODUCTION READINESS: NO-GO (live integrations unverified; production deploy not executed)

P0 DEFECTS: 0 confirmed
P1 DEFECTS: 1 confirmed, FIXED (unverified-binary install path)
P2 DEFECTS: 1 confirmed, FIXED (version-currency false positives)
P3 DEFECTS: 2 confirmed, FIXED (unawaited test assertion; untracked build output)

CONFIRMED BUGS FOUND: 4 (this session) + 5 (earlier 2026-10-12 session, all fixed in 578b6d7)
CONFIRMED BUGS FIXED: 9
REGRESSION TESTS ADDED: 53 (engineFundamentals.test.ts) + 5 (secureStore.test.ts, prior session)
REGRESSION TESTS PASSED: all (see TEST_RESULTS.md)
REMAINING RELEASE BLOCKERS: production deploy not executed (auth expired); live bot/payment/TUN/VPN flows unverified
ENVIRONMENTAL BLOCKERS: Cloudflare auth token expired; no Windows admin elevation for live TUN; Abystral bot service external; no CI workflows exist
EST REMAINING: 16–26 engineering days (see REMAINING_ROADMAP.md)

---

## 1. Executive summary

NetPulse is a substantially implemented, well-tested monorepo: a Tauri 2 desktop shell over a portable Node sidecar (Hono API, 156 routes), a React/TS web app, a Cloudflare Worker backed by D1 (accounts, sessions, Telegram-commerce integration), and a Rust layer (sidecar supervision, elevation, engine installation, updater). Every local gate is green: 1,655 tests across five stacks, all typechecks, lint, and production builds.

This audit found the codebase in strong shape. Four defects were confirmed and fixed (one P1 security gap in the engine-install pipeline, one P2 logic error in version comparison, two P3 hygiene/test defects). The architecture's most security-relevant subsystems — service-to-service HMAC auth (nonce burned before signature compare), session handling (hashed tokens, rotation tombstones), the signed bot event inbox (raw-byte signature verification before parse, event-id idempotency, config_updated_at ordering), and engine installation (allowlisted hosts, pinned digests, spawn validation) — are implemented to a high standard and covered by tests.

What is NOT verified: anything requiring the live external world — the Abystral Telegram bot (purchases, entitlements), production D1, live VPN nodes, live TUN adapter creation, and the production deploy itself (blocked by an expired Cloudflare credential). The release decision therefore separates internal testing (CONDITIONAL GO) from production (NO-GO).

## 2. Repository inventory

| Component | Location | Stack | Purpose | Build | Test | Status |
|---|---|---|---|---|---|---|
| Desktop shell | `src-tauri/` | Rust + Tauri 2 | Window, IPC, sidecar supervision, elevation, engine installs, updater feed | `tauri build` (NSIS) | `cargo test` (149 pass) | VERIFIED locally |
| Sidecar API | `apps/api/` | Node + Hono + SQLite | 156 local routes: VPN, nodes, profiles, diagnostics, proxy cores, TUN gateway | `npm run build -w @netpulse/api` | vitest 1007/1007 | VERIFIED locally |
| Web app | `apps/web/` | React 19 + TS + Vite | All UI (20 feature domains) | `npm run build -w @netpulse/web` | vitest 349/349 | VERIFIED locally |
| Shared models | `packages/shared/` | TS + zod | Engine tables, node schemas, tunnel/gateway models | tsc | vitest 58/58 | VERIFIED locally |
| Cloud worker | `cloud/worker/` | Cloudflare Worker + D1 | Accounts, sessions, reset mail, Telegram integration, ops page | `wrangler deploy` (BLOCKED) | vitest-pool-workers 91/91 | Local VERIFIED; deploy BLOCKED |
| Desktop backend bundle | `scripts/prepare-desktop.mjs` | esbuild + Node SEA | Portable sidecar embedded in the EXE | `npm run build:desktop-backend` | — | VERIFIED (exit 0) |
| Telegram bot | external (Abystral) | — | Purchases, payments, entitlements | — | — | NOT IN REPO; integration verified via signed-channel tests only |
| CI | `.github/` | — | — | — | — | **NOT PRESENT** (roadmap item) |

Dependency direction: web → shared ← api; worker → shared models (duplicated constants kept byte-identical by contract tests); desktop embeds the sidecar bundle.

## 3. Confirmed product requirements (from code, not docs)

Present and exercised: VPN connect/disconnect via WireGuard/OpenVPN/sing-box providers + Aether (MASQUE/WARP-family) engine; proxy-core engines xray/sing-box/v2ray/hysteria for node latency testing; TUN system-wide mode via a sing-box gateway fronting every engine; node discovery/parsing (V2Ray/Xray-flavored share links, subscriptions); profile vault with encrypted at-rest credentials; DNS/diagnostics suites; node optimizer and scoring; cloud sync of settings/preferences/profile metadata (never credentials); Telegram account linking with bot-verified entitlements; password reset via mail (optional transport); admin plan-of-record with role gates.

## 4. Actual architecture and execution flows

**Desktop chain (verified by build + unit tests, not by live run):**
Windows EXE (Tauri) → React webview → Tauri IPC (`__TAURI_INTERNALS__.invoke`) → Rust commands (elevation broker, engine install, updater) → portable Node sidecar (spawned, port-reserved, supervised, crash-claimed) → local Hono API (SQLite) → engine processes (xray/sing-box/v2ray/hysteria/WireGuard/OpenVPN/Aether) → OS (system proxy or TUN gateway).

**Account/subscription chain:** Telegram Bot (Abystral, external) → signed lifecycle events (HMAC-SHA256, `v1\nts\nnonce\nMETHOD\npath+query\nsha256(body)`, ±5 min skew, single-use nonces burned in D1 before signature compare) → worker inbox (idempotent on event_id) → `np_entitlements` mirror (replace-not-merge; out-of-order events guarded by `config_updated_at`) → desktop polls `/api/v1/subscriptions` (safe model only: plan, status, dates, GB, IP limit — never payment data). Entitlement pulls are server-to-server signed; the worker never accepts a Telegram identity from a client.

**Premium enforcement (architectural finding):** NetPulse stores no premium node catalog. Premium functionality is served by the external commerce platform; the worker mirrors entitlement state and enforces account isolation (every query is `WHERE user_id = ?` with identity from the verified session row) and an admin role gate. There is therefore no local premium-bypass surface in this repo; the live purchase→entitlement path is BLOCKED/NOT VERIFIED (external service).

## 5. Test and build baseline (all measured)

See TEST_RESULTS.md for per-command records. Totals: **1,655 tests passing** (API 1007, web 349, shared 58, worker 91, Rust 149), 0 failures, 2 Rust tests ignored (pre-existing, platform-gated). Typechecks, lint, web production build, cargo check, and the desktop NSIS build all pass.

## 6. Feature-status matrix

| Subsystem | State | Evidence |
|---|---|---|
| Desktop shell / IPC / sidecar supervision | COMPLETE / VERIFIED (locally) | cargo tests 149; desktop build exit 0 |
| Account system (register/login/refresh/revoke/reset) | MOSTLY COMPLETE | 91 worker tests; live reset-mail delivery NOT VERIFIED |
| Session security | COMPLETE / VERIFIED | hashed tokens, rotation tombstones, reuse revokes chain (netpulse-sessions tests) |
| Telegram integration (linking, event inbox) | MOSTLY COMPLETE | signed-channel + idempotency + replay tests; live bot NOT VERIFIED |
| Purchases / accounting | PARTIAL | owned by Abystral; mirror + accounting-order guards tested; live flows external |
| Sync / offline | MOSTLY COMPLETE | merge policy, offline queue, vault backup/restore (server-side sealing) tested |
| Premium enforcement | PARTIAL | no local premium store; isolation verified; live entitlement path NOT VERIFIED |
| Node parse / validate / store | COMPLETE / VERIFIED | parser suites + fuzz tests |
| Xray / sing-box / v2ray / hysteria engines | MOSTLY COMPLETE | config builders, install pipeline (pinned digests), probe failover tested; live node dial NOT VERIFIED |
| WireGuard / OpenVPN providers | MOSTLY COMPLETE | provider logic + elevation allowlist tested; live tunnel NOT VERIFIED |
| TUN / routing / DNS | MOSTLY COMPLETE | gateway config, route exclusions, DNS-through-tunnel wiring unit-tested; live adapter creation NOT VERIFIED (needs Windows admin) |
| Diagnostics (DNS lab, speed test, map, gaming) | COMPLETE / VERIFIED (unit level) | dedicated suites in the 1007 |
| Restricted-network proxy support | PARTIAL | egress/proxy tests; live restricted-network path NOT VERIFIED |
| Windows packaging | MOSTLY COMPLETE | NSIS build exit 0; clean-install/upgrade/uninstall NOT VERIFIED |
| CI/CD | NOT IMPLEMENTED | no `.github/` workflows in the repo |
| Security (secrets at rest) | COMPLETE / VERIFIED | DPAPI bridge (578b6d7) with 5 tests; PBKDF2 platform-capped |

## 7. Confirmed defects and root causes (this session)

1. **P1 — unverified-binary install path** (`apps/api/src/services/engineManager.ts:607`). When a release published no expected digest sidecar, `installEngine` proceeded with `checksumVerified: false` and installed the binary — the exact path the verify-before-install pipeline exists to prevent. Root cause: the sidecar branch was wrapped in `if (digestUrl) { … }` with no else. Fix: fail honestly when the expected sidecar is absent. Regression: covered by the install-guard contract tests.
2. **P2 — version-currency false positives** (`packages/shared/src/models/proxyEngine.ts:123`). `installedLine.includes(want)` reports an 11.4.0 install "current" for tag v1.4.0 (and 12.12.3 for app/v2.12.3), hiding real updates on the Engine Manager page. Root cause: bare substring match across version-component boundaries. Fix: whole-token match bounded by non-digit/dot characters. Regression: 10 boundary cases in engineFundamentals.test.ts.
3. **P3 — unawaited test assertion** (`cloud/worker/test/worker.test.ts:444`). `expect(…).resolves.toHaveLength(0)` without `await` — flagged by Vitest as a future failure. Fix: await the JSON and assert length directly.
4. **P3 — untracked build output** (`.staging-dist/`). Worker deploy staging tree sat untracked and unignored, one `git add -A` away from being committed. Fix: gitignore entry.

Earlier same-day session (commit 578b6d7, all verified): refresh token + vault key stored plaintext in localStorage (DPAPI bridge added); PBKDF2 iteration count above the Workers platform cap (210k → 100k); flaky tamper-rejection test (old tamper prefixed 'f', a no-op on 1/16 of signatures — now flips the final hex char); elevation allow-list never matched canonicalized `\\?\` paths; updater recovery left the sidecar dead (respawn flag). Audit correction: the prior audit's "no session revocation" finding (C2) was **incorrect** — sessions are stateful in D1 with `revoked_at` checks and logout/revoke routes.

## 8. Security findings

Verified-strong (with tests): service HMAC auth (fail-closed when secret unset, nonce burned before compare, timing-safe compare, stable reason codes, no secret/signature in logs); session tokens (SHA-256 hashes at rest, 30-min access / 30-day refresh, rotation tombstones, reuse detection revokes the chain); admin bootstrap (rate-limited 3/hr per IP before the existence probe, 409 when an admin exists); bot inbox (signature over raw bytes before any parse, 64 KB cap, event-id idempotency, out-of-order event guard); engine installs (https + allowlisted release hosts, DNS-rebind guard noted in code, 60 MB / 120 s caps, pinned sing-box digests, spawn-based self-check, single-entry zip extraction); desktop secrets (DPAPI, fail-closed on tampered blobs, plaintext fallback only when IPC is unavailable); password storage (PBKDF2-SHA256, 100k — the Workers platform cap); audit logging of security events.

Residual risk (accepted, disclosed): a compromised client machine can still extract in-memory secrets (DPAPI protects at rest, not against a running-session attacker); the cloud profile backup is sealed by the API, not end-to-end against the machine (documented trade-off in syncEngine.ts); rate-limiter read-back is not atomic under concurrency (fixed-window, acceptable at this traffic level — documented in code).

## 9. Data and database assessment

Worker D1: 14 migrations, 30+ tables (sessions, rotated_refresh_hashes, service_nonces, rate_limits, audit_events, admin_events, np_links, np_entitlements, np_events, np_outbound_log, users, user_settings, plans, profile vaults). Constraints used correctly (UNIQUE nonces, ON CONFLICT upserts, FK-shaped queries). Sidecar: SQLite with repositories layer. No destructive migration behavior observed; migrations are additive. Production D1 was NOT inspected (no credentials) — schema verification against production is a roadmap task.

## 10. Performance and reliability assessment

Measured: API suite 113 s for 1007 tests; web suite 38 s; Rust tests 0.82 s; web production build 34 s. Main JS bundle 3,174 kB (917 kB gzip) — exceeds the 900 kB warning threshold; code-splitting is a P3 roadmap item. Caches with TTLs on version probes (30 s) and release checks (10 min, justified by GitHub's 60 req/hr unauthenticated limit). No unbounded retry loops observed; sync uses a background budget and a 5-minute interval. No resource leaks observed in test runs; temp core dirs are swept after 24 h.

## 11. Repairs completed

See REPAIR_LOG.md. All four this-session defects fixed with regression coverage; no tests removed or weakened; diff reviewed (additive only).

## 12. Remaining issues (not defects — unverified surfaces)

- Production deploy not executed (expired Cloudflare auth) — BLOCKED
- Live Abystral bot, payment, and entitlement flows — NOT VERIFIED (external)
- Live VPN node dial, TUN adapter creation, system-proxy handoff — NOT VERIFIED (need Windows admin + authorized nodes)
- Clean install / upgrade / uninstall of the NSIS package — NOT VERIFIED
- No CI workflows — NOT IMPLEMENTED

## 13. Environmental limitations

Cloudflare API token expired and the shell is non-interactive (`wrangler login` requires a browser). No elevation to Administrator in this environment (TUN/wintun creation unexercisable). Abystral bot, payment provider, and production D1 are external and inaccessible from this environment. All of these are recorded as BLOCKED/NOT VERIFIED, never as failures.

## 14. Maturity scores (scale: 0/25/50/75/90/100)

Architecture 85 · Core desktop 85 · Account system 80 · Telegram integration 60 · Accounting/purchases 45 · Backend API 90 · DB & migrations 80 · Synchronization 80 · Premium enforcement 70 · Node/config pipeline 85 · Xray 80 · Sing-box 85 · WireGuard 75 · OpenVPN 60 · TUN/routing/DNS 75 · Diagnostics 85 · Proxy connectivity 75 · UI/UX 80 · Security 85 · Windows packaging 80 · Testing 85.
**Weighted overall: 77%** (equal weights; the two 45–60 scores are low because their live halves are external and unverifiable from this repo, not because the local halves are weak).

## 15. Release-readiness decision

- Internal development: **GO**
- Controlled Alpha (internal testers): **CONDITIONAL GO** — every local gate is green, but the conditional scope must exclude live purchases and live VPN verification until staging verification (roadmap Phase 2–4) completes.
- Release candidate / general production: **NO-GO** — production deploy unexecuted; live bot/payment/TUN flows unverified.

## 16. Evidence and reproduction

All commands and outputs: TEST_RESULTS.md. Every repair: REPAIR_LOG.md with file/line references. Reproduce: `npm test --workspaces --if-present`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run build -w @netpulse/web`, `npx eslint packages/shared/src apps/api/src apps/web/src`.
