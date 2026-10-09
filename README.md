# NetPulse — VPN & Network Intelligence Platform

NetPulse is a local-first network operations workspace: a network diagnostic suite, speed
test, DNS laboratory, route analyzer, Cloudflare endpoint scanner, VPN connection center,
and infrastructure/health monitor behind a single Fastify API and a dark, technical React UI.

Everything displayed in the UI comes from **real measurements**. Where a capability is not
available on the host platform (e.g. no WireGuard binary installed), the UI says so instead
of faking a result.

## Feature map

| Area | What it does |
| --- | --- |
| Dashboard | Network health score, live latency chart, IP/ISP/ASN panel, insights derived from real measurements, quick actions |
| Quick Check (`/diagnostics`) | One-click complete diagnostic (interfaces → traceroute, 20 steps) with live progress, plus MTU discovery, CGNAT detection, bufferbloat, connection stability monitor |
| Speed Test | Real download/upload throughput (Cloudflare endpoints), ping/jitter/loss, live streaming progress over WebSocket, history |
| DNS Intelligence Lab | Data-driven resolver catalog (provider groups + variants, custom resolvers with SSRF guard), benchmark over UDP/DoH/DoT, full stats (min/median/avg/p95/jitter/reliability/score), profile-based recommendations with reasons & confidence, persisted history charts, multi-signal DNSSEC deep checks, leak detection, optional scheduled re-benchmarks |
| Gaming | Region latency/reachability to documented publisher endpoints, region ranking (BEST / SECOND / UNSTABLE / NOT RECOMMENDED), explainable gaming score, session monitor with spike/interruption detection, direct-vs-VPN comparison that only claims improvement when measured, optional scheduled region re-tests |
| IP | Public IPv4/IPv6 intelligence: ASN, ISP, org, geo, reverse DNS, privacy indicators |
| Routes | Traceroute (per-hop IP/hostname/latency/loss/ASN), route analysis, IPv4/IPv6 route comparison, history |
| Cloudflare | Configured-CIDR-only endpoint scanner: discovery → TCP → TLS → HTTP validation → speed test → ranking, with favorites and export |
| VPN | Proxy tunnel (xray / sing-box / v2ray) with verified exit IP, TUN mode, nested chaining, kill switch; provider abstraction (WireGuard, OpenVPN, sing-box, Aether) with encrypted secret vault; discovery profiles with honest per-attempt reports; engine manager with one-click updates from official releases |
| Nodes | Node explorer over the full stored database (server-side paging/sort/filter), config intake (paste a vless/vmess/trojan/ss link → test → promote to an engine profile), share-link export, runtime attribution per measurement |
| Servers & Health | VPS/VPN server/diagnostic endpoint inventory, health monitoring daemon, per-server metrics and history |
| Optimizer | Candidate endpoint optimization runs with configurable scoring weights |
| History & Events | Persisted results for every test type plus a filterable event timeline |
| Command palette | `Ctrl/Cmd + K` for keyboard navigation |

## Repository layout

```
apps/api      Fastify API, Drizzle + SQLite, platform/network providers, realtime WS
apps/web      React 19 + Vite + Tailwind 4 UI
packages/shared  Zod schemas, domain models, scoring/statistics engine
```

## Quick start

Requires Node.js >= 22.

```bash
npm install
npm run dev:api     # API on http://127.0.0.1:8787
npm run dev:web     # UI on http://localhost:5173
```

The API generates a daemon token on first start (`.data/daemon-token`) and issues browser
sessions automatically for the configured CORS origins. Data (SQLite database, VPN vault)
lives in `.data/` by default.

## Windows desktop application

NetPulse ships as a **native desktop app** (Tauri v2). The React UI is embedded in the
executable; the Node backend runs as a supervised, token-authenticated loopback sidecar
launched from a bundled runtime — no system Node, npm, Vite, dev server, or browser needed.

```bash
npm run desktop:build           # production exe + NSIS installer
npm run desktop:verify          # artifact integrity checks (DLL sibling, arch, freshness)
npm run desktop:sign            # sign artifacts (SHA-256 + timestamp)
npm run test:release            # distribution lifecycle smoke test (install/upgrade/corrupt-self-heal)
npm run desktop:package         # full release pipeline: build → verify (+enforce signature) → rebuild signed installer → test:release
```

`desktop:package` is the single command for a release candidate: it builds,
verifies artifacts, enforces the Authenticode signature gate, then checks the
distribution lifecycle (fresh install, upgrade/migration, corrupt-DB self-heal,
uninstall/reinstall data survival, signed-exe launch).

Artifacts: `src-tauri/target/release/netpulse-desktop.exe` and
`src-tauri/target/release/bundle/nsis/NetPulse_<version>_x64-setup.exe` (version
derived from `src-tauri/tauri.conf.json`).
Install via the installer (it always ships the WebView2Loader DLL); see [DESKTOP.md](./DESKTOP.md).

The UI↔sidecar link is verified end-to-end on the packaged build — including the browser-layer
rules (CORS preflights, Tauri v2 IPC resolution, API-base prefixing) that HTTP probes cannot see.
The three invariants of that link and the CDP verification procedure are documented in
[DESKTOP.md](./DESKTOP.md) → "The UI ↔ sidecar link".

## Production build (server mode)

```bash
npm run build       # builds the API and the web bundle
npm start -w @netpulse/api   # serves the API and the built UI from one process
```

## Quality gates

```bash
npm run lint        # ESLint over all packages (incl. react-hooks rules)
npm test            # Vitest unit + API integration tests (973 tests across shared/api/web)
npm run audit:ci    # circular-deps + dead-export + unused-dependency gate
npm run test:deploy # boots the INSTALLED backend bundle: auth, real measurements, persistence
npm run build       # typecheck + production bundles
```

### Live VPN proof (Windows, needs an `xray` core)

The gates above never open a tunnel. These do — against the SHIPPED sidecar
bundle, with two hermetic VLESS proof servers, asserting OS state (system proxy,
listener, process, real `curl` exit address) rather than the app's own status
field. They are local release gates, not CI jobs: they need an interactive
Windows desktop and they deliberately mutate the HKCU system proxy (restoring it
in `finally`).

```bash
npm run proof:vpn        # one full lifecycle: import, test, connect, switch, disconnect
npm run proof:vpn:soak   # acceptance population: 50 connect/disconnect cycles, 20 reconnects,
                         # 10 crash-restarts, 10 engine kills, with leak + failure-rate reporting
```

Put `xray.exe` in `%TEMP%\netpulse-vpnproof\cores\` (or pass `--core <path>`).
With no core present the gate exits **2** and says `SKIP` — it is never reported
as a pass. Build the staged sidecar first with `npm run desktop:prepare` if
`src-tauri/backend/` is absent.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — system design, layers, data flow
- [FEATURE_AUDIT.md](./FEATURE_AUDIT.md) — feature-by-feature verification matrix (HTTP + webview layers)
- [FEATURE_GAPS.md](./FEATURE_GAPS.md) — fixed gaps, honest unavailable states, scope limits
- [API.md](./API.md) — full REST/WS surface
- [NETWORKING.md](./NETWORKING.md) — how measurements actually work, platform limits
- [GAMING.md](./GAMING.md) — game catalog rules, ranking and scoring methodology
- [VPN.md](./VPN.md) — VPN providers, profiles, secrets, kill-switch posture
- [SECURITY.md](./SECURITY.md) — threat model and hardening measures
- [DEVELOPMENT.md](./DEVELOPMENT.md) — day-to-day development, testing, conventions
- [DEPLOYMENT.md](./DEPLOYMENT.md) — running NetPulse as a service
- [RELEASING.md](./RELEASING.md) — producing and verifying desktop releases

## Platform limitations (honesty policy)

Some measurements depend on OS support: MTU discovery, CGNAT inference, and VPN control
all degrade gracefully and report "Unavailable in this environment" rather than guessing.
The Settings → Platform tab shows the live capability inventory (Supported / Partial /
Requires permission / Unavailable) — nothing silently falls back.

NetPulse never fabricates network measurements, never labels an IP "clean" without
reputation evidence, and never reports a VPN state that was not observed from the real
provider process. Resolver and game endpoints are data-driven catalogs (extend
`dnsResolverCatalog.ts` / `gameCatalog.ts`); entries record `verified`, `source`, and a
`skipBenchmarkReason` when they cannot be tested directly. Resolver addresses were checked
against official documentation on 2026-09-04 where `verified: true`; everything else is
flagged as unverified rather than silently trusted.

### DNS over TLS caveat

DoT is implemented as a pure-Node TLS DNS client (RFC 7858) and requires outbound TCP 853.
Many networks block it — the benchmark then honestly reports timeouts instead of inventing
latency. DoH needs only port 443.

### Gaming methodology caveat

Game tests measure TCP-connect / TLS-handshake RTT to **documented publisher service
front doors** (login, API, status). These are deliberate, low-volume probes of documented
hostnames only — never scans. In-game UDP routing to a dynamically allocated match server
can differ, so game scores are labeled "service-endpoint latency" everywhere.
