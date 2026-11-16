# FABLE — Target Architecture

Grounded in what exists and works; changes only what evidence demands.

## 1. Principles

1. **One engine per concern.** Rust owns deterministic truth (VPN lifecycle, NANI math, persistence of NANI state). Node owns the wide service surface (catalogs, diagnostics, DNS, speed, node testing). TS owns presentation and contracts. No cross-language reimplementation of logic.
2. **Claims must be earned.** Every status a user sees is `verified` / `observed` / `not_tested` / `unavailable` / `blocked` (extend the missionControl taxonomy to every page).
3. **Minimal paid infra.** D1 only; no R2; the desktop's critical loop (connect, verify, diagnose) must never require the cloud.
4. **Bundles are build artifacts, never hand-edited**, with fingerprint freshness checks in packaging.

## 2. Rust core (src-tauri) — target responsibilities

| Area | Owner | Notes |
|---|---|---|
| App state, bootstrap, window/tray, single-instance | `main.rs` et al. | unchanged |
| Sidecar supervision | `sidecar.rs` | unchanged |
| Elevation / DPAPI / updater | `elevation.rs`, `dpapi.rs`, `updater_feed.rs` | unchanged |
| VPN lifecycle | stays in Node **today** (`proxyTunnel.ts`, `vpnService.ts`, `aetherProvider.ts`) with Rust-owned elevation + DPAPI; *future* option: move the tunnel verify loop into Rust (`reqwest` through the inbound) to remove the Node dependency from the critical loop. Not required for correctness now — the Node verify loop is honest and tested. |
| NANI engine (all math) | `network_intelligence/*` | + adaptive stopping wired (A-2); − dead exports (C-02); TS NANI core retired to contract-types only |
| NANI persistence | `persistence.rs` | single source of NANI truth on desktop |
| Events | `events/` + `commands/nani.rs` | unchanged contracts |

## 3. Node sidecar (apps/api) — target

- Keep: routes/services as-is, minus NANI loops in desktop mode (`NETPULSE_DESKTOP` gate).
- Failure classification: TS keeps **its own** categories for TS-originated features (node testing, DNS), but the API-registry/NANI-adjacent classification becomes a thin pass-through to shared taxonomy data (no second Bayesian layer).
- Services get an explicit lifecycle doc comment requirement (already common) — enforce in review.

## 4. Frontend (apps/web) — target

- Pages present backend state; they never derive their own measurements. (Verified already true for VPN and NANI; keep the rule.)
- `naniApi.ts` capability switch stays; fix the "same capabilities" wording to state the actual subset in web mode.
- Delete `nani-reports/`. Route churn: none.
- Keep lazy routes; split `LiveMapPage` chunk (1.27 MB) via dynamic import of three.js-dependent parts only on map open; `LatencyChart` (350 KB) → manualChunk with echarts or split into shared chart chunk.

## 5. IPC & event contracts

- Commands: typed Rust commands (existing) — add a single `nani://schema_version` constant exported to both event kinds and DTOs.
- Events: `{seq, at, type, payload, version}` normalized by `naniEvents.ts`; keep dedupe/gap/late-join. Add **schema version bump rule** to `NANI_API_EVENT_CONTRACTS.md` (it is currently a stub of 986 bytes).
- Reconnect/recovery: ws reconnection already exists in `lib/ws.ts`; NANI replay buffer (256) covers late join; add an integration test: kill ws → reconnect → no duplicate/dropped events in the activity feed.

## 6. Persistence architecture

| Data | Persist | Encrypt | Migrate | Expire | Export |
|---|---|---|---|---|---|
| VPN profiles + secrets | SQLite | key via vault/keychain | drizzle ✓ | no | yes (config export exists) |
| Node secrets | vault dir | OS keychain / DPAPI-adjacent | ✓ | no | no |
| Cloud session (refresh token, vault key) | webview storage | DPAPI (`dpapi.rs`) ✓ | n/a | on sign-out | no |
| NANI registry/posteriors/learning/episodes | Rust files (`persistence.rs`) | not needed (no secrets; verified) | version field in files — verify write path on schema change | rolling by retention policy | yes (evidence export) |
| Telemetry-style history (network tests, dns benchmarks) | SQLite | no | drizzle ✓ | retention sweep exists (`retention.sweep()`) | yes |
| Cloud entitlements/telegram | D1 | server-side | wrangler migrations (fix 0005 dup) | reset tokens expire | admin plan |

Corruption recovery: sidecar start failure → status surface honest offline state; SQLite WAL by default in better-sqlite3 (verify flag in `db/`) — add a start-time integrity check that quarantines a corrupt DB to `<dataDir>/corrupt-<ts>` and rebuilds empty, surfacing `blocked` state rather than crashing.

## 7. Infrastructure (cloud)

- Keep: Worker + D1, admin plan of record, ops pages, reset flow, AI proxy (503 when unconfigured).
- Remove from consideration: R2, additional stores — nothing in the workload needs them.
- Bot/Abystral: fix the pytest collection error (`tests/test_resilience.py`) as a separate workstream; the desktop must not depend on it.

## 8. Sequencing impact

The target architecture introduces **no rewrites**. It is: 1 gate, 1 wiring change (adaptive stopping), 2 consolidations (NANI engines, classifiers), several deletions, and packaging hardening — all independently shippable tickets (see Blueprint).
