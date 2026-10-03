# Architecture

## Overview

```
┌─────────────────────────────────────────────┐
│                React UI (web)               │
│   React 19 · Vite · Tailwind 4 · Recharts   │
│   pages per feature domain, live via WS     │
└──────────────┬──────────────────────────────┘
               │ REST (JSON) + WebSocket
┌──────────────▼──────────────────────────────┐
│              Fastify API (api)              │
│  routes → services → repositories           │
│  realtime bus (WS), background job registry │
├─────────────────────────────────────────────┤
│              Provider layer                 │
│  platform (ping/trace/dns/mtu/interfaces)   │
│  speed · dns transports · ipinfo · reputation│
│  vpn providers (wireguard/openvpn/sing-box/ │
│    aether) · proxy tunnel · core-process    │
│    owner · kill switch · TUN gateway        │
├─────────────────────────────────────────────┤
│           Drizzle ORM + SQLite              │
└─────────────────────────────────────────────┘
```

## Desktop shape (packaged app)

The same code runs as a native Windows app with one transport seam:

```
Windows .exe (Tauri v2)
└─ webview  http(s)://tauri.localhost        ← UI origin (browser rules apply: CORS, preflights)
     │  typed IPC only: bootstrap → { api_base, ws_base, token }   (tauriInvoke resolver)
     │  Bearer-authed HTTP/WS over loopback
┌────▼────────────────────────────────────────┐
│  Node sidecar (bundled portable runtime)    │
│  stdin-token handshake · 127.0.0.1:<ephemeral> │
│  Rust watchdog: bounded respawn + death records │
└────┬────────────────────────────────────────┘
     └─ the Fastify API stack above, unchanged
```

Three invariants keep this link alive (each was once broken, invisibly to HTTP probes —
see `DESKTOP.md` → "The UI ↔ sidecar link"):

1. **IPC**: resolve `invoke` only via `tauriInvoke()` (`transport.ts`); Tauri v2 exposes it at
   `__TAURI__.core.invoke`, and a failed resolution silently degrades the app to same-origin web
   mode where requests never reach the sidecar.
2. **CORS**: the sidecar allowlist must include `http(s)://tauri.localhost` because authed requests
   preflight (`DESKTOP_WEBVIEW_ORIGINS`, locked by `desktopCors.test.ts`).
3. **URLs**: `bootstrap.api_base` includes `/api/v1`; `ws_base` does not (`ws.ts` hardcodes its path).

### Rust module layout (`src-tauri/src`)

`main.rs` owns startup and the IPC surface; everything with its own state or its own failure
mode lives in a sibling module. A concern belongs in a module when reading it requires
context `main.rs` does not have.

| Module | Owns | Depends on |
|---|---|---|
| `sidecar.rs` | Bundled-runtime spawn, stdout/stdin handshake, bounded-respawn watchdog, log sink (`log_info!`/`log_warn!`/`log_error!` write here) | — |
| `elevation.rs` | The only path to administrator rights: the app-level rights check + single-call elevated relaunch, and the per-action WireGuard tunnel-service broker | `sidecar` (logging) |
| `updater_feed.rs` | Update-feed fetch/parse/verify | `tauri_plugin_updater` only — it logs nowhere |
| `window.rs` | Main-window presentation only: restore, size to the monitor's **work area** in logical pixels (DPI-scaled), centre, focus, and the bounded post-startup re-assert | `sidecar` (logging), `tauri::Manager` |
| `paths.rs` | The single resolver for the app data dir and the rotating log dir, plus the `data_paths` command | `tauri::PathResolver` |
| `safe_mode.rs` | The `--safe-mode` flag end to end: parsed once from `argv`, held in managed state, announced to the sidecar | `sidecar` (logging) |
| `status.rs` | The runtime-status snapshot the System Health page polls — an aggregator, owning nothing itself | `sidecar`, `paths`, `safe_mode` |
| `diagnostics.rs` | Redacted log tail and the exported JSON diagnostic report (the second secret filter) | `paths`, `status`, `sidecar` (logging) |
| `os_open.rs` | The only two places the webview can make the OS act: reveal a path inside the app's own directories, open an https URL — both allow-listed, both without a shell in the chain | `tauri::Url`, `sidecar` (logging) |
| `main.rs` | Process assembly and the IPC surface: the bootstrap handshake, the cross-module repair/reset commands, and the `setup` / window-event / run-loop wiring | all of the above |

Three rules hold this together:

- **Window presentation is one decision made in one place.** Sizing, centring and restoring all
  live in `window.rs` and are triggered from `RunEvent::Ready` — not in `setup` (Windows has not
  finished showing the window, and minimises it again afterwards) and not in `tauri.conf.json`
  (a fixed pixel size is wrong on every display but the one it was written on). If you are
  changing how large or where the window appears, `window.rs` is the only file to edit.
- **The log macros are the one shared channel.** `log_*!` all funnel through
  `sidecar::write_log`, so a module can log without knowing where logs are stored or how. Use
  them rather than `println!`/`eprintln!`. Not every module logs: `paths.rs`, `status.rs` and
  `updater_feed.rs` are pure resolvers/aggregates with nothing of their own to report.
- **One resolver per directory, one owner per fact.** The data dir and the log dir come from
  `paths.rs` and nothing else — the `setup` hook, the `data_paths` command and `reset_app_state`
  each used to derive them independently, while the rotating log deliberately lives under the app
  **data** dir (`<data>/logs`, written before any `AppHandle` exists) and *not* under Tauri's
  `app_log_dir()`, which resolves to LocalAppData on Windows. Safe Mode is the same shape of rule:
  the flag is parsed from `argv` exactly once, before any window exists, and every reader asks
  `safe_mode::is_active`; the runtime-status command used to re-parse `argv` for the same boolean.

> **Testing note.** `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` is clean
> and should stay clean — it is the only gate that reaches the test-only code. `scripts/audit-layout.mjs`
> is the real gate for anything in `window.rs`:
> it launches the packaged `netpulse-desktop.exe` over CDP and measures the live window at
> 1024/1440/1920 in both themes. It short-circuits when the EXE already exists — **delete
> `src-tauri/target/release/netpulse-desktop.exe` (or run `npx tauri build --no-bundle`) before
> trusting it after a Rust change**, or it will pass against a stale binary.

## Monorepo

npm workspaces:

- **`packages/shared`** — Zod schemas (request validation, shared between API and UI),
  domain model types, and the statistics/scoring engine (`median`, `jitterMs`, `lossPct`,
  `latencyScore`, `scoreEndpoint`). No I/O here; everything is pure.
- **`apps/api`** — Fastify server. TypeScript strict, ESM.
- **`apps/web`** — React 19 SPA served by Vite; in production the API serves the built
  bundle from `apps/web/dist`.

## API layering

```
routes/*.ts        HTTP/WS boundary: Zod validation, auth (via hooks), no business logic
services/*.ts      Orchestration: test lifecycle, persistence, event emission, progress
providers/*        All side effects: OS commands, network I/O, external HTTP
db/repositories.ts Only place that touches Drizzle tables
```

Long-running tests follow one uniform contract:

1. `POST …/run` validates and returns `{ testId }` immediately (HTTP 200/202).
2. The service registers the test (`TestsRepository.create`) and publishes
   `test:progress` / `test:done` / `test:error` messages on the realtime bus.
3. Clients subscribe to `WS /api/v1/ws?testId=…` for progress and completion.
4. Cancellation flows through `AbortSignal`s threaded from the registry into providers.

### The node subsystem

The node pipeline is the largest service surface, so it is split by concern with one
owner each:

```
services/nodesService.ts   orchestration only: discovery, import, the test row
                           lifecycle, listing, recommendations, favorites
services/nodeTestProbes.ts pure probes (tcp/tls/proxy/icmp) + runProbe dispatch.
                           No repository, no row lifecycle, no events — a probe
                           returns a NodeTestResult and nothing else
services/nodeScoring.ts    pure measurement policy: tenthsOfMs, updateMedian,
                           freshnessOf, statusAfterTest, calculateScore,
                           distributionOf, applyTestOutcome
services/nodeView.ts       the single row → web DTO mapper (labels, enum coercion,
                           runtime sanitizing, geo status)
services/nodeExport.ts     row → export document (uri/plaintext/base64/json/clash/
                           sing-box) plus the per-node share link
services/nodeLinkExport.ts the share-link builder the two above share
```

The rule: **a probe never persists**. `testNode` writes the `running` row, calls
`runProbe`, then writes the terminal state for every type — so a row cannot be left
hanging by a probe that forgot to, and latency is measured only when traffic provably
traversed the node. All aggregate math is a pure function of the previous aggregate plus
the outcome, and the returned patch reproduces unchanged columns explicitly (a TCP test
cannot blank the proxy engine or a proxy measurement).

Filtering, sorting, paging and search are **SQL-owned** (repository) and run over every
stored node; there is deliberately no in-memory duplicate policy, because two authorities
over the same behavior drift apart. The map/detail consumers read the same `NodeWebDTO`
that `nodeView.toWebDTO` produces.

## Platform abstraction

`providers/platform/{types,index,windows,unix}.ts` defines the
`PlatformNetworkController`: ping, traceroute, TCP probes, DNS lookups, interface and
routing-table discovery, MTU probing. Implementations shell out to OS utilities
(`ping`, `tracert`/`traceroute`, `netsh`/`ip`, `route`) using **argv-array spawn only —
never a shell string** — with parsed, typed results. Future native implementations
(e.g. raw sockets, Rust helpers) can replace a platform file without touching services.

## Realtime

`realtime/bus.ts` is an in-process pub/sub keyed by test id; `realtime/wsRoute.ts` upgrades
`/api/v1/ws` and bridges bus messages to authenticated sockets. No polling loops in the UI
for test progress; react-query polling is reserved for dashboard refresh and history.

## Data model (SQLite via Drizzle)

Core tables: `users`, `sessions`, `settings`, `network_tests` (unified history for every
test type with JSON `params`/`summary`), `dns_providers`, `servers`, `server_health`,
`server_metrics`, `vpn_providers`, `vpn_servers`, `vpn_profiles`, `vpn_connections`,
`cloudflare_scans`, `cloudflare_candidates`, `cloudflare_results`, `optimization_runs`,
`optimization_results`, `stability_tests`, `bufferbloat_tests`, `route_tests`,
`route_hops`, `route_comparisons`, `network_events`.

Migrations are generated with Drizzle Kit (`npm run db:generate`) and applied at startup
from `apps/api/drizzle/`.

## Frontend structure

```
apps/web/src
├── app/            router, AppShell (sidebar/topbar), bootstrapping
├── components/ui/  design primitives (Card, Metric, Gauge, Progress, States, …)
├── components/     shared composites (CommandPalette, Toaster, charts)
├── features/       one folder per page domain; pages compose primitives
└── lib/            api client, WS subscribe helper, useBackgroundTest hook, formatting
```

`useBackgroundTest(testId)` centralizes the start/progress/result/error lifecycle so every
long-running page behaves the same way (submit → 202 → live progress → result or error).

Per-node actions are structured the same way, in three layers:

```
features/nodes
├── nodeActionPolicy.ts   pure: outcome → message, export envelope + filename rules
├── useNodeActions.ts     state + request owner: one in-flight action, test / geo /
│                         favorite / copy-link / export, shared by row and detail page
└── NodeEngineActions.tsx rendering + its own mutations (tunnel, promote to engine)
```

The rule: a per-node action's wording and in-flight state have ONE owner
(`useNodeActions`), and the caller supplies only what to re-read (`onChanged`) and
whether a started test must survive an unmount (`onTestStarted`). Configs leave the
app through `lib/transfer.ts` (`copyText`, `downloadText`), the only place that talks
to the clipboard or saves a file. Server-side, `nodesService.shareLink(id)` is the only
rebuilder of a stored node's share link — routes and the engine-profile import both go
through it rather than re-deriving a link from the row and the vault.

VPN surfaces compose in `features/vpn`; `EngineIntakeCard` is the single intake surface
and is mounted from both the Overview tab and the sing-box tab on purpose.

Foldable sections are one system, not per-page state: the pure policy lives in
`lib/disclosure.ts` (storage key, default-vs-stored resolution, pinned sections), the
React binding + toolbar in `components/ui/Disclosure.tsx`, and `Card` opts in with one
`fold={{ id, defaultOpen, pinned, summary }}` prop. A folded card renders no body at
all (no hidden pollers), and its folded header must state something true about what is
inside — real counts or an honest "not checked yet", never a placeholder.

## Dependency rules

- `web` depends only on `@netpulse/shared` models, never on API internals.
- `api` services never import route modules; routes never import repositories directly.
- All cross-package contracts live in `packages/shared`.
- The one sanctioned back-patch: `app.ts` injects cross-service dependencies
  (dns/speed/route/ipInfo) into the diagnostics service after construction to break an
  otherwise-circular composition; this is localized to composition time.
