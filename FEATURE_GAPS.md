# Feature Gaps & Honest Limitations — NetPulse Desktop (v0.2.0)

**Companion to `FEATURE_AUDIT.md`.** Anything listed here is either fixed (with date), genuinely
platform-dependent, or explicitly unavailable — never silently missing.

## Proxy cores — Xray + sing-box engines (SHIPPED 2026-09-12)

Node-source configs are V2Ray/Xray-flavored, so proxy tests now run against **two local cores**
with one interface (`proxyCores.ts` + `proxyEngineRunner.ts`):

- **xray** — the reference V2Ray core; full outbound generation for vless (incl. Reality + XTLS
  flow), vmess, trojan, shadowsocks via `streamSettings` JSON. Preferred first in `auto`.
- **sing-box** — universal coverage (adds hysteria2, tuic, shadowsocksr).

Selection = user preference (Settings → `proxyEngine.preferred`, default `auto`) ∩ installed
binaries ∩ protocol support; `GET /nodes/engines` reports live availability and the UI shows an
honest engine strip on the Node Explorer plus per-result attribution ("measured via Xray-core").

**Fixed alongside — the secret gap that made all proxy tests fake-fail:** imports parsed
uuid/password and threw them away, so every vless/vmess/trojan/ss proxy test was a guaranteed
authentication failure. Credentials now persist in an AES-256-GCM vault (same `FileSecretVault`
class as VPN profiles, keyed per node, never in the DB/API/logs) and proxy tests dial with the
node's real secret.

**Fixed alongside — scanner CIDR validation rejected its own defaults:** the UI defaults are
Cloudflare's PUBLISHED ranges (`104.16.0.0/13`, `172.64.0.0/13` — verified against
cloudflare.com/ips-v4), but expansion demanded /16–/32, so the out-of-box scan 400'd. Expansion now
accepts /8–/32 and samples large ranges on an even deterministic stride up to `maxCandidates`
(never the full space), rejects /0–/7 and private/reserved bases (defense in depth inside the
service, not just the route). 6 regression tests (`cidrExpansion.test.ts`) + 9 core/vault tests
(`proxyCores.test.ts`).

**Remaining honest limitation:** neither core ships with the app (licensing + size); when none is
installed, proxy tests report `engine_unavailable` with install guidance instead of fake numbers.

## Node sources — "cannot grab configs / bad gateway" (FIXED 2026-09-12)

**Root cause (two real bugs, both fixed and verified live on the installed exe):**

1. **"source not found" → 502 on every built-in Fetch.** Built-in sources existed only as in-memory
   constants: `GET /sources` served them from constants while `discoverFromSource` looked them up in
   the **database** — where they were never written. Fix: `seedKnownSources()` seeds the built-ins
   into `public_sources` idempotently at boot (never overwrites user state) and `GET /sources` now
   reads the DB (custom sources also became visible in the list, which previously dropped them).
   Regression tests in `sourcesApi.test.ts` (seed exists, disable-through-API works, seeding is
   idempotent across restarts).
2. **Imports took ~54 s** (read timeouts on slow links → the "can't grab configs" symptom). The
   import loop ran a serial `await dns.lookup()` **per new node**; free-config hostnames are mostly
   nonexistent domains, so ~4k resolver round-trs dominated the request. Fix: import is now
   parse+store only (8,284 configs in 8.2 s, verified end-to-end); hosts resolve at test time
   (`testNode → resolveTarget`), which was already the only consumer of the addresses.

**Evidence on the installed app:** UI click on Fetch → `POST /sources/barry-far/fetch` → 200 →
`{ parsed: 1, imported: 8284, duplicates: 4214, invalid: 48 }`; database shows 30,104 public nodes
(18,490 vless / 5,301 ss / 4,275 trojan / 1,887 vmess / 149 hy2 / 2 tuic) with provenance rows;
zero page exceptions. Repeat fetch of unchanged content short-circuits via content hash
(`status: completed, imported: 0`) — correct dedup behavior, not a failure.

## VPN lifecycle — driven end-to-end to real outcomes (2026-09-12)

The namesake core was the one system no prior pass had driven past `/vpn/status` 200 and an
elevation-403. This pass mapped the chain, then exercised every link **live on the installed
bundle** — this machine has WireGuard installed (`wireguard.exe` + `wg.exe`), so import, connect,
elevation, disconnect and status all ran against real OS operations, not mocks. Harness:
`scripts/tmp-vpn-live.mjs` (16 checks, booting the installed sidecar with throwaway keys) + CDP
probe of the live VPN page.

**What connect actually drives (architecture, verified):** WireGuard provider →
`wireguard.exe /installtunnelservice <temp conf>` (elevated tunnel service, wintun adapter) →
verification via `wg show all dump` interface presence + optional public-IP identity check.
OpenVPN → spawned `openvpn --config … --daemon` with 3s survival check. sing-box → spawned
`sing-box run` in **proxy mode** (no system route change by design; verification = local proxy
answering, reported honestly). "Custom engine unavailable" is an **honest typed 501 adapter**
(`CustomProvider`), not unfinished fake code.

**Live results (16/16):** provider detection honest; valid config imports with sanitized on-disk
profile; hostile imports (INI injection, binary blob, 64k garbage, server-side config, traversal-style
name) all rejected 400 with **zero stray files outside the config store**; non-elevated connect →
**real OS `Access is denied`** surfaced as typed 403 `elevation_required` — one session row,
terminal status, no stuck `connecting`; status honestly `connected:false`; disconnect-when-never-
connected → clean 200 no-op; unknown profile → 404; delete + vault cleanup verified. UI (CDP):
page renders without exceptions, connect interaction surfaces the honest error, status pill
"Disconnected", no stuck states; the connection row + events appear in history surfaces.

**Fixed during this pass:**
- Import hardening (untrusted configs are now validated at import, not deferred to connect):
  wg-quick script-execution directives (`PostUp/PostDown/PreUp/PreDown/SaveConfig` — shell exec
  vector on the Linux path) rejected; WireGuard key material format-validated (44-char base64);
  control characters in sing-box credentials/SNI rejected (log-forging vector); profile names
  constrained to printable single-line strings. Regression suite: `vpnImportHardening.test.ts` (12).
- **Bodyless JSON requests no longer 400**: any standard REST client sending
  `content-type: application/json` with an empty body (e.g. `DELETE /vpn/profiles/:id`,
  `POST /vpn/disconnect`) got Fastify's internal `FST_ERR_CTP_EMPTY_JSON_BODY` 400 even though the
  routes never read a body. A custom JSON content-type parser maps empty bodies to `undefined`
  (malformed JSON still 400s). Found by the live disconnect probe; app-wide fix in `app.ts`.
- Watchdog supervision (VPN process killed mid-session) verified by 4 new unit tests
  (`vpnWatchdog.test.ts`): drop detection, bounded reconnect 5s/10s/20s, `reconnect_gave_up`
  published (no infinite loop), user-disconnect acknowledgement, and survival of entirely-vanished
  engines. Status stays honest in every case (OpenVPN/sing-box reset their state when the child
  dies; WireGuard status derives from live interface presence).

**Remaining, exact and unproven:** a **fully connected tunnel** was never achieved in a live
pass — it requires a human to accept the UAC prompt, which no automated run here can do. The
elevation link itself is now implemented end-to-end (per-action broker: Rust `ShellExecuteExW`
UAC prompt driven by a nonce-bound, single-use, TTL-bounded descriptor; no secrets across IPC;
UI surfaces the real UAC timeout/decline as an honest error) and was verified live to the
consent boundary: the installed app reaches the UAC stage, times out without a human click,
and reports `elevation prompt timed out` without corrupting state. Everything else up to the
OS's own elevation gate is proven real, including the OS refusing with `Access is denied` and
the app reporting it truthfully. `tunnel_not_up` (502: invalid endpoint/keys under a *granted*
elevation) and `connect timeout/cancel` after consent remain unit-verified only — the code
paths exist, are typed, and clean up key material on every failure path.

## Fixed 2026-09-12 — per-action elevation broker (VPN connect UAC)

The VPN connect button previously dead-ended at a generic 403: the only way to reach a real
tunnel was to run the whole app elevated. Now the WireGuard connect flow drives a **per-action
broker** split across the three layers, each with its own validation:

- **Node sidecar** (`elevationBroker.ts`): validates profile/key/engine, materializes the temp
  config first, registers a single-use pending op (TTL, nonce, descriptor hash), long-poll
  resolve endpoint; cleanup of temp material on every exit path.
- **Rust core** (`elevation.rs`): typed Tauri command `vpn_elevation_bridge` re-validates the
  descriptor (path under app-data `.conf`, nonce, hash) *before* the prompt, shows the Windows
  UAC consent via `ShellExecuteExW` `runas`, then nonce-bound fetches the outcome once. No
  secrets cross IPC in either direction; no generic shell surface.
- **UI** (`elevationBroker.ts` in web): arms the bridge only on the desktop transport, then
  surfaces the real outcome — success, decline, or `elevation prompt timed out` — as toasts
  and honest status pills.

Tests: 12 Node broker tests (nonce/hash/TTL/resolve races) + 8 Rust tests (descriptor
validation, nonce binding). Live on the installed exe: full handshake reaches the UAC stage,
times out cleanly with the honest error, no state left behind. A granted consent + live tunnel
still requires a human click and is covered under "Remaining, exact and unproven" above.
## Fixed 2026-09-12 — desktop connectivity (the "backend unreachable" class)

The headline gaps this pass were not missing features but a **broken desktop link**: the packaged
webview could not reach a healthy sidecar. Three stacked root causes, all found by attaching Chrome
DevTools Protocol to the live installed webview (HTTP probes and unit tests were blind to all three):

| Gap | Symptom | Root cause | Fix | Verification |
|---|---|---|---|---|
| CORS blocked the webview origin | every request "Failed to fetch" in the UI; backend healthy | sidecar allowlist had only dev origins; UI origin is `http(s)://tauri.localhost`; authed requests preflight | `DESKTOP_WEBVIEW_ORIGINS` in `config.ts` merged into the default allowlist | new `desktopCors.test.ts` (5 tests) + in-webview fetch `200` |
| Transport resolved `invoke` from the wrong place | app silently used same-origin web mode; **zero** webview→sidecar sockets | Tauri v2 exposes `invoke` at `__TAURI__.core.invoke`, not `__TAURI__.invoke`; 6 modules checked top level only | central `tauriInvoke()` resolver in `transport.ts`; all call sites converted | CDP: `desktop transport ready: …/api/v1`; established sockets via netstat |
| Bootstrap `api_base` missing `/api/v1` | all requests 404 after fixes 1–2 | web transport contract: `apiBase` includes the prefix; Rust bootstrap returned bare origin | `main.rs` returns `http://127.0.0.1:<port>/api/v1` | CDP: all observed app requests `200`; banner gone |

Why these survived every prior audit: each is a **packaging-only** failure. Dev mode (Vite same-origin
proxy + real dev server) masks all three; curl/Node probes don't enforce CORS and bypass the webview
entirely. The lesson is institutionalized: "Working" now requires the **webview-layer E2E check**
(CDP against the installed exe), not just HTTP probes.

## Fixed 2026-09-12 (second interaction audit) — /optimizer crash on completed payload

Clicking **Run optimization** hard-crashed the page into the React Router error screen
(`TypeError: Cannot convert undefined or null to object` at `Object.entries(result.weights)`).
Root cause: **payload-shape drift between delivery paths** — the HTTP response of the optimizer
included `weights`, but the WS `test:done` payload and the persisted DB record omitted it, and the
page renders from those. Same disease as the desktop-link bugs: contract drift that only manifests
in one delivery path. Fixed by publishing the complete `OptimizationRunResult` on both WS and DB
(`optimizerService.ts`) plus a defensive `?? {}` at the render site. Sibling services were audited
for the same drift (speed/diagnostics/routes are consistent). Regression tool kept:
`scripts/audit-webview-runs.mjs` clicks Run on every async-test page, waits for completion and
checks the final render — the audit layer that caught this. Also fixed: staged build artifacts
(`src-tauri/backend/node.exe` ~92 MB, WebView2Loader.dll) removed from the git index and ignored.

## Also fixed 2026-09-12 (from the hook-dependency audit)

Enabled `eslint-plugin-react-hooks` properly, which surfaced 12 real/potential defects; 8 fixed in
code, 4 intentional patterns documented with `eslint-disable` + justification comments:

| File | Defect | Fix |
|---|---|---|
| `MapCanvas.tsx` | mount-only canvas loop captured `privacy`/`onSelect`/`onHover` in stale closures — privacy toggle never redrew latency labels | ref-pattern (`privacyRef`, callback refs) matching the file's existing `nodesRef` approach |
| `ServersPage.tsx` | `servers = data ?? []` unstable identity tore down/recreated the 12 s poll interval every render | `useMemo` on the fallback |
| `CloudflarePage.tsx` | same unstable-identity issue feeding two `useMemo`s | `useMemo` on the fallback |
| `DnsPage.tsx` | history refetch ignored `historyRange`; post-benchmark refresh ignored `profile`/`transport` | deps corrected; `historyRange` declared before first use |
| `LiveMapPage.tsx` | unnecessary deps on `targets`/`observations` (recompute churn); playback set-once guard documented | deps corrected; one documented exclusion |

## Fixed 2026-09-12 (quality gate & dead code)

- **`audit:ci` never landed** — the npm script wired the previously-orphaned `scripts/audit-ci.sh`
  (madge circular-deps, ts-prune, depcheck). The depcheck helper's regex construction was corrupted
  (unterminated group); rewritten as robust token matching with a binary-tooling allowlist and
  root-config scanning. Gate now exits green.
- **Dead dependencies removed**: `globals`, `eslint-plugin-react-refresh` (installed, never
  referenced). `eslint-plugin-react-hooks` was installed but unused — now actually wired in.

## Fixed earlier (watchdog/recovery hardening, verified live this pass)

- Watchdog no longer dies permanently on a poisoned mutex (the "attempt 1095 with zero recovery" bug).
- Sidecar death reason (decoded exit code + stderr tail) recorded and surfaced in the reconnecting banner.
- Single authoritative log-dir resolver — System Health reads the same file the app writes.
- Teardown reordered: sidecar stopped before event-loop destruction (tao `cannot move state from Destroyed` panic).
- Startup sweep of orphaned WebView2 roots with dead parents.
- Signing moved strictly post-build: the old `beforeBundleCommand` signature was invalidated by
  Tauri's post-patch (`HashMismatch`) — a tampered-looking binary is prime antivirus bait, matching
  the observed external `-1` kills of the sidecar.
- Sidecar graceful shutdown bounded (~7 s unbounded VPN-provider disconnect raced the process exit).

## Fixed 2026-09-07 (feature-completeness pass, still green)

| Gap | Was | Fix | Verification |
|---|---|---|---|
| Node Explorer unreachable | fully built page, no route/nav | `/nodes` route + nav + palette entry | typecheck, wiring test, live list 200 |
| Node Detail unreachable | built page, no route, dead `href="#"` link | `/nodes/:id` route; explorer link navigates | wiring test |
| Sources management had no UI | backend + SSRF guards existed, zero frontend | `/nodes-sources` page | integration tests |
| `PATCH/DELETE /sources/:id` missing | backend had create+list+fetch only | routes implemented with validation + 404s | 4 integration tests |
| Node scanner/test-endpoints had no UI | API-only | exposed on `/nodes-sources` | wiring test + live probes |
| Route-wiring regressions possible | nothing prevented an unwired fetch | `routeWiring.test.ts` meta-test | test added & green |

## Platform-dependent / Unavailable (honest states in-product)

| Item | Why | Where surfaced |
|---|---|---|
| Custom VPN engine adapter | no bespoke control plane implemented; sing-box covers VLESS/VMess/Trojan/SS | typed 501 `not_implemented`; hidden from import UI |
| Kill switch enforcement | requires per-platform firewall/rule plumbing (Windows via WireGuard service block rules) | Settings toggle disabled with explanation; `killSwitchActive` reflects real rules only |
| Auto-connect on launch | not implemented; must not silently change a system's network state without explicit support work | Settings toggle disabled |
| Elevated VPN connect from tests | test sessions are unelevated; real tunnel handshake requires an admin run | honest 403 `elevation_required` with engine's own error text |
| SmartScreen reputation | binaries are signed but with a self-signed cert; reputation requires a CA/EV certificate | signature + tamper detection verified; SmartScreen `UnknownError` until a CA cert exists |

## Known limitations (Working features with scope limits)

- **Speed test** — single-connection ceiling on very fast links; bufferbloat grading uses the same engine.
- **Live Map** — geolocation is coarse (city/region level from public geo APIs); operator-private paths not shown.
- **Node geolocation (fixed 2026-09-13)** — node pins now come ONLY from IP-evidence
  geolocation (ipwho.is on the node's resolved public IP) via a bounded, serialized
  background worker (`nodeGeoService`); per-node attempts rate-limited by
  `geo_last_attempt` (7-day retry on failure, 30-day refresh on success). Names,
  remarks, flag emoji, TLDs, and provider branding NEVER influence placement.
  Failed lookups leave country/lat/lon null (Unknown) — nothing is invented.
  Geo-verified nodes appear on the map as targets (freshest 12, `medium`/`low`
  confidence). **Anycast guard (2026-09-13):** well-known anycast IPs and
  edge-fabric ASNs (Cloudflare 1.1.1.1/1.0.0.1, Google 8.8.8.8, major cloud
  front doors) are refused a city pin — GeoIP fabricates locations for them
  (1.1.1.1 answered "Brisbane, AU" from an Iranian vantage); a boot scrub
  clears fabricated pins written before the guard existed. **Guard dataset +
  user overrides (2026-09-13):** the curated classes live in `geoGuard.ts`
  (~30 anycast hosts: public DNS resolvers; ~20 edge-fabric ASNs: Cloudflare,
  Google, AWS, Azure, Fastly, Akamai, GCore, Bunny, DDoS-guard networks…).
  Users can correct future cases without a release via
  `<dataDir>/geo-overrides.json` (hot-reloaded on change, malformed files
  reported and skipped, prior overrides kept):

  ```json
  {
    "version": 1,
    "overrides": {
      "1.2.3.4":   { "class": "anycast" },
      "AS64512":   { "class": "edge_fabric" },
      "104.17.147.22": { "class": "unicast", "force": { "lat": -33.87, "lon": 151.21, "country": "AU", "city": "Sydney" },
                         "note": "dedicated (non-edge) IP confirmed with provider" }
    }
  }
  ```

  Overrides beat the curated data in both directions: refuse a normally
  pin-able IP, or vouch a refused one back with exact coordinates (written
  with `high` confidence by the next enrichment tick). Node detail shows WHY
  a location is absent (`geoStatusReason`: anycast / edge_fabric /
  lookup_failed / pending; vouched nodes read pending, never failed).
  Remaining limits: ipwho.is rate/accuracy, CDN-fronted hosts geolocate to
  the edge, not the origin server.
- **History** — 14-day retention (bounded sweeper); payloads only in detail view.
- **Logs** — 512 KB rotating cap (`.log` → `.log.1`).
- **Node sources** — built-in catalog entries cannot be deleted (can be disabled); fetched configs are
  untrusted input parsed defensively, never executed.
- **Adaptive node auto-tester (added 2026-09-13)** — bounded TCP-probe batches every
  30 min (settings: `automation.autoTestNodes`), prioritizing never-validated →
  stale-good → unstable nodes; dead+unseen-14-days nodes retire to `stale` (history
  kept). Verified live: honest statuses appear within minutes of boot; proxy
  (engine-heavy) tests stay on-demand to bound CPU/network.
- **Failure intelligence (added 2026-09-13)** — node test errors are diagnosed with
  cautious labels (Likely/Possible/Unable to determine) across DNS, TCP, TLS, auth,
  engine, and policy categories (`failureIntelligence.ts`, 9 tests).
- **Iran connectivity** — an observation/diagnostics tool; deliberately contains no circumvention capability.
- **Cloudflare scanner** — scoped to Cloudflare CIDRs and rate-limited; not a general CIDR scanner.
- **Real VPN connect e2e** — verified via honest failure path + unit tests this environment; a full
  handshake needs an elevated run on a machine with WireGuard installed.
- **Auto-updater** — dormant until minisign keys + a release feed are configured (documented in RELEASING.md).
- **Antivirus interference** — AVs may still kill the bundled `node.exe` (observed as external `-1`
  kills); the watchdog now recovers automatically and the UI shows the decoded reason instead of an
  endless retry counter.
