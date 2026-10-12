# NetPulse (Vpn_app) — Whole-Repo Analysis

Date: 2026-10-12. Scope: entire `Vpn_app` repository (monorepo: `apps/*`, `packages/*`, `cloud/*`, `scripts/`, `src-tauri/`).

## 1. Scale and layout

| Area | Files | LOC |
|---|---|---|
| apps/api/src | 129 | 32,607 |
| apps/web/src | 118 | 24,852 |
| cloud/worker/src | 9 | 2,837 |
| cloud/worker/migrations | 4 | 291 |
| cloud/worker/test | 7 | 1,762 |
| src-tauri/src | 17 | 5,226 |
| packages/* | 41 | 4,482 |
| scripts/ | 40 | 8,070 |
| docs/ | 13 | 1,201 |

npm workspaces: `packages/*`, `apps/*`, `cloud/*`; engines: node >=22 (env: v24.18.0).

### Web app (`apps/web/src`)
- `app/` — AppShell + session bootstrap (`useCloudSession.ts`)
- `features/` — 20 domains: account, cloudflare, dashboard, diagnostics, dns, engines, events, gaming, health, history, ip, iran, map, nodes, optimizer, routes, servers, settings, speed-test, vpn
- `lib/` — api, admin, cloud/, transport, ws, updater, elevationBroker, transfer, disclosure, failureIntelligence, format, geoStatus, startupPhase + hooks (usePersistentState, useStartupHealth, useVpnSelfTest, useBackgroundTest, useScheduleStatus)

### Desktop (`src-tauri/src`, 17 modules)
Rust/Tauri 2. Modules: main, elevation, updater_feed, diagnostics, dpapi (new), etc. Deps: tauri 2, serde, serde_json, url, rand 0.8, sha2 0.10, reqwest 0.12. No `windows` crate — dpapi.rs uses hand-rolled `extern "system"` FFI.

## 2. Architecture

- **Desktop**: Tauri 2 shell embedding a portable Node SEA backend (`src-tauri/backend/node.exe`, built by `scripts/build-backend-sea.mjs` via `prepare-desktop.mjs`) running the Hono API in loopback mode; webview loads the built web app. Web↔backend transport (`apps/web/src/lib/transport.ts`) resolves `__TAURI_INTERNALS__.invoke ?? __TAURI__.core.invoke ?? __TAURI__.invoke`.
- **API** (`apps/api`, Hono, ~156 routes across 27 route files + 2 in `src/realtime/`): global auth via `onRequest` hook (`app.ts` L702–713). Notable: `POST /api/v1/auth/session` (loopback+origin-gated cookie), `POST /api/v1/ws/ticket` (single-use 30s ticket), `GET /api/v1/ws`, `GET /api/v1/meta` (+`/capabilities` 5-min cache, `/health`, `/reset-state`), `GET /api/v1/vpn/selftest`, `GET /api/v1/network/status`.
- **Cloud worker** (`cloud/worker`): stateful sessions in D1 (`sessionByAccessToken` validates token hash, checks `revoked_at`; `revokeSession`/`revokeAllSessions` exist; `index.ts` exposes logout/revoke routes ~L415, L514–518). 14 migrations, 30+ tables.
- **Shared** (`packages/*`, 41 files): shared types/utilities across api/web/cloud.

## 3. Build & release

`desktop:build` = `release:version` (v1.1.1) → `build:desktop-backend` (tsup `desktop-index.cjs` 5.52 MB + Node SEA) → `tauri build` (NSIS only; updater disabled via `createUpdaterArtifacts: false`). Release tooling: `release.mjs`, `sign-release.mjs`, `update-feed.mjs`, `package-signed.mjs`, `verify-desktop-pipeline.mjs`, plus e2e/proof/audit scripts.

## 4. Test status (2026-10-12 gate run)

- api: **954/954 PASS**; web: **344/344 PASS**; typecheck all exit 0; desktop build exit 0.
- cloud-worker: **flaky** — 2/13 runs failed on `netpulse-integration.test.ts › netpulse inbox - service auth > rejects tampered bodies`.
- Pre-existing: `cloud/worker/test/worker.test.ts:401` — unawaited `expect(actual).resolves.toHaveLength()` promise; fails under Vitest 3.

## 5. Security posture (from audit `docs/app-review-audit-2026-10-12.md`)

- **C2 (audit claim: no session revocation) — INCORRECT.** Sessions are stateful in D1 with `revoked_at` checks and logout/revoke routes. Audit needs correction.
- **C1** — API key exposure; needs product decision (out of scope of code fixes).
- **C4/C5 — refresh token + vault key stored plaintext in localStorage.** IN PROGRESS: Rust DPAPI bridge (`src-tauri/src/dpapi.rs`: `secret_protect`/`secret_unprotect` commands, `CRYPTPROTECT_UI_FORBIDDEN`, app-scoped entropy `NetPulse.dpapi.v1`, hand-rolled base64, unit tests) + `apps/web/src/lib/cloud/secureStore.ts` (`dpapi1:` marker, `np.cloud.*` namespace, in-memory cache, `primeSecureStore()` migration sweep, plaintext fallback on IPC failure, web-mode degradation). Registered in `main.rs` `generate_handler!`. `hasTauriIpc()` exported from transport.ts.

## 6. Known issues / improvement backlog (prioritized)

1. **C4/C5 wiring — COMPLETE and verified.** `sessionStore.ts` (REFRESH_KEY/USER_KEY/SESSION_ID_KEY/LAST_SYNC_KEY via secureGet/Set/Remove; ACCESS_KEY stays in sessionStorage; DEVICE_ID_KEY plain), `vaultKey.ts` (cachedRaw/cacheRaw/clearVaultKey), `useCloudSession.ts` (`init` async: `await primeSecureStore()` before `initSession()`; consumed fire-and-forget by AppShell.tsx:322-327), `secureStore.test.ts` (5 tests). Verified: web typecheck exit 0, web tests 349/349, cargo check exit 0.
2. Cloud-worker flaky integration test (tampered-body rejection) — investigate timing/ordering.
3. `worker.test.ts:401` unawaited assertion — add `await`.
4. Hard-coded user paths in `scripts/launch-proof-servers.mjs:5` and `scripts/write-proof-configs.mjs:4` (`C:/Users/RADIN/...`) — use `os.tmpdir()`; these are dev proof scripts, not shipping code.
5. No CI workflows (`.github/` absent) — release gate is manual.
6. Updater disabled in `tauri.conf.json` (`createUpdaterArtifacts: false`) — intentional for now; feed tooling exists (`update-feed.mjs`, `updater_feed.rs`).
7. Windows-only dev/build story (CI claim by tooling agent was wrong — no CI at all).

## 7. Rust/C++ improvement options (from earlier analysis)

DPAPI bridge (chosen, in progress); other candidates: VPN tunnel in Rust (large), node health monitoring, traffic stats native sidecar, hardened elevation broker.
