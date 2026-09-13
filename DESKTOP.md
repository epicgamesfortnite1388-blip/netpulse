# NetPulse Desktop Architecture

NetPulse runs as a **native desktop application** built on Tauri v2. The React
frontend is unchanged; the OS-sensitive layer lives in Rust; the proven
Node/TypeScript backend runs as a **supervised, token-authenticated loopback
sidecar** — no public localhost service, no dev server, no Node required on
end-user machines (portable Node runtime is bundled; see below).

```text
┌──────────────────────────────────────────────┐
│                DESKTOP UI                    │
│          React + TypeScript + Vite           │
│   (transport.ts — no localhost assumptions)  │
└─────────────────────┬────────────────────────┘
                      │
          Typed Tauri IPC (bootstrap, data_paths)
                      │
┌─────────────────────▼────────────────────────┐
│               TAURI CORE (Rust)              │
│  src-tauri/src/main.rs                       │
│    - app lifecycle, single instance          │
│    - tray (open/quit), close-to-tray         │
│    - native data/log dirs (OS app-data)      │
│  src-tauri/src/sidecar.rs                    │
│    - ephemeral CSPRNG daemon token           │
│    - process spawn + watchdog restart        │
│    - stdin lifecycle channel                 │
└─────────────────────┬────────────────────────┘
                      │ loopback HTTP/WS
                      │ Bearer <ephemeral token>
┌─────────────────────▼────────────────────────┐
│        BACKEND SIDECAR (Node/TypeScript)     │
│  apps/api/src/desktop-index.ts               │
│    - full diagnostics/VPN/nodes engine       │
│    - SQLite (WAL) in OS app-data dir         │
│    - binds 127.0.0.1:<ephemeral> only        │
│    - stdin EOF ⇒ graceful shutdown           │
└──────────────────────────────────────────────┘
```

## Why the backend is a sidecar (not a rewrite)

The existing Node backend passed a full audit: measurement invariants,
probe semantics, migration integrity, adversarial input handling. Rewriting it
in Rust would risk every one of those guarantees for no user-visible gain.
Rust owns what Rust is genuinely needed for (process lifecycle, secrets,
native paths, tray, windowing); TypeScript keeps the tested business logic.
This is migration path **B (sidecar)** from the conversion brief, with the
seam deliberately narrow so individual services can move to Rust later
without touching the UI.

## Security model

| Surface | Control |
|---|---|
| Sidecar bind | `127.0.0.1` only, ephemeral port chosen by the supervisor |
| Auth | Ephemeral 32-byte CSPRNG token; Bearer header on every request |
| Token storage | **Memory only** — generated in Rust, passed via stdin, handed to the webview through the typed `bootstrap` command; never written to disk |
| Orphan protection | stdin is the lifecycle channel: supervisor death ⇒ OS closes pipe ⇒ sidecar sees EOF and shuts down |
| Token on disk (web mode only) | Legacy `daemon-token` file path remains for browser dev mode; unused in desktop |
| Webview capabilities | Minimal set (see `src-tauri/capabilities/`): dialogs + window controls. **No shell, no fs, no http plugins** |
| Custom IPC | Exactly three commands: `bootstrap`, `data_paths`, `reveal_path` (absolute-path guard). No generic `executeShell` |
| CSP | `default-src 'self'`; scripts self only; connect-src limited to self/ipc/loopback sidecar |
| SPA | Served from packaged assets by the webview; the sidecar's static file serving is only used in web mode |
| Network exposure | No LAN-facing listener in any mode |

## Data directories

| Content | Location (per OS) |
|---|---|
| SQLite DB, WAL | `%APPDATA%/NetPulse` (Windows), `~/Library/Application Support/NetPulse` (macOS), `~/.local/share/NetPulse` (Linux) |
| Logs | OS log dir via `app_log_dir()`; stderr is mirrored to the UI event `sidecar:log` |
| Migrations | Staged by `scripts/prepare-desktop.mjs` into the bundle; located via `NETPULSE_MIGRATIONS_DIR` |
| Proxy cores (drop-in) | `<dataDir>/cores/` — place `xray.exe` / `sing-box.exe` here and node proxy tests pick them up automatically; `NETPULSE_CORES_DIR` overrides the folder. Also found if on `PATH`.

First launch creates and migrates the database automatically; the existing
drizzle migration set (0000–0012) is unchanged.

## Build

```bash
# 1. Verify the whole desktop pipeline on a Node-only machine
npm run desktop:verify

# 2. Full desktop build (requires Rust toolchain + platform prerequisites)
npm run desktop:build        # = build backend, stage resources, tauri build

# Development (hot reload UI + Rust)
npm run desktop:dev

# Regenerate icons after changing the mark
node scripts/generate-icons.mjs
```

`desktop:verify` validates everything that can be validated without Rust:
backend bundle, staged resources (including the native better-sqlite3 binary
and migrations), a real sidecar boot with token auth (unauthenticated ⇒ 401,
bearer ⇒ 200, stdin-close ⇒ clean exit), and `tauri.conf.json` sanity
(icons, resources, CSP, single window).

### End-to-end test scripts

```bash
npm run e2e                 # 28 functional checks against the packaged backend
                            # (auth, meta, DNS, ping, traceroute, speed, nodes,
                            # Iran, gaming, Cloudflare, SSRF/validation guards)
node scripts/e2e-recovery.mjs   # crash/restart: SIGKILL mid-session, then verify
                            # stale VPN rows repaired, recovery events recorded,
                            # settings persisted, DB intact
```

Both run against the **staged desktop bundle** in `src-tauri/backend`, not the
dev server, so they exercise the same code users will run.

### Portable Node runtime (no user Node install)

`npm run desktop:build` stages a private Node runtime (`node.exe` /
`bin/node`, MIT-licensed) beside the backend via
`scripts/build-backend-sea.mjs`. The Rust supervisor prefers it, so end users
need **no Node.js install**. (A Node single-executable launcher was evaluated
and rejected: the SEA embedder `require` resolves only builtins, and
Fastify/ajv generate code at runtime that requires `ajv/dist/runtime/*` from a
real node_modules tree — impossible inside a single exe.)

## Startup reliability & recovery

Startup is GUI-first and fail-soft. Every boot writes structured stage lines
(`config:ok`, `db:ok`, `schedulers:ok`/`skipped`, `routes:ok`, `sidecar-ready`)
to `%APPDATA%\app.netpulse.desktop\logs\netpulse.log` (rotating; Rust panics
land in the same file). A failure in any optional subsystem — tray, sidecar,
schedulers — is logged and the window still appears.

| Recovery path | Mechanism |
|---|---|
| Sidecar crash | Rust watchdog respawns with bounded backoff; GUI shows "Backend offline" |
| Corrupt database | `quick_check` gate quarantines to `netpulse.db.corrupt-<ts>` and boots a fresh DB |
| Corrupt settings | zod-validated merge falls back to defaults, never crashes |
| Broken networking config | **Safe Mode** — launch with `--safe-mode` (or the Safe Mode shortcut): network controller is replaced by a fail-fast stub, schedulers stay off, Settings + diagnostics remain usable |
| Wedged state of any kind | **Reset App State** (Settings → Platform → Recovery, also offered by the global error boundary): moves every data file into `backup-<timestamp>/` (nothing deleted), restarts the backend on a fresh migrated DB |
| Render crash | Global `AppErrorBoundary` replaces React Router's dev error screen with retry/reload/reset actions |
| Second launch | single-instance plugin focuses the existing window |
| Stale sidecar processes | stdin-EOF handshake: a backend whose supervisor died exits by itself |

## Runtime behavior

- **Single instance**: second launch focuses the existing window
  (tauri-plugin-single-instance).
- **Close-to-tray**: closing the window hides it; Quit lives in the tray menu.
- **Watchdog**: if the sidecar exits unexpectedly it is restarted (max 5
  attempts, then `sidecar:failed` event to the UI).
- **Startup order**: transport is resolved before the first React render
  (`main.tsx`), so no component ever targets an unknown API base.
- **Tab-switch state persistence**: page-level UI state (explorer filters,
  source/CF forms, DNS selection, sort keys, pagination) is held in
  sessionStorage-backed `usePersistentState`, so switching tabs and returning
  no longer resets it. Long-running background tests (speed, diagnostics,
  gaming, DNS benchmark, optimizer, server recommendation) persist their
  `testId` and re-attach on remount via `useBackgroundTest` (WS progress +
  persisted-record polling). VPN import config text is deliberately NOT
  persisted — it routinely contains private keys, and sessionStorage is
  written to the webview profile on disk. Regression:
  `npm run audit:tabs` (against the installed exe with CDP enabled).

## The UI ↔ sidecar link (desktop transport contract)

The packaged app has **three origin players**: the UI at `http(s)://tauri.localhost`, the sidecar at
`http://127.0.0.1:<ephemeral>`, and dev mode's Vite server at `localhost:5173`. The link between UI
and sidecar is governed by three invariants. Each was violated at some point, producing
"Backend unreachable" with a perfectly healthy backend — and each violation was invisible to HTTP
probes and unit tests, because only the webview enforces browser rules.

| Invariant | Contract | Where enforced |
|---|---|---|
| **IPC resolution** | Tauri v2 exposes `invoke` at `__TAURI__.core.invoke` (and `__TAURI_INTERNALS__.invoke`); it does **not** exist at `__TAURI__.invoke`. All code must resolve via `tauriInvoke()` in `apps/web/src/lib/transport.ts` — never probe top-level globals directly, or the app silently falls back to same-origin web mode and requests never reach the sidecar. | `transport.ts` (`resolveInvokeFn`), all call sites converted |
| **CORS origins** | The sidecar's allowlist must contain `http(s)://tauri.localhost` (merged by default via `DESKTOP_WEBVIEW_ORIGINS` in `apps/api/src/config.ts`) because every authed request carries an `Authorization` header and therefore preflights. Dev origins stay allowed for `tauri dev`. Unknown origins get no CORS headers (browser blocks). | `config.ts` + `apps/api/test/desktopCors.test.ts` |
| **URL prefixes** | `bootstrap` returns `api_base` **including** `/api/v1` (because `api.ts` appends bare resource paths) but `ws_base` as the **bare** origin (because `ws.ts` hardcodes `/api/v1/ws`). Asymmetric on purpose — documented at both ends (`main.rs`, `transport.ts`). | `src-tauri/src/main.rs` |

### Webview-layer E2E verification (the methodology that caught all three)

HTTP probes (curl/Node) bypass browser enforcement; dev mode bypasses packaging. To verify the real
link on the **installed** exe:

```powershell
# 1. launch the installed app with remote debugging
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
Start-Process 'C:\path\to\installed\netpulse-desktop.exe'

# 2. attach CDP (ws package), evaluate in the live page:
#    - __TAURI_INTERNALS__.invoke('bootstrap')  -> api_base/ws_base/token
#    - fetch(api_base + '/meta/health', authed) -> must be 200, not 'Failed to fetch'
#    - performance.getEntriesByType('resource') -> app's own requests, all 200
#    - document.body.innerText                  -> no 'Backend unreachable' banner
```

OS-level cross-check: `netstat -ano | findstr :<port>` must show ESTABLISHED sockets owned by the
webview process tree. **Zero sockets + healthy sidecar = transport-layer bug** (bug #2 class).

Regression coverage: `desktopCors.test.ts` locks invariant 2 at the HTTP layer; invariants 1/3 are
verified by the CDP procedure above against every packaged build (run before each release).

### Automated webview audits (run against the installed exe)

Two reusable CDP scripts drive the live installed app; launch it with remote debugging first
(the snippet above), then:

| Script | What it does | Catches |
|---|---|---|
| `node scripts/audit-webview.mjs` | Navigates all 19 routes, clicks every visible button/tab/checkbox (auto-cancels `confirm()`, skips destructive actions), reports per-page exceptions/console errors/error boundaries | Broken controls, dead buttons, render crashes, console errors |
| `node scripts/audit-webview-runs.mjs` | For each async-test page (Optimizer, Speed Test, Diagnostics, Routes): clicks **Run**, waits for completion, then checks the final render | **Late-render crashes** — payload-shape drift between WS/DB delivery and the HTTP contract (e.g. `Object.entries(undefined)`) — invisible to fast crawls and unit tests |

The run-audit exists because the completed-payload render path is only reachable after a test
finishes; a click-and-move-on crawl misses it. Both exit non-zero on findings.

## Environment variables (set by the Rust core, not users)

| Variable | Meaning |
|---|---|
| `NETPULSE_PORT` | Ephemeral loopback port for the sidecar (`0` allowed ⇒ reported via `sidecar-ready port=`) |
| `NETPULSE_DATA_DIR` | OS app-data directory |
| `NETPULSE_MIGRATIONS_DIR` | Staged drizzle migrations folder |
| `NETPULSE_DESKTOP=1` | Marks desktop mode for diagnostics |

## Maturity checklist (honest status)

| Area | Status |
|---|---|
| Sidecar lifecycle + auth | Implemented, smoke-tested (`desktop:verify`) |
| Transport abstraction + UI rewiring | Implemented, unit-tested |
| Native data paths, migrations staging | Implemented, smoke-tested; config-override path bug fixed (see below) |
| Crash recovery | Implemented + E2E-tested (`e2e-recovery.mjs`): stale VPN rows reset, clean-exit flag, recovery events |
| Tray, single-instance, close-to-tray | Implemented (compiles only when Rust toolchain present) |
| `cargo build` / packaged installer | **Not runnable in this environment** (no Rust/MSVC) — see below |
| Privileged helper (routes/DNS/tunnel) | Not yet implemented; documented boundary in this file |
| OS keychain secret storage | Not yet implemented; current vault design keeps secrets out of node tables and out of `localStorage` |

## Environment limitations (recorded honestly)

This conversion was performed on a machine **without the Rust toolchain or
MSVC build tools**, so `cargo check`, `tauri build` and installer generation
could not be executed here. The Rust sources follow Tauri v2 APIs current at
the time of writing and are expected to compile on a machine with Rust +
MSVC installed; run `npm run desktop:build` there. Everything verifiable
without Rust (12/12 pipeline checks) passes.

## Bugs found and fixed during release hardening (2026-09-12 connectivity pass)

- **CORS missing the packaged webview origin** (`tauri.localhost`): every authed request preflighted
  against a dev-only allowlist → browser blocked every response while curl tests passed. Fixed via
  `DESKTOP_WEBVIEW_ORIGINS` in `config.ts`; locked by `desktopCors.test.ts`.
- **`__TAURI__.invoke` undefined in Tauri v2's global bundle** (moved to `__TAURI__.core.invoke`):
  six modules silently fell back to same-origin web transport → zero webview→sidecar sockets.
  Fixed with the central `tauriInvoke()` resolver.
- **Bootstrap `api_base` missing `/api/v1`**: all requests 404'd after the transport fix; the
  bootstrap now returns the prefixed base, matching the web transport's contract.
- **Watchdog died permanently on a poisoned mutex** (`Err(_) => return` ended the respawn loop):
  the UI retried a dead port forever. Now recovers and keeps respawning; verified by killing the
  sidecar live (death record → respawn attempt 1/5 → full reboot in ~1 s).
- **Silent sidecar death**: decoded exit code + stderr tail now recorded and surfaced in the
  reconnecting banner (external `-1` kills — the antivirus pattern — are explicitly named).
- **Log-path mismatch**: the writer used Roaming `app.netpulse.desktop\logs` while the reader used
  Tauri's `app_log_dir()`; single authoritative resolver added.
- **Teardown panic** (tao `cannot move state from Destroyed`): sidecar now stopped before
  event-loop destruction on every exit path; tray Quit destroys the window first.
- **Orphaned WebView2 processes** after abnormal parent exit: startup sweep kills root browser
  processes whose parent is dead (`taskkill /T` for their children).
- **Signing order** (`beforeBundleCommand`): Tauri patches the exe *after* that hook, invalidating
  the signature (`HashMismatch`) — a tampered-looking binary invites antivirus kills. Signing now
  happens strictly post-build via `scripts/package-signed.mjs`.
- **Unbounded sidecar shutdown** (~7 s VPN-provider disconnects raced process exit): disconnect
  phase now time-bounded.

## Bugs found and fixed during earlier release hardening

- **`configOverrides.dataDir` silently ignored for derived paths**: `loadConfig`
  computed `dbPath`/`tokenFile` from the env-resolved data dir *before* applying
  overrides, so the desktop sidecar persisted its DB to the repo `.data` folder
  instead of the OS app-data dir. Derived paths now follow the final `dataDir`.
- **Fake proxy node test**: reported `httpStatus: 200` without ever proxying.
  Replaced with a real ephemeral sing-box tunnel probe (or an honest
  `engine_unavailable` result when the binary is missing).
- **VPN operation races**: connect/reconnect/disconnect are now serialized
  through a route-layer mutex (no double-connect or disconnect-during-connect).
- **Missing crash signal**: an unclean shutdown with no stale tunnels was
  invisible. A clean-exit flag in settings now records every ungraceful death.
- **Monitor timer leak**: health/stability monitors now stop on app close.
- **Event-listener leak**: `MapCanvas` never removed its `pointerleave` handler.
- **Log secret exposure**: pino `redact` now strips bearer tokens, cookies,
  passwords, private keys and pre-shared keys from every structured log line.

## Next steps toward release

1. Compile on a Rust-equipped machine; fix any API drift (`npm run desktop:build`).
2. Add the privileged helper (elevation boundary) for route/DNS/tunnel ops.
3. Move VPN credentials into OS keychain (`keyring` crate in Rust core).
4. Sign/notarize installers; wire the updater in Tauri v2's plugin model.

## VPN engine hardening (real-world Windows)

- **Honest state only:** `Connected` is reported only from the provider's own verification (WireGuard interface stats via `wg show`, OpenVPN management socket, sing-box API). A refused/failed connect surfaces the engine's real error (e.g. `elevation_required` with the WireGuard log line) — never a silent success.
- **Targeted process control:** disconnects stop the exact child PID this app started (`taskkill /PID`), never `taskkill /IM` sweeps that would kill a user's unrelated tunnels. Status checks are scoped to the app's own tunnel/interface names, so externally-created WireGuard tunnels are not misreported as this app's connection.
- **Rollback on failure:** a connect that fails partway removes the tunnel service / temp config it created; failed connects leave zero `NetPulse*` services and zero temp private-key files (temp configs are created with restrictive ACLs in the app data dir and deleted on every exit path).
- **Orphan sweep:** on boot the backend sweeps for stale state from a previous crash — leftover `NetPulse*` tunnel services, orphaned sing-box/openvpn children of a dead sidecar — and cleans them (logged).
- **Watchdog + bounded reconnect:** the Rust supervisor respawns a crashed sidecar with backoff (5 attempts); the backend VPN watchdog detects a dropped tunnel (interface gone / handshake stale) and auto-reconnects with exponential backoff, giving up cleanly after the configured bound instead of spinning forever.
- **Kill-switch honesty:** `killSwitchActive` in `/vpn/status` reflects only the explicitly-enabled, actually-implemented block rule; there is no silent always-on kill switch.

## Performance engineering

- **Data retention (bounded DB growth):** `apps/api/src/db/retention.ts` sweeps measurement/event tables on boot + every 6h — tests+payloads 14d, map observations 7d, scan jobs / gaming comparisons / DNS benchmarks / raw crawled docs 30d. Deletes are chunked (5k rows, 20k per table per run) with WAL checkpoints, so a first run against a large legacy DB drains incrementally instead of stalling. Child detail rows cascade from `network_tests`.
- **SQLite memory tuning** (`db/client.ts`): 8 MB page cache, `temp_store=MEMORY`, 128 MB mmap reads, `cache_spill=false`, WAL truncate-checkpoint at open; `PRAGMA optimize` + WAL truncate on close.
- **Measured (installed exe, idle):** GUI 0% CPU / ~30 MB, sidecar 0.08% CPU / ~75–120 MB — flat over 60 s. History query (500 of 5,000 rows with full payloads) 69 ms; events (200 of 5,000) 4 ms. A 40-node scan runs at 0.1% CPU with flat RAM and the GUI stays at 0% throughout.
- **Verified live:** 5,000 tests + 5,000 events seeded into the production DB — boot sweep removed exactly the pre-cutoff half (5000→2500), fresh rows untouched; large-history API latency unchanged.
- Frontend already paginates the node explorer (50/page server-side), bounds map history (199 points/target), caps session event buffers (200), pauses background polling when hidden (TanStack v5 default), and fully memoizes map/chart derivations.

## Self-diagnostics (System Health page)

The app is self-diagnosing. Startup state machine: **Starting → Checking →
Ready / Degraded / Recovery Required** — surfaced as a status pill next to the
command palette and as banners; full details on **System Health** (`/health`).

- `GET /api/v1/meta/health` aggregates: database round-trip, data-dir write
  probe (permissions), VPN engine detection, network reachability (2 s TCP
  probe), and bundled sidecar assets. Every non-ok check carries a concrete
  recovery action (restart backend / reset state with backup / open logs).
- **Scheduled VPN tunnel self-test** (dedicated card on the page): a periodic
  dry-run that verifies engine availability, stored profile key material
  (vault decrypt + format check, in-process only) and endpoint reachability
  (SSRF-guarded TCP probe of resolved IPs). It never requires elevation and
  never creates/modifies a tunnel; when a tunnel is already connected the
  endpoint probe is skipped. States are honest: `ok`, `unavailable`
  (environmental — no engine or no profiles), `error` (broken key material or
  check failure). Enabled by default every 60 min
  (`settings.scheduling.vpnSelfTest*`), pushed live on the `vpn-selftest` WS
  topic, with a Run-now button.
- Rust IPC for the page: `runtime_status` (sidecar alive, restart count, safe
  mode, window visibility, log size vs cap), `read_log_tail` (redacted),
  `save_diagnostic_report` (JSON report next to logs), `restart_backend`
  (Repair App), plus `reset_app_state` (backup + fresh DB).
- **Export Diagnostic Report** writes versions, runtime status, boot-stage
  journal and the redacted log tail. Secret hygiene is layered: the backend
  pino config redacts auth/token/cookie fields, the sidecar never persists the
  daemon token, and the diagnostics filter additionally drops any log line
  matching secret-shaped patterns before it reaches the webview or a report.
- Logs rotate at 512 KB (`netpulse.log` → `netpulse.log.1`), so they cannot
  grow indefinitely.

## Per-action elevation broker (Windows WireGuard connect)

Installing a WireGuard tunnel service requires Administrator. NetPulse never runs the
whole app (or a long-lived helper) elevated: each connect triggers exactly ONE UAC
prompt for exactly ONE fixed operation, through a three-party handshake:

```text
UI (React)                    Rust core                         Node sidecar
  │ mint opId                    │                                 │
  │ POST /vpn/connect ──────────────────────────────────────────────▶ stage op + materialize config
  │   {profileId, elevation}     │                                 │ (nonce, SHA-256, TTL 120s)
  │ invoke vpn_elevation_bridge▶ │                                 │
  │                              │ GET /vpn/elevation/pending ────▶│ (Bearer + nonce)
  │                              │ ◀── descriptor (exe/args/hash) ─│
  │                              │ validate allow-list + hash      │
  │ ◀─ UAC prompt (runas) ────── │                                 │
  │                              │ POST /vpn/elevation/result ────▶│ resolve long-poll
  │ ◀── connect request returns ─────────────────────────────────── │ verify interface came up
```

Hard guarantees (enforced in BOTH sides independently):
- **One fixed program, one fixed argument shape**: the descriptor can only ever be
  `wireguard.exe /installtunnelservice <config>` with `wireguard.exe` resolved to the
  admin-writable Program Files install — never PATH, never user-writable locations.
- **Config containment + integrity**: the staged config must be an absolute `.conf`
  inside the app data dir, and its SHA-256 is re-verified by Rust immediately before
  launch (a staging→launch swap is rejected). The config (which carries the real private
  key) is deleted on every exit path — success, decline, expiry, error.
- **Nonce binding**: the descriptor and the result are both gated on the nonce that
  traveled UI → Rust; knowing only the opId or the token is not enough. Ops are
  single-use and expire after 120 s.
- **Honest outcomes**: decline → `elevation_declined` (403) with a retry hint;
  expiry → `elevation_failed`; launch succeeded but no interface → `tunnel_not_up`
  (502). The UI never reports Connected without a live `netpulse-wg-*` interface.
- **No generic privileged surface**: the Rust command takes only an opId; there is no
  IPC path that executes arbitrary programs elevated.

In web mode (or non-Windows), the UI omits the elevation field and the plain
unprivileged connect runs, surfacing the OS's own refusal as before.

## Product completeness pass (2026-09-07)

- **Node Explorer wired in**: the page existed but was unrouted. Added `/nodes` route, "Node Explorer" nav entry (Servers & VPN group) and a "Browse nodes" command-palette entry.
- **Tray Quit now tears down the sidecar deterministically**: the Tauri `RunEvent::Exit` hook calls `sidecar::stop_sidecar` (previously dead code; the stdin-EOF watch remains as a backstop for abnormal exits). Verified live: no orphaned node processes after exit.
- **`general.notifications` setting made real**: added the missing toggle on Settings → General, and the Toaster now consumes it (toast suppression when off; hydrated from the shared `['settings']` query cache).
- Verified honest-availability patterns hold: VPN "custom engine" is refused with a typed 501 and hidden from import UI; VPN preference toggles are disabled with a platform-support note; no fake measurements found (grep audit of source; only vendored-bundle TODOs remain).

### Verification (packaged, installed copy)

- Uninstall → silent install → launch → GUI up; loopback-only sidecar listener.
- 12/12 feature endpoints 200 (meta/health, capabilities, VPN, DNS, gaming, Iran, nodes stats, Cloudflare edge, servers, settings, history, map targets).
- Real measurement round-trip: `POST /ping-test` (target 1.1.1.1) returns measured result and lands in history.
- Health composite: all 5 checks `ok`; auth gate returns 401 unauthenticated; WS ticket endpoint issues 64-char single-use tickets.
- Single-instance enforcement (second launch: process count unchanged); sidecar exits cleanly with the GUI (no orphans).

### WebView2Loader.dll — hard requirement on windows-gnu builds

The `webview2-com-sys` crate links the WebView2 loader **dynamically** unless
built with the MSVC toolchain (`target_env = "msvc"` takes the static
`WebView2LoaderStatic` branch; windows-gnu emits `link(name="WebView2Loader.dll")`).
Static linking was evaluated and is **not viable on windows-gnu**: the shipped
`WebView2LoaderStatic.lib` is compiled against the MSVC CRT (`__security_cookie`,
`_Init_thread_epoch`, …) which GNU ld cannot satisfy, and MinGW ld has no
delay-load support to defer the dependency.

Consequences and rules:

- **Every copy of `netpulse-desktop.exe` MUST have `WebView2Loader.dll` next to
  it** (x64, byte-identical to `src-tauri/WebView2Loader.dll`). A bare exe
  copied elsewhere fails at load time with the Windows dialog
  "WebView2Loader.dll was not found" — before any application code runs.
- The NSIS installer always lays the DLL beside the exe (declared in
  `tauri.conf.json` → `bundle.resources`). Installing via the installer is
  always safe; copying a bare exe is not.
- `npm run desktop:verify` fails the pipeline if a built exe lacks its sibling
  DLL, if the DLL is not x64, or if the NSIS installer is older than the exe.
- On a machine with MSVC, static linking becomes available automatically
  (upstream crate behavior) and the DLL dependency disappears.
