# Security

NetPulse is a localhost-first application that shells out to OS utilities and performs
active network probes. This document is the threat model and the control set.

## Trust boundaries

1. **Browser → API**: all routes (except `/meta`, `/auth/session`) require an
   authenticated session. **Desktop mode accepts only the per-launch secret** passed
   from the Rust shell to the sidecar over stdin — no cookie a browser could request
   or hold satisfies the API, so a leaked or forged cookie grants nothing. In server
   mode, sessions are minted via `/auth/session`, which is **origin-gated**
   (`sessionOriginRefusal`): a foreign-origin or metadata-less browser request is
   refused, closing the drive-by/DNS-rebinding path. The daemon token file
   (`DATA_DIR/daemon-token`) is generated on first start with restrictive permissions
   and is never exposed through the API or logs.
2. **API → OS**: argv-array `spawn` only. No shell is invoked anywhere in the API.
3. **API → network**: probes are constrained by allowlists and schemas.

## Injection & command execution

- **No raw user input ever reaches a command line.** Platform calls accept typed
  arguments (host, count, timeout) passed as `spawn` argv arrays; target hosts are
  validated (hostname/IP grammar) before use.
- Diagnostic destinations are allowlisted. Arbitrary internet-wide probing is not
  possible through the API: ping/traceroute/endpoint targets must pass the target guard
  (`util/targetGuard`) which blocks private, link-local, loopback, and cloud-metadata
  ranges for scan-class operations, and the Cloudflare scanner only accepts configured
  CIDRs (bounded count, e.g. ≤16 ranges) and allowlisted ports (443/8443 class).
- File paths (VPN configs, vault) are constructed server-side from data-dir constants;
  user input never controls path segments → no path traversal into arbitrary locations.

## SSRF

Outbound HTTP (IP intelligence, DoH, reputation) uses fixed provider URLs or
user-configured **provider** entries validated at the settings layer. Scanner and
diagnostic endpoints cannot be pointed at internal services: see the target guard above.
DNS leak testing uses tester-controlled *names*, not attacker-supplied URLs. User-added
custom DNS resolvers (`POST /dns/providers/custom`) are validated to be public Internet
addresses — private, loopback, link-local, CGNAT, and cloud-metadata ranges are rejected
server-side before any query is attempted.

## Secrets

- VPN private keys and imported node credentials (uuid/password): AES-256-GCM vault
  (see [VPN.md](./VPN.md)); never stored in SQLite, never returned by any endpoint,
  never logged. Proxy cores receive secrets via config files written inside the data
  directory — never %TEMP%.
- Daemon token and session material: file/DB-backed server-side only.
- No secrets in frontend code; the web bundle only ever receives non-sensitive summaries.

## Logging

Structured logging via pino with request serialization; no bodies of auth requests, no
secret values, no vault contents. `LOG_LEVEL` controls verbosity in production.

## Web surface

- CORS restricted to configured origins (`CORS_ORIGINS`), which always includes the
  packaged webview origin (`http(s)://tauri.localhost`, via `DESKTOP_WEBVIEW_ORIGINS` in
  `config.ts`) plus dev origins for `tauri dev`. Unknown origins receive **no** CORS headers, so
  browsers block their responses; drive-by web pages cannot read the sidecar. Locked by
  `apps/api/test/desktopCors.test.ts`.
- Zod validation on every route input; unknown fields rejected at the schema layer.
- Long-running operations are cancellable and rate-bounded server-side (scan concurrency
  caps, stream counts, durations are clamped in services) to prevent resource abuse.
- The API binds `127.0.0.1` by default; remote exposure requires an explicit choice by
  the operator (see [DEPLOYMENT.md](./DEPLOYMENT.md)).
- Desktop auth: the webview receives the ephemeral daemon token only via typed Tauri IPC
  (`bootstrap`), never via localStorage, URL, or filesystem; every HTTP request carries it as a
  Bearer header, and the WebSocket authenticates with a single-use 30 s ticket minted over an
  authed POST. Credentials never traverse the network beyond loopback.
- Frontend↔backend resolution is centralized: all Tauri IPC goes through `tauriInvoke()`
  (`apps/web/src/lib/transport.ts`), which resolves `__TAURI_INTERNALS__.invoke` →
  `__TAURI__.core.invoke` → top-level. Code must not probe window globals directly — a failed
  resolution silently degrades the desktop app to same-origin web mode (functional security
  surface, but the sidecar link and its authed transport are bypassed).

## Privilege

All measurements use unprivileged mechanisms (ICMP via system utilities, TCP connect timing,
HTTPS). Privileged operations run through per-action elevation rather than a
permanently-elevated helper. The elevation broker is driven only by registered,
re-validated descriptors (path under the app data dir, nonce-bound, TTL-bounded) —
there is no generic shell/exec IPC surface. Elevated **relaunch** (for TUN mode) is a
single Tauri command that arms and quits atomically, so invoking it alone can never
leave a dead-end UAC prompt. Under TUN the gateway claims the default route only after
a verified relay proof; a dropped capture re-arms once or fails **closed** with the
kill-switch hold, and the UI shows the enforcement state per mode.

The per-action pattern applies to:

- The unprivileged sidecar validates everything it can (profile, key vault, engine binary),
  materializes the tunnel config into a private temp dir, and registers a **pending operation**
  containing only non-secret fields (config path, interface name, nonce-bound op id, TTL ~90s).
- The webview calls the typed Tauri command `vpn_elevation_bridge`. The Rust core re-validates
  the descriptor (path exists, is a `.conf` under the app data dir, nonce matches), then runs
  the Windows UAC consent prompt via `ShellExecuteExW` with the `runas` verb. Secrets never
  cross the IPC boundary in either direction.
- The Rust core long-polls the sidecar once for the outcome (also nonce-bound) and surfaces
  result/error to the UI; the sidecar verifies the tunnel came up via `wg show` before ever
  reporting success. The op record is single-use and expires; a declined/timed-out UAC leaves
  no state behind and the temp config is deleted on every exit path.
- No process runs elevated at rest; there is no generic shell/`exec` IPC surface. Features
  that would need other privileges (e.g. raw-socket MTU probing) degrade to "unavailable".

## Reporting

If you find a vulnerability, please open a private security advisory rather than a public
issue.
