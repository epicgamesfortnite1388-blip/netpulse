# API Reference

Base URL: `http://127.0.0.1:8787`. All paths below are prefixed `/api/v1`.
Authentication is enforced for everything except `/meta` and `/auth/session`
(see [SECURITY.md](./SECURITY.md)).

## Conventions

**Long-running tests.** `POST` endpoints that start work return `{ testId }` immediately.
Progress streams over the WebSocket as `test:progress` messages and the terminal state
arrives as `test:done` (with `result`) or `test:error`. Every test is cancellable where
the underlying operation supports abort.

**Errors.** Structured JSON `{ error, code?, hint? }` with accurate HTTP status codes
(400 validation, 401 auth, 404 missing, 409 conflict, 429 rate-limited).

## Meta & auth

| Method | Path | Description |
| --- | --- | --- |
| GET | `/meta` | Build info, demo-mode flag (public) |
| GET | `/meta/capabilities` | Platform capability inventory (`ping`, `tcpProbe`, `dnsTls`, …) with status `supported` \| `partial` \| `permission` \| `unavailable` |
| POST | `/auth/session` | Exchange/refresh a session (public) |

## Network & IP

| Method | Path | Description |
| --- | --- | --- |
| GET | `/network/status` | Online state, TCP latency, IPv6 availability, health score + components |
| GET | `/ip?family=4\|6&force=true\|false` | Public IP intelligence (ASN, ISP, org, geo, reverse DNS, privacy indicators) |

## Tests

| Method | Path | Description |
| --- | --- | --- |
| POST | `/ping-test` | ICMP ping run: `{ target, count }` → latency/jitter/loss |
| POST | `/speed/run` | Speed test (Cloudflare provider): live throughput samples over WS; GET `/speed/history` for persisted results |
| GET | `/speed/history` | Recent speed tests |
| POST | `/dns/test` | DNS benchmark over catalog providers + custom resolvers (UDP/TCP/DoT/DoH); `{ providers?, probes?, transport?, timeoutMs? }` → 202 `{ testId }`, per-provider stats (min/avg/median/p95/p99, jitter, timeout rate, reliability, score, dnssec) over WS |
| GET | `/dns/providers` | Full resolver catalog grouped by provider (variants: standard/security/family/privacy) |
| GET | `/dns/providers/:providerId` | Single provider group |
| GET | `/dns/providers/:resolverId/resolver` | Single resolver spec |
| POST | `/dns/providers/:id/dnssec` | DNSSEC validation probe (UDP) for one resolver |
| POST | `/dns/providers/:id/dnssec-deep` | Multi-signal DNSSEC diagnostic (AD-flag behavior, broken-zone probe) → `supported` \| `validating` \| `failed` \| `unknown` |
| GET | `/dns/history?range=today\|24h\|7d\|30d&providerId=&transport=` | Persisted benchmark time series |
| GET | `/dns/recommend?profile=fastest\|reliable\|privacy\|security\|family\|gaming\|balanced&transport=` | Profile-based resolver recommendation with per-component scores and confidence (from latest benchmark batch; low sample counts yield low confidence) |
| POST | `/dns/providers/custom` | Add a custom resolver (public addresses only; private/loopback/link-local/metadata rejected). GET `/dns/providers/custom` lists, DELETE `/dns/providers/custom/:id` removes |
| POST | `/dns/leak-test` | DNS leak detection (resolver IP/org/ASN vs VPN-expected resolver, honest classification) |
| POST | `/route-test` | Traceroute: `{ target, family? }` → hops with IP/hostname/latency/loss/ASN |
| POST | `/route-compare` | IPv4 vs IPv6 route comparison with scores |
| POST | `/diagnostics/complete` | 20-step full diagnostic with live progress |
| POST | `/diagnostics/bufferbloat` | Loaded/unloaded latency under download+upload load |
| POST | `/diagnostics/mtu` | Path MTU discovery (platform-permitting) |
| POST | `/diagnostics/cgnat` | CGNAT likelihood from real observations |
| POST | `/gaming/test` | Region latency/reachability for a game `{ gameId }` → 202 `{ testId }`; probes documented publisher service endpoints (TCP-connect / TLS-handshake RTT, never scans), streams progress over WS |
| GET | `/gaming/games` · GET `/gaming/games/:id` | Data-driven game catalog (games + platform ecosystems with documented endpoints, `verified` + `source` per endpoint) |
| POST | `/gaming/session` | Start session monitor `{ gameId, customTarget?, port?, intervalMs? }` → continuous low-impact probes with spike/event detection; POST `/gaming/session/:id/stop` stops |
| GET | `/gaming/sessions` · GET `/gaming/session/:id` | Active sessions and per-session detail (samples + events) |
| POST | `/gaming/compare` | Capture direct-vs-VPN latency sample `{ gameId, mode: 'direct'\|'vpn', serverName? }`; GET `/gaming/compare?gameId=` returns the accumulated comparison |
| POST | `/stability/start` · `/stop` | Continuous stability sampling |
| GET | `/stability/status` · `/stability/samples` | Sampler state and samples |
| POST | `/optimizer/run` | Optimization run over candidate endpoints |

## Cloudflare scanner

| Method | Path | Description |
| --- | --- | --- |
| POST | `/cloudflare/scan` | Start discovery over configured CIDRs/ports (allowlisted, capped concurrency). Each live candidate is probed TCP → TLS → `GET /cdn-cgi/trace` (SNI rotation) so every result records the Cloudflare colo/region it answered from |
| GET | `/cloudflare/scans?limit=` | Recent scans |
| GET | `/cloudflare/scans/:id` | Scan detail with candidates/results (colo, loc, validation verdicts) |
| POST | `/cloudflare/scans/:id/cancel` | Cancel a running scan |
| POST | `/cloudflare/scans/:id/validate` | SenPaiScanner-style post-stop validation of the shortlist: multi-try latency (loss/jitter), DPI idle-hold stability, and a real `__down` download per edge → per-candidate `clean` verdict, streamed over WS (`scan:validate:*`) |
| POST | `/cloudflare/scans/:id/validate/cancel` | Cancel an in-flight validation |
| POST | `/cloudflare/candidates/:id/favorite` | Toggle favorite |
| GET | `/cloudflare/edge` | The Cloudflare datacenter this machine's traffic exits from (`colo` + human label) |
| POST | `/endpoint-test` | Validate a single configured endpoint (TCP/TLS/HTTP) |

## Live Map

| Method | Path | Description |
| --- | --- | --- |
| GET | `/map/targets` | Generic target catalog built from DNS resolvers, documented game endpoints, measured Cloudflare edges, VPN profiles and user servers |
| POST | `/map/measure` | Measure a target (`{ targetId }`) or a bounded custom target (`{ custom: { host, protocol, port } }`): TCP/TLS/HTTPS/DNS probes (median of samples), traceroute with ASN enrichment, and confidence-aware geography; streams `map:progress` / `map:observation` / `map:error` on WS topic `map` |
| GET | `/map/observations?targetId=&limit=` | Persisted observations (route history / time machine / playback) |
| GET | `/map/observations/:id` | Single observation with full hops + measurements |
| POST | `/map/observations/clear` | Delete all map history (privacy) |
| GET | `/map/local` | Source node: public IP, GeoIP position, VPN state |
| GET | `/map/compare?targetId=` | Diff of the last two observations (route/ASN/VPN changes) + direct-vs-VPN verdict when both paths were measured |
| GET | `/map/connections` | Live local connection tracking (Windows netstat, best-effort): established TCP **and UDP** sockets with owning process name (tasklist), remote ASN/org enrichment, and the latest measured RTT to each remote when a sweep has probed it — metadata only, never payloads |
| POST | `/map/sweep` | Batched server-side ping sweep over game/VPN/Cloudflare targets (bounded concurrency 4, ICMP-first with 4 samples, TCP-connect fallback when ICMP is filtered): rows ranked fastest-first, streamed on WS topic `map` as `map:sweep`; only one sweep at a time (429 `sweep_busy`) |
| GET | `/map/sweep/:id` | Poll a sweep's result (`completed`, per-row `method` icmp/tcp, jitter, loss, server-side country) |

Geography is confidence-aware: known endpoints (Cloudflare colo from `cfProbe`) are high-confidence; every other hop is a clearly labeled country-level GeoIP estimate; unknown hops are unplaced.

## Servers & health

| Method | Path | Description |
| --- | --- | --- |
| GET | `/servers` · POST `/servers` | Inventory CRUD (`GET/POST/PATCH/DELETE /servers/:id`) |
| GET | `/servers/:id/health` | Health history |
| POST | `/servers/:id/check` | On-demand health check |
| POST | `/health/start` · `/health/stop` | Continuous health monitoring daemon |
| GET | `/health/status` · `/health/:serverId` | Monitor state / per-server health |

## VPN

| Method | Path | Description |
| --- | --- | --- |
| GET | `/vpn/providers` | Installed/available providers and capabilities |
| GET | `/vpn/profiles` · POST `/vpn/profiles` | Import and list profiles (secrets never returned) |
| GET | `/vpn/status` | Real observed VPN state |
| POST | `/vpn/connect` · `/vpn/disconnect` | Drive the provider binary |
| GET | `/vpn/connections` | Connection history |

## Data

| Method | Path | Description |
| --- | --- | --- |
| GET | `/history?type=&limit=&before=` | Unified test history |
| GET | `/history/:id` | Single test detail |
| GET | `/events?limit=` | Event timeline |
| GET/PUT | `/settings` | Application settings (includes `scheduling` block) |
| GET | `/settings/schedule` | Live recurring-benchmark state (last/next run, failures) |
| POST | `/settings/schedule/run` | Trigger one run now: `{ "kind": "dns" \| "gaming" \| "vpn" }` |
| GET | `/vpn/selftest` | Latest scheduled VPN dry-run self-test result + its schedule state |
| POST | `/vpn/selftest/run` | Trigger an immediate VPN dry-run self-check (no elevation, never touches tunnel state) |
| GET | `/vpn/elevation/pending?opId=&nonce=` | Rust elevation bridge: fetch ONE pending WireGuard install descriptor (Bearer + nonce gated) |
| POST | `/vpn/elevation/result?opId=&nonce=` | Rust elevation bridge: report the UAC launch outcome (Bearer + nonce gated) |
| GET | `/nodes/stats` | Node database totals + protocol/country/transport breakdowns |
| GET | `/nodes/engines` | Local proxy-core availability (xray / sing-box): installed, path, protocols, which engine proxy tests will use. Cores are found on `PATH` or dropped into `<dataDir>/cores/` (or `NETPULSE_CORES_DIR`) |
| POST | `/cloudflare/scan` | Start a Cloudflare endpoint scan. CIDRs /8–/32 accepted; large published ranges (e.g. the default `104.16.0.0/13`, `172.64.0.0/13`) are sampled on an even stride up to `maxCandidates`; private/reserved bases rejected |
| GET | `/sources` | Public node sources (built-ins seeded into the DB at boot; DB is authoritative) |
| POST | `/sources` | Add a custom source `{ name, urls[] }` (https public hosts only) |
| PATCH | `/sources/:id` | Enable/disable a source |
| DELETE | `/sources/:id` | Remove a custom source |
| POST | `/sources/:id/fetch` | Fetch + parse + import a source now. Imports are parse+store only (no DNS in the hot path — 8k configs ≈ 8 s); hosts resolve at test time. Repeat fetches of unchanged content short-circuit via content hash. |

## WebSocket

`WS /api/v1/ws?testId=<id>` — authenticated. Messages:

```json
{ "type": "test:progress", "testId": "…", "task": "download", "pct": 42 }
{ "type": "test:progress", "testId": "…", "task": "download", "pct": 42, "mbps": 83.1 }
{ "type": "test:done", "testId": "…", "result": { … } }
{ "type": "test:error", "testId": "…", "error": "…" }
```

## Settings

`PUT /settings` accepts a partial patch validated by the shared `SettingsSchema`
(opt-in weights for server scoring, monitoring intervals, and similar). Unknown keys are
rejected; values never include secrets.

`settings.scheduling` configures **recurring benchmarks**: `dnsEnabled`/`dnsIntervalMin`
run the DNS Lab benchmark, `gamingEnabled`/`gamingIntervalMin`/`gamingGameId` run a
Gaming region test, and `vpnSelfTestEnabled`/`vpnSelfTestIntervalMin` run the **VPN
tunnel self-test** — a scheduled dry-run that verifies engine availability, stored key
material integrity and profile endpoint reachability without elevation and without ever
creating or modifying a tunnel. The scheduler lives in
`services/scheduleService.ts`: runs never overlap (a slow run is skipped, never stacked),
failures are recorded and the next run still scheduled, and every state change is pushed
on the `schedule` WebSocket topic (replayed to late subscribers). `GET /settings/schedule`
returns `{ dns, gaming, vpn }` with `enabled`, `running`, `lastRunAt`, `lastResult`,
`lastError`, `nextRunAt`; `POST /settings/schedule/run` kicks off an immediate run.

### VPN tunnel self-test

`GET /vpn/selftest` returns `{ last, running, schedule, safeMode }` where `last` is the
most recent `VpnSelfTestResult` (`state: ok | unavailable | error`, human-readable
`detail`, per-engine binary presence, `profilesChecked`, `endpointsReachable`). The
self-test is strictly a **dry run**: it never spawns an engine, never requires elevation,
and never changes tunnel state. `ok` = all verifiable checks passed (including a live
tunnel, which skips the endpoint probe); `unavailable` = environmental (no engine
installed or no profiles imported — the app works, tunnels cannot); `error` = a stored
profile's key material is missing/unreadable and will fail on connect, or the check
itself failed. Endpoint probes resolve through the SSRF guard and probe resolved IPs
only; secrets are validated in-process and never logged or serialized. Every run is
published on the `vpn-selftest` WebSocket topic (`vpn-selftest:running` / `vpn-selftest:done`)
and the System Health page shows the live result with a Run-now action.
