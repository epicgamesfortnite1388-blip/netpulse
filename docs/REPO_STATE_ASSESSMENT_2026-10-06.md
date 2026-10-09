# NetPulse — Whole-Repository State Assessment

**Date:** 2026-10-06 · **Scope:** entire repository at `main` (working tree, uncommitted pass included)
**Method:** read the code, config, DB schema, migrations, tests, build scripts and build artifacts; run the
project's own gates and capture exit statuses directly. **No code was changed by this pass** — apart from this
document, the tree is untouched.

**Labels used for every capability, exactly as the mission requires** (assigned from what the code *does*, never
from a filename, UI label or comment):

| Label | Meaning |
|---|---|
| **Confirmed requirement** | A request route exists, is registered, reaches a service that performs a real operation, persists to a real table, and has at least one test asserting the behaviour. |
| **Inferred requirement** | Code exists for it and is wired, but the end-to-end result depends on something outside this repository (a deployed Worker, an external bot, a machine capability), so it cannot be proven from this tree alone. |
| **Not found** | No code path implements it. |
| **Unknown** | The code exists, but nothing in this tree can establish whether it behaves correctly (e.g. needs a live tunnel, elevation, or a third-party account). |

---

## 0. The 18 questions and their answers

The mission asks for a fact-based assessment. Each claim below carries a pointer to the file/line, config, schema,
build output or command result that proves it. Command results (exit statuses) are in the appendix.

The answers cover QUESTS 1–8 (discovery, foundation, cleanliness, frontend↔backend, core systems, real
measurements, security, failure/recovery).

1. **Q1** — Real architecture, desktop chain, does it work end to end?
2. **Q2** — Cloudflare Worker + Telegram/Abystral chain.
3. **Q3** — Source vs generated/build artifacts; is the shipped artifact current?
4. **Q4** — Build / packaging / installer / updater pipeline.
5. **Q5** — Test inventory and what it actually covers.
6. **Q6** — CI and automatic gates.
7. **Q7** — Database schema / migrations.
8. **Q8** — Auth and secret model.
9. **Q9** — Arbitrary shell/filesystem execution from the UI?
10. **Q10** — Untrusted input handling (imports, URLs, SSRF).
11. **Q11** — VPN connect / switch / disconnect path and how verified it is.
12. **Q12** — Real measurements vs fabricated numbers.
13. **Q13** — Frontend↔backend gaps (dead buttons, fake success, unwired features).
14. **Q14** — Core systems status.
15. **Q15** — Advanced modules status.
16. **Q16** — Dead / duplicate / unfinished / placeholder code.
17. **Q17** — Security & reliability risks (severity, fix, EST).
18. **Q18** — Production readiness, implementation order, EST, honest unknowns.

---

## Part A — Architecture as it exists today

### A1. The desktop chain (verified from code)

```
Windows installer (NSIS, currentUser)
  src-tauri/target/release/bundle/nsis/NetPulse_1.1.1_x64-setup.exe   (build output, 2026-10-03)
        │
        ▼
netpulse-desktop.exe  (Rust, Tauri v2)                     src-tauri/Cargo.toml
  ├─ single-instance lock                                   Cargo.toml:27
  ├─ system tray                                            src-tauri/src/tray.rs
  ├─ native data paths                                      src-tauri/src/paths.rs
  ├─ elevation broker (per-action UAC)                      src-tauri/src/elevation.rs:470
  ├─ logging + redaction                                    src-tauri/src/logging.rs
  ├─ safe mode                                              src-tauri/src/safe_mode.rs:98
  └─ sidecar supervisor                                     src-tauri/src/sidecar.rs:211 spawn_sidecar
        │   spawns:  <appdata>/…/backend/node.exe  backend/netpulse-backend.js
        │            (or PATH `node` in dev)                 src-tauri/src/sidecar.rs:169 resolve_backend
        │   loopback port: fixed 47615, else ephemeral; 0 = feed unused
        │                                                    src-tauri/src/sidecar.rs:84,108
        │   token: 32 CSPRNG bytes, hex, passed on stdin, in-memory only
        │                                                    src-tauri/src/sidecar.rs:113
        ▼
Node sidecar (the API), 127.0.0.1:<port>                    apps/api/src/index.ts:7 buildApp()
  boot stage journal → stderr:
    config:ok → db:ok → routes:ok → schedulers:ok          apps/api/src/app.ts:172,193,842,799
  Fastify + helmet + cors + cookie + rate-limit + ws        apps/api/src/app.ts:688-700
  27 route modules, 170 registered route handlers           apps/api/src/routes/*.ts
  SQLite via better-sqlite3 + drizzle; 41 tables            apps/api/src/db/schema.ts
  drizzle migrations applied at boot, refuses to start unmigrated
                                                            apps/api/src/db/client.ts:164,167
        ▲
        │  loopback HTTP/WS + Bearer token (desktop)
        │  or same-origin cookie session (web mode)
        │
React GUI (Vite SPA, 23 routes)                             apps/web/src/app/router.tsx:30-58
  single transport seam                                     apps/web/src/lib/transport.ts
    desktop: __TAURI_INTERNALS__.invoke → 'bootstrap' → {api_base, ws_base, token}
                                                            lib/transport.ts:43-51, main.rs:78,224
    web:     same-origin /api/v1 + cookie session           lib/transport.ts webTransport()
  Tauri IPC commands exposed (15, no shell/fs/exec):        src-tauri/src/main.rs:224-240
    bootstrap, data_paths, reveal_path, netpulse_safe_mode, reset_app_state, runtime_status,
    read_log_tail, save_diagnostic_report, restart_backend, open_external, admin_status,
    relaunch_as_admin, vpn_elevation_bridge, feed_check, feed_install
  CSP (no inline script, loopback-only connect-src)         src-tauri/tauri.conf.json app.security.csp
  Capabilities: core default + dialog + updater only        src-tauri/capabilities/default.json
```

**End-to-end status:** the chain is built from real parts — installer artifact exists, Rust module set exists,
route registration is exhaustive, migrations are mandatory, transport has a desktop and a web branch, and the
CSP/capabilities deliberately exclude shell/fs. The shallow desktop E2E script (`scripts/e2e-desktop.mjs`)
boots the sidecar and drives ~30 HTTP checks including VPN surface and SSRF guards. **It was not re-run in this
pass**, so "the packaged exe talks to the sidecar on this machine today" is *Inferred*, not *Confirmed*, for the
current tree. What *is* Confirmed is each layer individually: API boots in tests (`boot stage=config:ok /
db:ok / routes:ok` printed by the test harness), all JS/TS suites green, Rust tests exist and were run (appendix).

### A2. The Cloudflare / Telegram chain (verified from code)

```
Desktop UI (Account page)
  apps/web/src/features/account/AccountPage.tsx
  apps/web/src/features/account/TelegramIntegrationCard.tsx
  apps/web/src/features/account/SubscriptionCard.tsx
        │
        ▼
apps/web/src/lib/cloud/client.ts          ← the ONLY cloud client
  every request is POSTed to the LOCAL sidecar: POST /api/v1/cloud/egress
                                            client.ts:10
        │
        ▼
apps/api/src/routes/cloud.ts:58           egress proxy (SSRF-guarded)
  - caller supplies a PATH, never a host: new URL(path, cloudOrigin)   cloud.ts:76-88
  - assertCloudUrl() re-validates (https + cloud origin)               cloud.ts:81
  - header allow-list: content-type, authorization, accept only       cloud.ts:46
  - optional outbound via the user's proxy (SOCKS), classified errors cloud.ts:96-110
        │
        ▼
Cloudflare Worker  netpulse-cloud          cloud/worker/wrangler.toml
  main src/index.ts, nodejs_compat_v2, observability on, D1 binding DB
        │
        ├─ auth:    register / login / refresh / forgot / reset / logout
        │            index.ts:212,253,287,297,329,380
        ├─ account: sessions list/current/all/revoke, password, delete   index.ts:401-465
        ├─ sync:    settings, profiles, favorites, preferences, history,
        │            profile-vaults (ciphertext), devices                 index.ts:465-760
        └─ Telegram/Abystral integration                                  index.ts:630-676
              - bot is authoritative: client never supplies a Telegram id
                                            netpulse-integration.ts:1-25
              - link request/confirm/unlink/status via signed service calls
              - inbound signed event inbox POST /api/internal/netpulse/v1/events[/ack]
              - entitlements mirrored → GET /api/v1/subscriptions        index.ts:670
              - signing secret NETPULSE_SERVICE_SECRET (np-auth.ts)
        │
        ▼
Cloudflare D1 (SQLite) — 3 migrations   cloud/worker/migrations/000{1,2,3}_*.sql
  secrets: AUTH_SECRET, RESET_PEPPER via `wrangler secret put` (not in wrangler.toml)
  optional: RESEND_API_KEY / MAIL_FROM (password mail), TELEGRAM_BOT_BASE_URL
                                            cloud/worker/src/auth.ts:19-27
```

**Status:** the *client* half is fully present and routed through the local egress proxy; the *worker* half is
present with tests (4 files / 78 tests green). Whether the worker is **deployed**, whether the Telegram bot and
`NETPULSE_SERVICE_SECRET` are configured, and whether mail is wired are all **Unknown** from this repo. The
contract document the integration points at (`docs/netpulse-integration.md`) is **Not found** locally — it lives
in the Abystral repository (`netpulse-integration.ts:4`).

### A3. Module inventory (tracked files, LOC)

| Area | Path | Files | LOC (T/S) |
|---|---|---|---|
| API (backend + sidecar) | `apps/api/src` | 124 | 34,521 |
| Web (React SPA) | `apps/web/src` | 113 | 26,604 |
| Shared contracts | `packages/shared/src` | 33 | 4,349 |
| Rust desktop core | `src-tauri/src` | 16 | 5,414 |
| Cloud Worker | `cloud/worker/src` | 8 | 2,596 |
| Build/release scripts | `scripts` | 39 | 6,852 |

Root workspace (`package.json`): `packages/*`, `apps/*`, `cloud/*`; Node ≥ 22.

---

## Part B — The 18 questions, answered with evidence

### Q1 — What is the real architecture, and does the desktop chain work end to end?

Answered in **A1**. Evidence index:

- Sidecar spawn/token/port: `src-tauri/src/sidecar.rs:52,108,113,150,169,211`.
- Typed bootstrap (token never on disk): `src-tauri/src/main.rs:78`, comment `main.rs:17`.
- Webview transport with the Tauri-v2 invoke path spelled out: `apps/web/src/lib/transport.ts:43-51`.
- API boot stage journal: `apps/api/src/app.ts:172,193,842`; entry `apps/api/src/index.ts:7,18,21`.
- No shell/fs IPC: `src-tauri/src/main.rs:23-24` ("deliberately no generic `shell`/`fs` IPC surface") and the
  15-command handler list at `main.rs:224-240`; capabilities grant only core/dialog/updater
  `src-tauri/capabilities/default.json`.

**Verdict:** architecture is real and coherent. **End-to-end on the packaged exe for the current tree = Inferred**
(the E2E script exists — `scripts/e2e-desktop.mjs:84-…` — but was not run in this pass; the newest installer,
`NetPulse_1.1.1_x64-setup.exe`, predates the current source, see Q3/Q4).

### Q2 — What is the Cloudflare/Telegram chain?

Answered in **A2**. Evidence: `apps/web/src/lib/cloud/client.ts:10,323-377`;
`apps/api/src/routes/cloud.ts:46,58,76-110`; `cloud/worker/wrangler.toml`; `cloud/worker/src/index.ts:212-760`;
`cloud/worker/src/netpulse-integration.ts:1-25`; `cloud/worker/src/auth.ts:19-27`.

**Verdict:** client + worker code present and tested; deployment/credentials/external bot = **Unknown**.

### Q3 — Which files are source vs generated, and is the shipped artifact current?

| Kind | Evidence |
|---|---|
| Source | `apps/api/src` (124), `apps/web/src` (113), `packages/shared/src` (33), `src-tauri/src` (16), `cloud/worker/src` (8) |
| Generated / build output (git-ignored) | `.gitignore` ignores `apps/api/dist/`, `apps/web/dist/`, `apps/api/dist-desktop/`, `src-tauri/backend/`, `src-tauri/gen/`, `cloud/worker/worker-configuration.d.ts` |
| Generated types present but untracked/ignored | `cloud/worker/worker-configuration.d.ts` confirmed untracked (`git ls-files --error-unmatch` fails) |
| DB migrations (source) | `apps/api/drizzle/0000…0013_*.sql` (14 files); `cloud/worker/migrations/0001…0003` |

**Freshness (build output vs source mtime):**

```
apps/web/dist/index.html                         2026-10-05 08:05
apps/api/dist/index.js                           2026-10-05 17:49
apps/api/dist-desktop/desktop-index.cjs          2026-10-05 17:49
src-tauri/backend/netpulse-backend.js            2026-10-05 17:49
NetPulse_1.1.1_x64-setup.exe                     2026-10-03 00:10   ← shipped installer
newest source file                               2026-10-06 20:08   (this pass)
```

**Verdict: the shipped installer and the staged backend predate the current source by days of work** (the
endpoint-scrub pass and the VPN lifecycle rework are *not* in `NetPulse_1.1.1_x64-setup.exe`). Any claim of
"production-ready" must be qualified: the *tree* is green, the *artifact* is stale.

### Q4 — Build / packaging / installer / updater pipeline

- Desktop build scripts: `package.json` → `desktop:build` = `release:version && build:desktop-backend && tauri build`;
  `build:desktop-backend` = `build -w @netpulse/api && node scripts/prepare-desktop.mjs`.
- Backend staging: `scripts/prepare-desktop.mjs`; SEA/runtime bundle `scripts/build-backend-sea.mjs`; signing
  `scripts/sign-release.mjs`, `scripts/package-signed.mjs`, `scripts/lib/minisign.mjs`.
- Installer config: `src-tauri/tauri.conf.json` bundle → `targets: ["nsis"]`, `installMode: currentUser`,
  `createUpdaterArtifacts: false`, embedded WebView2 bootstrapper, resources `backend/` + `WebView2Loader.dll`.
- Updater: Tauri updater plugin, endpoint hard-wired to `http://127.0.0.1:47615/api/v1/update-feed/latest.json`
  (`tauri.conf.json plugins.updater.endpoints`), served by `apps/api/src/routes/updateFeed.ts`; the port is pinned
  in Rust (`sidecar.rs:105-108`) and the pair is asserted by `scripts/update-feed.test.mjs` (`npm run test:feed`).
- Verification gates that exist as scripts: `desktop:verify`, `e2e`, `test:release`, `test:signing`, `test:feed`,
  `test:deploy`, `audit:ci`, `audit:tabs`, `audit-ipc.mjs`, `audit-webview.mjs`.
- Artifacts present in the tree: installers `NetPulse_0.2.0 … 1.1.1` plus a `.sig` for **1.1.0 only**;
  **no `.sig` for 1.1.1**.

**Verdict (Inferred→Confirmed where noted):** the pipeline is real and scripted (Confirmed: scripts + config
present). The **current** installer is stale and unsigned (Confirmed by mtimes and `ls …/nsis | grep 1.1.1` →
only the `.exe`). Updater end-to-end install was **not** run in this pass = Unknown.

### Q5 — Test inventory and coverage

Counts captured directly (appendix has exact commands/statuses):

| Suite | Files | Tests | Exit |
|---|---|---|---|
| `apps/api` (vitest) | 92 | 945 | 0 |
| `apps/web` (vitest) | 37 | 344 | 0 |
| `packages/shared` | 6 | 58 | 0 |
| `cloud/worker` | 4 | 78 | 0 |
| Rust (`src-tauri`) | 8 modules, 145 `#[test]` | 143 passed / 0 failed / 2 ignored | 0 |

Notable *coverage mechanisms* (not just counts):

- **Route-wiring meta-test** parses every `api.get/post/…` path in the web source and asserts it exists in the
  backend route table — a dead frontend call fails the suite (`apps/api/test/routeWiring.test.ts:12-17`).
- **Endpoint-leak suite** asserts no response on any node-reading route carries host/port/ipv4/ipv6/sni/credential
  (`apps/api/test/nodeEndpointLeak.test.ts`, 22 tests).
- **Desktop E2E** boots the sidecar and drives ~30 checks incl. SSRF guards and VPN surface
  (`scripts/e2e-desktop.mjs:84-188`).
- **Crash-recovery E2E** SIGKILLs the sidecar, asserts stale "connected" VPN rows reset to `interrupted` and a
  recovery event is recorded (`scripts/e2e-recovery.mjs:83-122`).
- **IPC gate** drives the packaged Tauri command surface over CDP, incl. log redaction and path/URL allow-lists
  (`scripts/audit-ipc.mjs:1-40`).

**Verdict:** strong unit/integration coverage with real honesty tests. **Gaps:** no test performs a real VPN
connect/switch (see Q11); no test proves the packaged webview talks to the sidecar in CI (no CI at all, Q6).

### Q6 — CI and automatic gates

`git ls-files | grep -iE '\.github|\.gitlab|azure-pipelines|circleci|jenkins'` → **empty**.

**Verdict: Not found.** Nothing runs automatically. Every gate in Q5 is manual. This is the single biggest
process risk: a green tree today is green only because someone ran the commands.

### Q7 — Database schema / migrations

- SQLite, better-sqlite3 + drizzle. **41 tables** (`apps/api/src/db/schema.ts`): `users servers dns_providers
  vpn_providers vpn_servers speed_tests dns_tests route_tests endpoint_tests optimization_runs
  optimization_results ip_lookups settings cloudflare_scans bufferbloat_tests route_comparisons vpn_connections
  public_sources source_fetches raw_documents public_nodes node_addresses node_sources node_tests node_health
  scan_jobs test_endpoints node_events` (+ system tables).
- **14 migrations**, `apps/api/drizzle/0000…0013_*.sql`.
- Migrations are applied at boot with a hard failure if the folder can't be located — "refusing to start with an
  unmigrated schema" (`apps/api/src/db/client.ts:164,167`).
- Data dir resolution: `DATA_DIR` or `<cwd>/.data`; `dbPath = <dataDir>/netpulse.db` (`config.ts:105,109`).
- Cloud D1 has its own 3 migrations (`cloud/worker/migrations/`).

**Verdict (Confirmed):** schema + migration discipline is real and enforced at boot.

### Q8 — Auth and secret model

| Surface | Mechanism | Evidence |
|---|---|---|
| Desktop ↔ sidecar | Per-run 32-byte CSPRNG token, hex, delivered on stdin, in-memory, handed to webview only via `bootstrap`; never written to disk | `sidecar.rs:41-51,113`; `main.rs:47-49,78` |
| Sidecar ↔ web mode | Cookie session minted at `POST /api/v1/auth/session`, 12 h TTL, *plus* a `daemon-token` bearer for non-desktop callers | `config.ts:53`, `routes/auth.ts:11-18` |
| CORS | `CORS_ORIGINS` default `localhost:5173,127.0.0.1:5173`; desktop webview origins always merged | `config.ts:45,74` |
| VPN / node secrets | `FileSecretVault`, AES-256-GCM, machine-local key file | `vpn/vpnService.ts:128,156,210` |
| Cloud user secret | Opaque tokens only (access 30 min in sessionStorage, refresh 30 d in localStorage); never a Cloudflare credential | `lib/cloud/sessionStore.ts:4-8,30` |
| Worker secrets | `AUTH_SECRET`, `RESET_PEPPER` via `wrangler secret put`, absent from `wrangler.toml` | `cloud/worker/src/auth.ts:19-20`, `wrangler.toml` header comment |
| Logs | Redaction helper | `apps/api/src/util/redact.ts:27` |

**Verdict (Confirmed):** the secret-handling model is deliberate and documented in code comments that match the
implementation. **Caveat (documented by the authors): `VPN.md` says a packaged build should swap the file vault
for the OS keychain; that swap is Not found.**

### Q9 — Can the UI execute arbitrary shell/filesystem operations?

**Confirmed negative — it cannot.** The Rust IPC surface is 15 narrow commands (`main.rs:224-240`); the module
header states there is deliberately no generic `shell`/`fs` surface (`main.rs:23-24`); capabilities grant no
`shell:*` (`capabilities/default.json`); CSP restricts `connect-src` to self + loopback (`tauri.conf.json`);
`reveal_path` is allow-listed to the data root and `open_external` to a URL allow-list, both exercised by
`scripts/audit-ipc.mjs`. Backend side, no `child_process` with a shell is exposed to the UI: probes/fetch use
guards (Q10).

### Q10 — Untrusted input handling

- **Imported VPN configs** are parsed server-side, secrets extracted to the vault, private keys never in DB/API/logs
  (`VPN.md`; `vpn/vpnService.ts`; regression tests assert no key material in responses — `apps/api/test/vpnLifecycle.test.ts`).
- **SSRF guards** exist and are concentrated in the service layer *and* re-checked at the route: `isPrivateIp`
  appears in ≥10 files under `apps/api/src` (e.g. `routes/nodes.ts` rejects a private `ip` override *before* the
  node lookup; `services/diagnosticsService.ts`, `services/endpointService.ts`, `services/mapService.ts`,
  `services/iranService.ts`, `providers/dns/resolver.ts`).
- **Cloud egress** is a path-only proxy with an explicit header allow-list and origin assertion
  (`routes/cloud.ts:46,76-88`).
- **CIDR expansion** rejects /0–/7 and private bases; samples large ranges rather than expanding them
  (documented in `FEATURE_GAPS.md`; code in `services/nodesService.ts`).
- **Telegram**: the client can never supply a Telegram identity; linking is bot-signed
  (`netpulse-integration.ts:1-25`).

**Verdict (Confirmed):** untrusted input is treated as untrusted across imports, URL fetching, scanners and cloud
egress. Residual gaps are listed in the defect register.

### Q11 — The VPN connect / switch / disconnect path (explicit honesty)

**What the code does today** (reworked this pass):

- One global serialization queue for anything that changes who owns the machine network state:
  `serializeVpnOp` (`apps/api/src/vpn/networkOwnership.ts:42`). Its header explains the bug it fixes: two
  independent state machines (engine profiles vs proxy tunnel) each captured and restored the system proxy, so
  whichever stopped second restored the other's value (`networkOwnership.ts:25-40`).
- Engine routes wrapped: elevated WireGuard connect, connect, reconnect, disconnect
  (`routes/vpn.ts:499,537,564` and the elevated branch `:514-522`). Tunnel routes wrapped: start, stop, reconnect,
  quick-connect (`routes/tunnel.ts:161,237,241,301`). Handover helper `stopTunnelForEngine`
  (`routes/vpn.ts:207`) makes the previous owner fully release before the new mode starts.
- Watchdog: `acknowledgeUserDisconnect()` (`vpn/vpnWatchdog.ts:74`) bumps an epoch
  (`vpnWatchdog.ts:42`) so a *deliberate* disconnect is not resurrected by auto-reconnect — previously it had no
  caller, so every user disconnect could be undone.
- Proxy tunnel generation fences: a failed start must not drop a queued user start; `stopGeneration` and
  `restartGeneration` are separate (`services/proxyTunnel.ts:253,262`), fenced at `:425-432,586,693-702,794-802`.
- Status surfaces withhold the endpoint: `publicStatus` (`routes/vpn.ts:227`) deletes `endpoint` (absent, not null).

**How far this is verified:** route-level and unit tests cover the queue, watchdog epoch, handover and fences —
`apps/api/test/modeHandover.test.ts`, additions to `vpnWatchdog.test.ts` and `proxyTunnel.test.ts`, and the
endpoint-withholding contract in `vpnLifecycle.test.ts`. **All suites are green** (Q5/appendix).

**What is NOT verified — stated plainly:** there is **no test in this repository that performs a real
connect → switch → disconnect against a live tunnel** in the current tree. The desktop E2E script only lists
providers, lists profiles, checks that an unknown profile 404s, that disconnect-when-idle is safe, and that status
has a boolean `connected` (`scripts/e2e-desktop.mjs:92-106`). The live harness that a previous pass relied on
(`scripts/tmp-vpn-live.mjs`, cited in `FEATURE_GAPS.md`) **is not in the repository** (`ls scripts | grep -i vpn`
→ empty). Therefore: **the VPN lifecycle is code-reviewed and unit-tested, but unproven at runtime on this
machine for this revision.** It must not be described as "proven working".

### Q12 — Real measurements vs fabricated numbers

- Probes are real OS operations: ping/traceroute/DNS/TLS/TCP/HTTP live in services under `apps/api/src/services`
  and `providers/`; scan/probe failures are surfaced as typed errors, not zeros.
- Explicit honesty contracts found in code: `nodesService` null-on-never-measured with a comment explaining why
  `lossPct: 0` would be a lie (`routes/nodes.ts` health branch); `proxyCores`/`proxyProbe` return
  `engine_unavailable` "instead of a fake success" (`services/proxyCores.ts:13`, `services/proxyProbe.ts:14`);
  `tunnel.ts:53` "degrades to proxy mode with `tunError` set, never a silent fake"; `iranService.ts:488` comments
  that certificate authorization is reported, reachability is never faked; `nodeActionPolicy.ts:240` "Unverified
  is its own honest outcome" instead of a placeholder.
- Demo mode is explicit and labelled: `DEMO_DATA` → `demoMode` → startup log "ON (data labeled DEMO DATA)"
  (`config.ts:41,113`, `index.ts:20`, `routes/meta.ts:100`).

**Verdict (Confirmed):** production paths do not fabricate measurements; when a value cannot be measured it is
`null`/typed error/`unavailable`. The only "demo" data is opt-in and labelled. **Residual risk:** UI copy is not
evidence; I verified the *code* paths above, not every one of the 23 screens.

### Q13 — Frontend ↔ backend gaps

- **Dead-call protection exists:** `apps/api/test/routeWiring.test.ts` fails the suite if the web calls a path the
  backend does not register. It is green, so there is no known dead frontend→backend call.
- **Retired surfaces fail loudly, not silently:** three routes return **410** with explicit codes —
  `share_link_retired`, `node_export_retired`, `profile_bundle_retired` (asserted in
  `apps/api/test/rawConfigRetirement.test.ts` and the leak suite).
- **UI states failures as failures:** error envelope + typed outcomes (`nodeActionPolicy.ts` "Unverified is its
  own honest outcome"); transport reset on sidecar restart (`lib/transport.ts:74-96`); Recovery Required state
  (`features/health/SystemHealthPage.tsx:269`).
- **Remaining gap:** the route-wiring test only checks *path prefixes*, not response-shape conformance — a route
  that exists but returns a different shape than the UI expects would still pass. That is a test blind spot, not a
  known defect.

### Q14 — Core systems status

| Core system | Label | Evidence |
|---|---|---|
| Application startup + boot journal + safe mode | **Confirmed requirement** | `index.ts:7,18`; `app.ts:172,193,842`; `safe_mode.rs:98`; `useStartupHealth.ts` |
| System information | **Confirmed requirement** | `routes/meta.ts`; `status.rs:145`; `paths.rs:169` |
| Network detection | **Confirmed requirement** | `routes/network.ts`; `networkService` |
| DNS (UDP/DoH/DoT + leak test) | **Confirmed requirement** | `routes/dns.ts` (12 routes); `dnsService`, `dnsResolverCatalog` |
| Ping / latency | **Confirmed requirement** | `routes/ping.ts`; `pingService` |
| Packet loss (via probes) | **Confirmed requirement** | `node_health`, `stability_samples` |
| Traceroute / routing | **Confirmed requirement** | `routes/routes.ts`; `routeService` |
| Database + migrations | **Confirmed requirement** | `db/schema.ts`; `db/client.ts:164,167` |
| VPN lifecycle | **Inferred requirement** — code + tests, no runtime proof | Q11 |
| Process supervision (sidecar) | **Confirmed requirement** | `sidecar.rs:211`; respawn cap and reason surfaced |
| Node management (import/test/health/geo) | **Confirmed requirement** | `routes/nodes.ts` (34 routes) |
| Diagnostics (complete/MTU/CGNAT/bufferbloat) | **Confirmed requirement** | `routes/diagnostics.ts`; `diagnosticsService` |
| History | **Confirmed requirement** | `routes/history.ts`; 14-day retention |
| Monitoring (stability) | **Confirmed requirement** | `routes/stability.ts`; `stabilityService` |

### Q15 — Advanced modules status

| Module | Label | Evidence |
|---|---|---|
| Cloudflare scanner | **Confirmed requirement** | `routes/endpoints.ts` (9 routes); `endpointService`; `cloudflare_scans` table |
| Gaming | **Confirmed requirement** | `routes/gaming.ts` (9 routes); `gamingService`, `gameCatalog` |
| Iran connectivity | **Confirmed requirement** | `routes/iran.ts` (13 routes); `iranService`, `iranClassifier` |
| Live Map | **Confirmed requirement** | `routes/map.ts` (10 routes); `mapService`; `map_observations` |
| Recommendations | **Confirmed requirement** | `dnsRecommendation`, `nodeScoring`, `selectionService` |
| Server/VPS monitoring | **Confirmed requirement** | `routes/servers.ts` (11 routes); `selectionService`; `server_health` |
| Cloud sync (settings/profiles/favorites/vaults) | **Inferred requirement** | `lib/cloud/client.ts`; `routes/cloud.ts:58`; depends on a deployed Worker |
| Telegram link + entitlements | **Inferred requirement** | `index.ts:630-676`; `netpulse-integration.ts`; depends on the external bot/service secret |
| Subscriptions view | **Inferred requirement** | `SubscriptionCard.tsx`; mirrors entitlements from the worker |
| Profile cloud vault (E2C ciphertext) | **Inferred requirement** | `profileCloudVault.ts`, `lib/cloud/profileVaultCrypto.ts`, `vaultKey.ts`; worker `profile-vaults` |

### Q16 — Dead / duplicate / unfinished / placeholder code

- **TODO / FIXME / HACK / XXX in `src`: 0** (grep across api/web/shared/worker/rust `src`). No TODO-driven
  backlog hides in the tree.
- **`console.log` in shipped `src`: 0.** The 127 hits are all in `scripts/` (local audit tooling), which is
  appropriate.
- **`mock` / `fake` / `stub` in production paths: none.** Every hit is either an HTML `placeholder=` attribute or a
  comment explicitly stating a fake is *not* produced (e.g. `proxyCores.ts:13`, `tunnel.ts:53`, `iranService.ts:488`,
  `nodesService.ts:981`). No stub modules or mock data providers were found in `apps/*/src`.
- **`as any` / `: any`:** 3 + 7 hits, concentrated in the protocol parser behind a scoped
  `eslint-disable @typescript-eslint/no-explicit-any` (`services/nodeParsers.ts:849-856`). One `eslint-disable
  prefer-const` (`nodeSourceRegistry.ts:295`).
- **Duplicates:** no duplicate helper implementations found (e.g. a single `redactSecrets` at
  `util/redact.ts:27`); repeated *basenames* are route-vs-service pairs, not duplicates.
- **Generated file present but untracked/ignored:** `cloud/worker/worker-configuration.d.ts` (confirmed untracked).
- **Stray local state in the repo root (untracked, NOT ignored):** `.scratch-pickerdrive/` (contains `secrets`,
  `secrets.key`) and `.scratch-pickerdrive-1791226548/` (contains `daemon-token`, `netpulse.db*`) —
  `git status --porcelain` lists both as `??`, and `.gitignore` matches neither. A real daemon token and a real
  vault key are one `git add .` away from being committed. See D4.
- **Uncommitted work is large:** `git status --porcelain` shows ~46 tracked files modified plus ~39 untracked
  additions/deletions (including a rename `nodeShareLinkApi.test.ts → rawConfigRetirement.test.ts`). The green
  gates describe a **dirty working tree**, not a committed revision. See D11.

### Q17 — Security & reliability risks

See the **Defect register** (Part D) with severity, evidence, fix and EST.

### Q18 — Production readiness, order, EST, unknowns

See **Part C** (readiness verdict), **Part E** (implementation order + EST) and **Part F** (honest unknowns).

---

## Part C — Feature matrix (labelled)

Rows: capability, label, evidence pointer. "Confirmed" means route + service + storage + test are all present.

| # | Capability | Label | Evidence |
|---|---|---|---|
| 1 | Dashboard / network status | Confirmed requirement | `routes/network.ts`; `routes/meta.ts`; `routes/events.ts` |
| 2 | Quick Check (complete diagnostic) | Confirmed requirement | `routes/diagnostics.ts` (4 routes) |
| 3 | Bufferbloat / MTU / CGNAT | Confirmed requirement | `diagnosticsService`; `bufferbloat_tests` table |
| 4 | Speed test | Confirmed requirement | `routes/speed.ts`; `speed_tests` |
| 5 | DNS lab + leak test + custom resolvers | Confirmed requirement | `routes/dns.ts` (12 routes); `dns_providers` |
| 6 | Routing / traceroute + route compare | Confirmed requirement | `routes/routes.ts`; `route_comparisons` |
| 7 | Live Map (measure/observations/targets/sweep) | Confirmed requirement | `routes/map.ts` (10 routes); `map_observations` |
| 8 | Cloudflare scanner | Confirmed requirement | `routes/endpoints.ts` (9 routes); `cloudflare_scans` |
| 9 | Node sources + fetch/parse | Confirmed requirement | `routes/nodes.ts`; `public_sources`, `source_fetches` |
| 10 | Node scanner / batch test | Confirmed requirement | `scan_jobs`; `node_tests` |
| 11 | Node explorer + detail + history + health + geo | Confirmed requirement | `routes/nodes.ts` (34 routes) |
| 12 | Test endpoints (CRUD) | Confirmed requirement | `routes/nodes.ts`; `test_endpoints` |
| 13 | VPN center (providers/profiles/status/connect/disconnect) | **Inferred requirement** | `routes/vpn.ts` (23 routes); runtime connect unproven (Q11) |
| 14 | VPN elevation broker | Confirmed requirement | `elevation.rs:470`; `routes/vpn.ts:606,613` |
| 15 | Proxy tunnel (SOCKS/TUN, nested, gateway) | **Inferred requirement** | `routes/tunnel.ts` (10 routes); live TUN unproven |
| 16 | Kill switch | Confirmed requirement | `services/killSwitch.ts:51,181` |
| 17 | VPN watchdog / auto-reconnect | Confirmed requirement | `vpn/vpnWatchdog.ts:42,74` |
| 18 | VPN self-test (dry run) | Confirmed requirement | `vpnSelfTestService.ts`; `routes/vpn.ts` |
| 19 | Gaming latency | Confirmed requirement | `routes/gaming.ts` (9 routes) |
| 20 | Iran connectivity | Confirmed requirement | `routes/iran.ts` (13 routes) |
| 21 | Server/VPS monitoring | Confirmed requirement | `routes/servers.ts` (11 routes) |
| 22 | Optimizer | Confirmed requirement | `routes/optimizer.ts`; `optimization_runs` |
| 23 | Stability monitoring | Confirmed requirement | `routes/stability.ts`; `stability_samples` |
| 24 | History + events | Confirmed requirement | `routes/history.ts`, `routes/events.ts` |
| 25 | Settings + scheduling | Confirmed requirement | `routes/settings.ts`; `scheduleService` |
| 26 | IP intelligence | Confirmed requirement | `routes/ip.ts`; `ip_lookups` |
| 27 | WebRTC leak check | Confirmed requirement | `routes/webrtc.ts` |
| 28 | System Health / logs / repair | Confirmed requirement | `routes/meta.ts`; `status.rs`; `audit-ipc.mjs` |
| 29 | Local update feed + update history | Confirmed requirement | `routes/updateFeed.ts`, `routes/updateHistory.ts`; `test:feed` |
| 30 | Desktop packaging + NSIS installer | Confirmed requirement | `tauri.conf.json`; 10 installer artifacts on disk |
| 31 | In-app signed auto-update | **Inferred requirement** | plugin + feed wired (`tauri.conf.json`); end-to-end install not run |
| 32 | Cloud account (register/login/sessions/password) | **Inferred requirement** | worker `index.ts:212-465`; needs deployment |
| 33 | Cloud sync (settings/profiles/favorites/preferences/history) | **Inferred requirement** | worker `index.ts:465-760`; `lib/cloud/syncEngine.ts` |
| 34 | Encrypted profile backup to cloud | **Inferred requirement** | `profileCloudVault.ts`; worker `profile-vaults` |
| 35 | Telegram link + entitlement mirror | **Inferred requirement** | `index.ts:630-676`; external bot + `NETPULSE_SERVICE_SECRET` |
| 36 | Subscription view | **Inferred requirement** | `SubscriptionCard.tsx`; `views/subscriptionView.ts` |
| 37 | Cross-repo integration contract document | **Not found** | `netpulse-integration.ts:4` points at `docs/netpulse-integration.md` (Abystral repo) — absent here |
| 38 | Any live VPN connect/switch/disconnect harness | **Not found** | `ls scripts \| grep -i vpn` → empty; `FEATURE_GAPS.md` cites a script that is not present |
| 39 | Continuous integration | **Not found** | no `.github`/`.gitlab`/etc. tracked |
| 40 | OS keychain-backed secret vault | **Not found** | `VPN.md` states the file vault should be swapped; not implemented |
| 41 | Whether the Worker is deployed with its secrets | **Unknown** | `wrangler.toml` has an account id/database id; deployment state is external |
| 42 | Whether Telegram mail (Resend) is configured | **Unknown** | `auth.ts:22-23` optional; external |
| 43 | Live TUN-mode gateway claiming the default route | **Unknown** | `services/tunClaim.ts`, `tunGatewayHandle.ts` exist; needs elevation + real adapter |

**Production-readiness verdict (explicit):** the repository is a **large, honest, well-tested, single-branch
application that is NOT production-ready as-shipped.** Reasons, each evidenced above: (a) the shipped installer
predates days of source changes and is unsigned for the latest version; (b) no CI exists to hold the gates;
(c) the VPN connect/switch/disconnect path — the product's namesake — has no runtime proof in this revision;
(d) the cloud/Telegram half cannot be verified from this tree. Nothing here should be called production-ready
until at least D1–D3 and D14 are closed.

---

## Part D — Defect register

Severity: **Critical** (breaks the product / corrupts data / security), **High**, **Medium**, **Low**.
EST is engineering effort for the fix **including** the verification it implies.

| ID | Severity | Defect | Evidence | Fix | EST |
|---|---|---|---|---|---|
| D1 | High | **No CI.** Nothing runs lint/tsc/tests/route-wiring automatically. | `git ls-files \| grep -iE '\.github\|\.gitlab\|…'` → empty | Add a pipeline running `npm run lint`, 4× `tsc --noEmit`, 4× `vitest run`, `cargo test`, `test:feed`. | 0.5–1 d |
| D2 | High | **Shipped installer is stale and unsigned.** `NetPulse_1.1.1_x64-setup.exe` (2026-10-03) predates current source (2026-10-06); staged backend is 2026-10-05. No `.sig` next to 1.1.1 (only 1.1.0 has one); `createUpdaterArtifacts: false`. | mtimes above; `ls …/nsis \| grep 1.1.1` → exe only; `tauri.conf.json bundle.createUpdaterArtifacts` | Rebuild via `npm run desktop:build`, sign, regenerate the feed, re-run `desktop:verify` + `e2e`. | 0.5–1 d |
| D3 | High | **VPN connect/switch/disconnect has no runtime proof** for this revision. Only route/unit tests + a shallow E2E that never connects. The live harness cited in `FEATURE_GAPS.md` is absent. | `scripts/e2e-desktop.mjs:92-106`; `ls scripts \| grep -i vpn` empty; `FEATURE_GAPS.md` | Reinstate a live harness (WireGuard/OpenVPN/sing-box + a stub core), drive connect→switch→disconnect→crash→recover, record outcomes; add to the release gate. | 2–4 d |
| D4 | Medium | **Real secrets/token/DB in the repo root, untracked and unignored.** | `git status --porcelain` → `?? .scratch-pickerdrive/`, `?? .scratch-pickerdrive-1791226548/`; those dirs contain `secrets`, `secrets.key`, `daemon-token`, `netpulse.db*`; `.gitignore` has no matching rule | Delete the scratch dirs and add `.scratch*/` to `.gitignore`. | 15 min |
| D5 | Medium | **~46 tracked files modified + ~39 untracked additions uncommitted.** The green gates describe a dirty tree; there is no reviewable revision to ship. | `git status --porcelain` | Commit in reviewable slices (scrub boundary, VPN lifecycle, cloud, docs) after review. | 0.5 d |
| D6 | Medium | **VPN file vault should be OS-keychain-backed for a packaged build.** | `VPN.md` ("A packaged build should swap this for the OS keychain") | Implement a keychain-backed `SecretVault` behind the existing interface. | 1–2 d |
| D7 | Medium | **Egress proxy is a powerful capability** exposed to the UI: any path under the cloud origin with a bearer token. Guarded (path-only, header allow-list, origin assert) but broad. | `routes/cloud.ts:46,76-88` | Add per-path method allow-list; reject unknown cloud paths at the edge of `assertCloudUrl`. | 0.5–1 d |
| D8 | Low–Medium | **7 `react-hooks/exhaustive-deps` suppressions** in the web app — stale-closure risk. | `Disclosure.tsx:154,164`; `DnsPage.tsx:222`; `GamingPage.tsx:156`; `GlobeCanvas.tsx:208`; `LiveMapPage.tsx:597,608`; `RoutesPage.tsx:193` | Review each; replace with `useCallback`/refs where the dependency genuinely must not re-run. | 0.5 d |
| D9 | Low | **`any` escape hatch in the protocol parser.** | `services/nodeParsers.ts:849-856` | Type the parse-result union; drop the scoped disable. | 0.5–1 d |
| D10 | Low | **Fixed updater-feed port 47615** — if another process holds it the feed silently 404s (documented as honest, but the updater then can't install). | `sidecar.rs:105-108`; `tauri.conf.json plugins.updater.endpoints` | Keep, but surface "feed unavailable" in System Health and offer a manual installer. | 0.5 d |
| D11 | Low | **`eslint-disable prefer-const`** in the source registry. | `nodeSourceRegistry.ts:295` | Confirm the mutation is real; otherwise remove. | 15 min |
| D12 | Low | **Route-wiring test checks paths, not response shapes** — a shape regression passes the suite. | `apps/api/test/routeWiring.test.ts:12-17` | Add zod/response-shape assertions for the highest-traffic routes. | 1–2 d |
| D13 | Low | **No lazy route loading** — all 23 pages are eagerly imported into the SPA bundle. | `apps/web/src/app/router.tsx:20-58` | `React.lazy` + `Suspense` for heavy pages (map, diagnostics). | 0.5 d |
| D14 | High | **Cloud/Telegram half unverified from this tree** (deployment, secrets, bot, mail). | Q2/A2; `auth.ts:19-27` | Deploy Worker + D1, set secrets, run a link→sync→subscription round-trip against the real bot; document the cross-repo contract in this repo. | 1–2 d (needs accounts) |

Reviewed and **not** counted as defects: `console.log` (0 in shipped src), TODO/FIXME (0), mock/stub modules
(none), duplicate helpers (none found).

---

## Part E — Implementation order (the order I would actually follow)

1. **Commit the current tree in reviewable slices (D5)** — you cannot ship or bisect a dirty working directory.
 *Blocks everything else.*
2. **Remove the scratch secrets and ignore them (D4)** — cheapest real security win.
3. **Stand up CI (D1)** — lock in the gates that are green today so no later change silently breaks them.
4. **Reinstate the live VPN harness and drive the real lifecycle (D3)** — the money path, and the one with the
 least evidence. Fix what it finds; keep it as a release gate.
5. **Rebuild, sign and re-verify the desktop artifact (D2)** — only meaningful once (4) passes, because the
 installer must contain the fixed VPN path.
6. **Verify the cloud/Telegram chain live (D14)** — deploy, set secrets, run link→sync→subscription.
7. **Harden the egress proxy and error surfaces (D7, D10)** — small, high-leverage.
8. **Pay down the coding debt (D8, D9, D11, D13)** — no user-visible behaviour change.
9. **Keychain-backed vault (D6)** — packaging-grade secret storage.
10. **Response-shape test coverage (D12)** — prevents the next regression class.

Estimated total to a defensible "production-ready Windows desktop release": **≈ 8–14 focused engineering days**,
of which **3–6** are the VPN runtime proof + artifact rebuild (steps 4–5), and **1–2** depend on external
accounts/deployments (step 6).

---

## Part F — Honest unknowns (what this pass could not verify, and what it would take)

1. **A real VPN connect/switch/disconnect on this machine.** Unit/route tests are green; the live path is not
   proven. *To verify:* a Windows box with WireGuard/OpenVPN (and xray/sing-box) installed, an elevated session,
   and a harness that connects, switches mode and profile, drops the tunnel, and disconnects — recording the OS
   interface/route state, not the app's own status field. (`FEATURE_GAPS.md` says this was done once with
   `scripts/tmp-vpn-live.mjs`; that script is not in the repository, so it cannot be re-run as-is.)
2. **The packaged exe talking to the sidecar for the current revision.** *To verify:* rebuild, then run
   `scripts/e2e-desktop.mjs` and `scripts/audit-ipc.mjs` against the fresh installer and inspect the webview
   requests over CDP.
3. **Whether the Cloudflare Worker is deployed and configured.** `wrangler.toml` holds an account and D1 id, but
   deployment state, `AUTH_SECRET`/`RESET_PEPPER`, `RESEND_API_KEY`, and `NETPULSE_SERVICE_SECRET` are external.
   *To verify:* `wrangler deployments list` / `wrangler secret list`, then a live register→login→sync round-trip.
4. **Whether the Telegram bot exists, is reachable, and signs correctly.** The contract document is in the
   Abystral repository, not here. *To verify:* run the bot locally against the worker and complete a link flow.
5. **Whether the updater installs end-to-end.** Feed wiring and the port pair are asserted, but no install was
   performed. *To verify:* publish a signed feed entry and update a real 1.1.x install on Windows.
6. **TUN-mode gateway claiming the default route.** `tunClaim.ts`/`tunGatewayHandle.ts` exist; enforcing it needs
   elevation and a real adapter. *To verify:* elevated Windows run with the kill switch armed, then a forced route
   change and a re-arm.
7. **Every one of the 23 screens rendering correctly.** This pass verified code paths and the honesty contracts in
   them, not pixels. *To verify:* the existing CDP layout/contrast/webview gates against a fresh build.
8. **Long-run stability** (multi-hour monitoring, 30k-node DB, large scans). *To verify:* `npm run stress:nodes`
   plus a soak run; I did not run these.

---

## Appendix — Commands run in this pass, with exit statuses

Captured directly (`cmd > log; echo $?`), not inferred from output text:

| Command | Result | Exit |
|---|---|---|
| `npm run lint` | clean | 0 |
| `apps/api` `tsc --noEmit` | clean | 0 |
| `apps/web` `tsc --noEmit` | clean | 0 |
| `packages/shared` `tsc --noEmit` | clean | 0 |
| `cloud/worker` `tsc --noEmit` | clean | 0 |
| `apps/api` `vitest run` | 92 files / 945 tests passed | 0 |
| `apps/web` `vitest run` | 37 files / 344 tests passed | 0 |
| `packages/shared` `vitest run` | 6 files / 58 tests passed | 0 |
| `cloud/worker` `vitest run` | 4 files / 78 tests passed | 0 |
| `apps/api` `vitest run test/nodeEndpointLeak.test.ts` | 22/22 passed | 0 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 143 passed / 0 failed / 2 ignored | 0 |

**Note on Rust:** the full suite ran clean in **0.78 s** after compilation: *143 passed; 0 failed; 2 ignored*, exit 0.
The **145 `#[test]` functions** live in `sidecar.rs` (25), `diagnostics/tests.rs` (25), `os_open/tests.rs` (34),
`paths.rs` (15), `status.rs` (15), `logging.rs` (13), `elevation.rs` (9), `safe_mode.rs` (9). The 2 ignored are
the `reveal_path` reparse-point cases (need Developer Mode/elevation).

**Read-only confirmation:** apart from this file, no repository file was created, edited or deleted by this pass;
`git status` is unchanged from the state described in D5.
