# 01 — Complete Architecture Map

**Method:** direct repository inventory (`find`, `grep`, file reads) at HEAD `3540347` plus the live dirty tree. No README or prior report was used as a source of truth.

## Workspaces and entry points

Root `package.json:6-10` declares workspaces `packages/*`, `apps/*`, `cloud/*`; version `3.2.0`, Node ≥22.

| Process | Entry point | Role |
|---|---|---|
| Web UI | `apps/web/src/app/router.tsx` (26 routed pages) | React 19 + Vite + TanStack Query, React Router 7 |
| API sidecar (dev/browser) | `apps/api/src/index.ts` | Fastify + better-sqlite3, port 8787 by default |
| API sidecar (packaged) | `apps/api/src/desktop-index.ts:83,99` | Loopback-only bind, per-launch bearer token from stdin, stdin-EOF graceful shutdown |
| Tauri shell | `src-tauri/src/main.rs` | Window/tray/sidecar supervision, ~50 `#[tauri::command]` handlers |
| Cloud worker | `cloud/worker/src/index.ts` | Cloudflare Worker: accounts, entitlements, provisioning, AI proxy |

## Backend layout

`apps/api/src/`: `app.ts` (Fastify wiring, pino redaction at :298-325), `auth.ts` (per-launch secret, desktop cookie removal), `config.ts`, `db/` (client, repositories, retention, schema), `plugins/errorHandler.ts`, `providers/` (dns, ipinfo, platform/{unix,windows}, registry, reputation, speed), `realtime/` (bus, wsRoute), `routes/` (34 route modules: adaptive, agent, auth, cloud, context, diagnostics, dns, endpoints, events, gaming, health, history, ip, iran, map, meta, mission, nani, naniDiagnostics, network, nodes, optimizer, ping, routes, servers, settings, speed, stability, tunnel, updateFeed, updateHistory, vpn, webrtc, whitedns), `services/`, `util/exec.ts` (spawn with `shell:false`), `vpn/` (vpnService, vpnState, vpnWatchdog, elevationBroker, providers).

`src-tauri/src/`: `main.rs`, `commands/{mod,nani}.rs`, `diagnostics.rs`, `dpapi.rs`, `elevation.rs`, `logging.rs`, `navigation.rs`, `os_open.rs`, `paths.rs`, `ports.rs`, `safe_mode.rs`, `sidecar.rs`, `status.rs`, `tray.rs`, `updater_feed.rs`, `webview_gc.rs`, `window.rs`, and `network_intelligence/` (30+ modules: bayesian, probability, math, diagnosis, investigation, persistence, recovery, api_model, validation, bandit, causal, changepoint, drift, episodes, graph, hardware, hierarchical, information_theory, learning, robust_stats, route, sequential, simulation, timeseries, foundation, etc.).

## Frontend layout

`apps/web/src/features/` holds 26 routed pages plus 2 orphaned feature directories. Shared state via TanStack Query + zustand; disclosure via `components/ui/DetailLevel.tsx`, `lib/detailLevel.ts`, `ui/Surface.tsx:143-150`. Transport boundary `lib/transport.ts` branches on Tauri IPC presence. Cloud session in `lib/cloud/{secureStore,sessionStore,vaultKey,client}.ts`. NANI UI uses IPC in desktop mode and `HTTP /nani/*` in web mode.

## Cross-boundary call paths (verified examples)

- **Elevated WireGuard connect (cycle-2 repaired):** `ProviderSurface.tsx:88` → `lib/elevationBroker.ts:45` (mint opId+nonce) → `POST /vpn/connect {elevation:{opId,nonce}}` → `apps/api/src/routes/vpn.ts:695` → `runElevatedWireGuardConnect` → `elevationBroker.registerWireGuardInstall` (stages config, binds nonce) → Rust `vpn_elevation_bridge {opId,nonce}` → `GET /vpn/elevation/pending?opId=&nonce=` → `fetchForBridge` → `validate_op` → `ShellExecuteExW` → `POST /vpn/elevation/result?opId=&nonce=` → resolves the long-poll.
- **Route compare deep link (cycle-2 repaired):** `NodeDetailPage.tsx:447` → `/routes?tab=vpn-compare&nodeId=` → `RoutesPage.tsx:180` → `GET /route-compare/vpn?nodeId=` → `apps/api/src/routes/routes.ts:83-94` resolves a stored node server-side (address never echoed).
- **Startup health:** `useStartupHealth.ts` polls `/meta/health`; degraded states tighten polling to 3 s.
- **Updater:** `scripts/update-feed.mjs` publishes signed artifacts; `src-tauri/src/updater_feed.rs:145-150` verifies minisign before install.

## Build / release / test inventory

- Root scripts in `package.json:14-69`: build, test, lint, desktop:*, release:*, e2e:*, test:release/signing/feed/pipeline/**build-gates (new)**, UI contract/visual/a11y/colour, probe/measure/proof scripts.
- Pipeline: `scripts/desktop-package.mjs` chains 9 steps with strict exit propagation (`:71-89`).
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml` (561 tests, 2 ignored).
- Web: `vitest run` in apps/web (60 files, 595 passed, 4 skipped).
- API: `vitest run` in apps/api (118 files, 1271 passed).
- Shared/cloud-worker suites and real-webview navigation backstop (`--ignored`, CI-only).

## Persistence

SQLite via drizzle (`apps/api/src/db/`), VPN profiles/config in app data dir, NANI snapshots/calibration in Rust persistence, DPAPI-protected secrets in WebView2 localStorage, update history, event bus (bounded at 500 topics).

## Dead / orphaned surfaces (verified, preserved)

`apps/web/src/features/nani-reports/` and `nani-memory` are not reachable from `app/router.tsx`; the latter lacks a `.ts` extension so tsc does not check it (DD-053). No code was deleted.
