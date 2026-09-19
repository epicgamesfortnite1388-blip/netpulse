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
