# FABLE — Architecture Map (as actually built)

## 1. Process topology (desktop, Windows)

```
┌──────────────────────────────────────────────────────────────┐
│ netpulse.exe (Tauri v2, Rust)                                │
│  main.rs  — bootstrap, window, tray, single-instance, GC     │
│  sidecar.rs — spawns+supervises:                              │
│      backend/node.exe netpulse-backend.js  ← 157k-line bundle│
│        stdin: 64-hex daemon token (never on disk)            │
│        loopback 127.0.0.1:<ephemeral> HTTP+WS (Fastify)      │
│  elevation.rs — UAC broker (only path to admin)              │
│  dpapi.rs — CryptProtectData for webview secrets             │
│  updater_feed.rs — loopback no_proxy updater, minisign       │
│  commands/nani.rs — NANI Rust engine + Tauri IPC + events    │
│      (MonitorLoop, ApiRegistry, NaniMathEngine, Persistence, │
│       RecoveryPlanner, LearningEngine, Investigation, EventBus)│
└──────────────┬───────────────────────────────────────────────┘
               │ Tauri IPC (typed commands) + window.__TAURI__.event
┌──────────────▼───────────────────────────────────────────────┐
│ WebView2 — React app (bundled assets)                        │
│  transport.ts: chooses Tauri IPC or HTTP→127.0.0.1:<port>    │
│  Every page calls the API (Fastify) except NANI (Rust) in    │
│  desktop mode via naniApi.ts's isDesktopNani() switch.       │
└──────────────────────────────────────────────────────────────┘
```

## 2. The five state machines

1. **Sidecar lifecycle** (`sidecar.rs`): spawn → token via stdin → health wait → restart budget + cooldown + re-arm; exit code 78 = handshake failure. Startup buffer of stderr for diagnostics.
2. **VPN tunnel lifecycle** (`proxyTunnel.ts`): `idle → starting → (verify: traffic through CONNECT inbound → exit IP via `cdn-cgi/trace`) → active | failed`; crash → `down` + bounded reconnect (3 tries, backoff); stop always kills core, deletes temp config, restores previous system proxy. Only one tunnel at a time. Nested mode = two chained cores, both hops verified separately.
3. **Aether TUN lifecycle** (`aetherProvider.ts` + `tunClaim.ts`): elevation broker stages config (SHA-256 verified), claims route, verified by trace through TUN.
4. **Engine install lifecycle** (`engineManager.ts`): GitHub release lookup → pinned/sidecar digest verify → extract single binary → `<core> version` self-check → install. Unpinned sing-box assets are refused.
5. **NANI investigation lifecycle** (Rust `investigation.rs`): START → OBSERVE (real multi-layer probes via `api_intelligence/monitor.rs`) → ANALYZE (Bayesian posterior over 12 hypotheses) → VERIFY → COMPLETE/FAIL/CANCEL (cooperative cancellation via atomic flag). Events on `EventBus` → Tauri `nani:event` + 256-entry replay buffer (`nani_poll_events`).

## 3. Data ownership

| Data | Owner | Store |
|---|---|---|
| Node/endpoint catalogs, DNS benchmarks, gaming, network tests, profiles, public nodes, engine state, map observations, iran connectivity | Node sidecar | SQLite via drizzle (`src-tauri/backend/drizzle`) |
| NANI registry, posteriors, learning profiles, episodes, events | **Rust** `PersistenceStore` | files under data dir (JSON, `persistence.rs`) |
| NANI shadow loop (API health, recovery) | **Node** `NaniService` + `NaniShadowHealthLoop` | in-memory + repo tables |
| Sessions, refresh tokens, vault key | webview storage, DPAPI-protected via `dpapi.rs` | localStorage (encrypted blobs) |
| Cloud accounts/plans/telegram | Cloudflare Worker | D1 (`cloud/worker/migrations`) |
| Node secrets (config credentials) | `nodeSecretVault.ts` | vault beside profiles |

## 4. Event contracts

- Rust→webview: `nani:event` `{seq, event:{kind, payload}}`, replay via `nani_poll_events(since)`.
- Node→webview: WS `RealtimeBus` envelopes `{seq, at, type, payload, version}` on `nani:*`, `vpn-*`, `stability:*`, `vpn-selftest` topics.
- Frontend reducer (`naniEvents.ts`): normalize, dedupe by `${seq}:${type}`, gap/late-join detection, 200-entry buffer. Unknown kinds never fabricate activity.

## 5. Module dependency direction (verified)

- `packages/shared` ← `apps/api` ← (bundle) `src-tauri/backend` ← `src-tauri` (spawn only). Correct direction; Rust never imports Node logic and vice versa.
- `apps/web` ← shared types + transport. Pages depend on `lib/api.ts` (HTTP) or `lib/transport.ts` (Tauri invoke).
- Duplicated logic is **confined to NANI** (Rust engine vs `packages/shared/src/nani` + `naniService.ts`) and partially to failure classification (Rust `failure_classifier.rs` vs TS `failureIntelligence.ts`/`naniDiagnosticAdapter.ts`).

## 6. External trust boundaries

1. Loopback Fastify (token-authed) — webview↔sidecar.
2. UAC elevation broker — descriptor integrity + loopback handshake.
3. GitHub releases (engine downloads) — pinned digests + `version` self-check.
4. Cloudflare Worker ↔ D1 (auth, plans, telegram link, AI proxy).
5. Abystral worker (AI copilot target) — key-authed server-to-server.
6. Local LLM (opt-in llama.cpp) — explanation-only layer.
