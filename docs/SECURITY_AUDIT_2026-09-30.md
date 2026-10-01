# Security Audit — 2026-09-30

Adversarial audit of the NetPulse platform: desktop app (Tauri/Rust), sidecar API
(Node/Fastify), web UI (React), cloud Worker (Cloudflare/D1), updater, installer
pipeline, and the VPN configuration parsing surface. Method: attack-surface
inventory → static sink sweeps → live boundary tests (unauthenticated attacker
position) → fix → regression test → retest. Every finding below was reproduced
before it was fixed.

## Findings

### F1 — MEDIUM — Live operator credential not covered by .gitignore
- **Component:** repository hygiene / secrets
- **Attack surface:** `cloud/worker/.ops-token.local` held a real 48-hex token; the
  ignore rule `*.token.local` does not match a dot-prefixed filename, so the file
  showed as untracked in `git status` — one `git add -A` from a production
  credential leak.
- **Reproduction:** `git check-ignore` said NOT IGNORED; `git status` listed it.
- **Fix:** rule widened to `*token*.local` (with a comment explaining the dot
  trap); the file's value was rotated locally (new value never printed). The old
  value was verified never committed (`git log -S` empty).
- **Regression:** `git check-ignore` assertion in this audit; the pattern now
  matches. Operator action remaining: `wrangler secret put OPS_TOKEN` to revoke
  the old value in production (deliberately not run from the audit).
- **Status:** FIXED (operator rotation step pending).

### F2 — MEDIUM — Ops endpoint had no brute-force limit (Worker)
- **Component:** cloud/worker — `GET /api/v1/ops/netpulse`
- **Attack surface:** unauthenticated internet attacker guessing OPS_TOKEN.
- **Reproduction (live, production):** 12 consecutive guesses all answered 401 —
  no 429 ever. Every other auth surface (login, register, forgot) is rate
  limited; this one was not.
- **Fix:** per-IP D1 fixed-window limiter (30 requests / 5 min) inside
  `handleNetpulseOpsApi`, after the fail-closed 503 config gate so an
  unconfigured worker still answers 503 without consuming the budget. 429
  responses carry `Retry-After`.
- **Regression test:** `cloud/worker/test/ops-page.test.ts` — 30 guesses → 401s,
  31st → 429; even the CORRECT token is refused while limited; the config gate
  does not count against the limiter; a fresh window restores access.
- **Status:** FIXED + regression-tested (verified in miniflare with real D1).

### F3 — MEDIUM — DNS-rebinding window in the capacity probe (sidecar)
- **Component:** apps/api — `SelectionService.probeCapacity`
- **Attack surface:** authenticated local user passing a hostile hostname as an
  optimization candidate.
- **Reproduction (code path):** `resolveTarget()` validated the candidate
  hostname and returned validated IPs, but the probe then did
  `fetch("https://<hostname>/__down…")` — re-resolving DNS at request time. A
  rebinding resolver could answer check-time with a public IP and fetch-time
  with `127.0.0.1`/private space, letting the probe (with its bounded transfer)
  be pointed at internal services.
- **Fix:** the probe now dials the **already-validated IP literal** via
  `node:https` with the hostname presented only as SNI/Host (SNI suppressed for
  IP-literal hosts). A hard read cap and the existing timeout bound memory/time.
- **Regression test:** `apps/api/test/selection.test.ts` — records every dial
  through a test seam and asserts the socket target is an IP literal, never the
  hostname; hostname rides only as SNI/Host. A second test pins the old bug as a
  failure mode.
- **Status:** FIXED + regression-tested.

### F4 — INFO — WS upgrade returns 101 before the ticket check
- **Component:** apps/api — `GET /api/v1/ws`
- **Observation (live):** an unauthenticated WS upgrade gets HTTP 101 (library
  handshake) and is then closed with **4401 "ws authentication required"** before
  any bus access; a garbage ticket is closed identically. Verified live: no bus
  data flows without a valid single-use 30 s ticket minted by an authenticated
  caller (`POST /ws/ticket`).
- **Verdict:** correct behavior — noted because the 101 can look like a bypass
  in a casual probe. No action.
- **Status:** NO ACTION (tested, behaving as designed).

### F5 — LOW — CORS preflight reflected arbitrary origins (Worker)
- **Component:** cloud/worker — `OPTIONS *`
- **Reproduction (live, production):** preflight with `Origin: https://evil.example`
  was answered `Access-Control-Allow-Origin: https://evil.example`.
- **Impact:** not currently exploitable (real responses carry no ACAO headers
  and the API is bearer-authenticated), but it is a standing trap: any future
  authenticated response that grows a CORS header would turn this into a
  cross-origin data grant for any origin.
- **Fix:** preflight grants are now allow-listed (the Worker's own origin and
  the desktop webview's `tauri.localhost`); unknown origins get a bare 204.
- **Regression test:** `cloud/worker/test/worker.test.ts` — arbitrary origin
  must get no ACAO; product origins still granted.
- **Status:** FIXED + regression-tested.

### F6 — INFO — Audit-tool ergonomics: interactive FFI test
- **Component:** src-tauri `elevation.rs` test
- **Observation:** `shell_execute_rejects_missing_binary_without_panicking`
  surfaces a real OS dialog on interactive Windows (the old comment claimed it
  would not). Confirmed harmless — the path does not exist and nothing
  executes — but it blocked `cargo test` for 122 s waiting for a human click.
- **Fix:** marked `#[ignore]` with an explanatory note; runs only via
  `cargo test -- --ignored`. Suite now completes in 0.69 s with no UI.
- **Status:** FIXED.

## Tested and PASSING (no findings)

- **Local API surface (live probes):** unauthenticated reads/mutations → 401;
  session minting without the per-launch secret → 403; wrong bearer → 403;
  malformed bodies → 401/400, never 500; sidecar binds **loopback only**
  (127.0.0.1:47615 confirmed via netstat).
- **Path traversal:** `/update-feed/artifact?file=../…` (both slash styles) →
  refused by basename+prefix validation.
- **WS auth:** single-use 30 s tickets, single-use consumed, 4401 on
  missing/invalid tickets (live-verified).
- **Command injection:** every shell execution is argv-array + `shell: false` +
  timeouts (system proxy, tun sweep, platform probes, engine probes). No
  string-assembled commands found. Hostnames/names never reach shell syntax.
- **SSRF posture:** `targetGuard` refuses private/loopback/link-local/
  reserved ranges for literals AND resolved addresses (IPv4 + IPv6, incl.
  NAT64/mapped forms); engine downloads are allowlist-hosted with pinned
  digests; provider fetches are fixed endpoints with encoded inputs.
- **Elevation broker:** one fixed program (canonicalized Program Files
  WireGuard path), one fixed argument shape, config confined to the app data
  dir with SHA-256 TOCTOU binding, nonce validation, UAC decline handled.
- **Engine manager:** release hosts allow-listed; SHA-256 verified against
  release-published digest or the in-binary pinned digest (unpinned sing-box
  asset refused outright); zip extraction uses a minimal reader (no traversal,
  no shell); binary must pass a `version` self-check before installation.
- **SQL:** every query parameterized (drizzle bindings / D1 `?` binds); no
  string-interpolated user data found in any `.prepare()` across api+worker.
- **XSS:** zero `dangerouslySetInnerHTML`/`innerHTML`/`document.write` in the
  web UI; React text rendering only; Worker pages escape interpolated values
  and run locked-down CSPs (`default-src 'none'`).
- **Cloud auth:** PBKDF2-SHA256 (100k, the Workers platform cap) with NFKC
  normalization; tokens stored hashed; refresh rotation with reuse-tombstone
  session revocation; dummy-hash timing parity against user enumeration;
  per-IP AND per-email login limits (429 verified live at attempt 21);
  registration enumeration note: 409 reveals an existing account (deliberate,
  rate-limited trade-off documented in code).
- **Worker isolation:** every user-data query carries `user_id` from the
  verified session row — never from the client; two-account cross-reads were
  refused in the prior audit pass and the same invariants hold in the current
  route code.
- **Machine inbox:** HMAC-SHA256 over the raw body, nonce burn-before-compare
  (D1 UNIQUE), ±5 min skew, fail-closed when unconfigured; unsigned request →
  401 verified live.
- **Secrets:** no key/token/PEM/env files tracked in git; minisign private key
  lives outside the repo; audit trail no longer records reset tokens; log
  surfaces redact bearer/cookie/key material (defense in depth in both the
  sidecar and the Rust log-tail reader).
- **Updater trust chain (prior real-world test):** a corrupted minisign
  signature over a real artifact was refused at download time by the genuine
  updater ("The signature verification failed") — retested as part of this
  audit via the recorded event chain.

## Fuzzing

`apps/api/test/nodeParsers.fuzz.test.ts` — deterministic hostile corpus
(metacharacters, traversal shapes, malformed base64/JSON, wrong types, huge
values, 500-deep nesting, duplicate keys, prototype-pollution shapes, invalid
UTF-8, invalid IP/IPv6, over-long hostnames, 8 KB remarks, private-range hosts,
unknown schemes) plus a 3,000-mutant pseudo-random sweep, asserting: no throw,
no hang (whole corpus < 1 s), no prototype pollution, bounded outputs, and that
any host emerging from a parse is name-shaped or public. 7/7 pass.

## Verification after fixes

- `apps/api`: 823/823 tests, tsc clean
- `cloud/worker`: 55/55 tests (incl. the new F2/F5 regressions)
- `apps/web`: 198/198 tests, tsc clean
- `packages/shared`: 58/58 tests
- `src-tauri`: 33 passed + 1 opt-in-ignored, 0 failed (0.69 s, no UI)
- eslint clean on all touched files; 4 pre-existing dead-code warnings in the
  Worker router removed as part of the audit.

## Remaining risks (documented, not fixed here)

1. **OPS_TOKEN rotation in production** — the old local token value must be
   revoked server-side (`wrangler secret put OPS_TOKEN`). Until then F1 is
   partially mitigated (file un-leakable, but the old value technically valid).
2. **Self-signed installers** — SmartScreen reputation is unverified-publisher;
   documented in the release notes. Not a code vulnerability; a distribution
   risk accepted pending Azure Trusted Signing.
3. **Registration 409 enumeration** — rate limited, but an existing email is
   still distinguishable. Accepted trade-off, documented in code.
4. **`cargo test -- --ignored` FFI probe** — intentionally interactive; must
   only run on a desktop session by an operator who understands the dialog.
