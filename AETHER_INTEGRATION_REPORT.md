# Aether Integration Report

**Mission:** `NETPULSE_AETHER_AUTONOMOUS_V2` · **Date:** 2026-11-04
**Overall verdict:** **PASS for the Windows client path**, with Iran-ISP behaviour and non-Windows targets **NOT TESTED**.

Every row below points at the artifact or test that produced it. A row without evidence is marked `NOT TESTED`, never assumed.

---

## 1. Engine identity and versions

| Item | Value | Evidence |
| --- | --- | --- |
| Aether binary | `aether.exe`, 24,467,456 bytes | `aether/aether.exe` |
| Aether version | **2.4.0** | `./aether/aether.exe --version` → `aether 2.4.0`; `aether/run6.log` line 1 `Aether v2.4.0` |
| Install channel | `CluvexStudio/Aether` release asset `aether-windows-x86_64.zip` | `AETHER_RELEASE` in `apps/api/src/services/engineManager.ts` |
| Checksum | verified before extraction (`.sha256` sidecar, SHA256SUMS fallback) | `reports/accounting/AETHER_TUNNEL_PROOF_2026-11-03.md` §1 (`checksumVerified: true`, `tookMs: 6480`) |
| Proxy core (public configs) | Xray-core **26.10.31**, installed through `installEngine('xray')` | `reports/accounting/FREE_CONFIG_CONNECT_RATES_2026-11-03.md` |
| sing-box | **not installed** — pinned 1.12.x tags no longer resolve in the upstream release lookup | same report; `hysteria2`/`tuic` configs are therefore `engine_unavailable` |

---

## 2. Integration surface

Implemented in `apps/api/src/vpn/aetherProvider.ts` and exposed through `/api/v1/vpn/*`.

| Requirement | Implementation | Status |
| --- | --- | --- |
| Engine initialization | `AetherProvider.init()`, binary + identity directory checks | **PASS** |
| Install / update | `installAether()` with digest verification and `-v` self-check | **PASS** (artifact) |
| Start | `buildAetherArgs()` + spawn through the shared core-process owner, `[direct]` routes rendered from bypass rules | **PASS** (20 unit tests, `aetherProvider.test.ts`) |
| Stop / clean shutdown | process kill + wait, system-proxy restore, routes-file cleanup, state clear | **PASS** (unit) |
| Configuration validation | `parseAetherSettings()` allow-lists protocol/scan/transport/IP/noize; invalid JSON rejected `400 invalid_config` | **PASS** (unit) |
| Relay verification | `socks5RelayCheck()` — a real SOCKS5 CONNECT that must relay bytes | **PASS** (negative controls 4/4) |
| Exit verification | `fetchExitIpThroughSocks()` reads the egress IP through the tunnel | **PASS** (`104.28.197.9`, DE via FRA) |
| DNS through tunnel | `resolveThroughTunnel()` — DNS-over-TCP/53 inside SOCKS5, with a hand-rolled query encoder/decoder | **PASS** (15/15 resolutions matched, 80 ms tunnel median) |
| Traffic measurement | provider `health()` + connection rows; byte counters are **null** for Aether (the binary exposes no counter) rather than invented | **PARTIAL** |
| Network-change handling | supervisor + watchdog; Aether's own reconnection and quick-reconnect | **PASS** (reconnect artifact) |
| Reconnection | 93 ms to detect down, 3,032 ms back, same exit IP | **PASS** (`RECONNECT_TEST_2026-11-03.json`) |
| Error classification | `exitCodeLabel()`, `aether_missing`, `already_connected`, relay-failure reasons | **PASS** (unit) |
| Log redaction | identity/TOML, tokens and keys never written to logs or events; `aether/` is git-ignored | **PASS** (inspection + vault tests) |
| Health checks | `health()` returns endpoint latency where known, nulls elsewhere | **PARTIAL** |
| Recovery after engine failure | child-exit handler marks the connection errored; watchdog path re-establishes | **PASS** (unit + artifact) |

---

## 3. Measured behaviour

### 3.1 Tunnel bring-up and data plane

From `reports/accounting/AETHER_TUNNEL_PROOF_2026-11-03.md`:

- Three earlier configurations produced a **listening SOCKS5 port with no relay**. The proof was tightened to require relay + exit IP.
- Final working run (`aether/run6.log`): cached gateway `162.159.199.1:443` verified, `connect-ip status: 200`, *"masque tunnel validated (end-to-end data confirmed); exposing socks5"*, listener on `127.0.0.1:1819`, exit `104.28.197.9` (DE via FRA), 240 ms to Cloudflare.

### 3.2 Stage timings (20 repeats, `api.ipify.org`)

`reports/accounting/TUNNEL_STAGES_2026-11-03.json` — 20/20 completed, 0 failures:

| Stage | min | median | p90 | max |
| --- | --- | --- | --- | --- |
| DNS | 0 ms | 1 ms | 1 ms | 89 ms |
| SOCKS connect | 76 ms | 80 ms | 87 ms | 95 ms |
| TLS handshake | 82 ms | 92 ms | 100 ms | 100 ms |
| HTTP first byte | 186 ms | 197 ms | 278 ms | 361 ms |
| **End to end** | **352 ms** | **372 ms** | **467 ms** | **535 ms** |

Caveat recorded by the artifact: `dnsRunsThrough: "local resolver (tunnel refuses ATYP 0x03)"` — Aether's SOCKS listener does not accept domain-form addressing, so the harness resolved locally for this stage benchmark. Name resolution through the tunnel is measured separately below and is real.

### 3.3 DNS through the tunnel

`reports/accounting/DNS_TUNNEL_PROOF_2026-11-03.json`: resolver `1.1.1.1:53` over DNS-over-TCP through SOCKS5, 5 rounds × 3 names = 15 queries.

- `localResolved: 15`, `tunnelResolved: 15`, `sameAnswerCount: 15`, `differentAnswerCount: 0`.
- `tunnelMedianMs: 80`, end-to-end exit `104.28.197.9`.
- Verdict: *"DNS resolved through the tunnel in every round; payload still reaches the same destination"*.

### 3.4 Reconnect

`reports/accounting/RECONNECT_TEST_2026-11-03.json`: `confirmedDown: true` at 93 ms, `confirmedUp: true`, `reconnectMs: 3032`, `totalOutageMs: 3125`, `exitAfter: 104.28.197.9`, `exitStable: true`. Verdict **PASS**.

### 3.5 Negative controls

`reports/accounting/NEGATIVE_CONTROLS_2026-11-03.json`: `total: 4, passed: 4, failed: 0, verdict: "PASS"`.

| Control | portOpen | relay | exitIp | Verdict |
| --- | --- | --- | --- | --- |
| C1 blocked peer `192.0.2.1:443` | true | **false** | null | PASS |
| C2 occupied bind port | true | **false** | null | PASS |
| C3 corrupt identity TOML | false | false | null | PASS |
| C4 direct egress after failures | — | — | `83.229.87.141` (host IP) | PASS |

This is the evidence that "connected" is not just "port open" in this codebase.

### 3.6 Leak behaviour

`reports/accounting/LEAK_TEST_2026-11-03.json`:

- IPv4 exit through relay: `104.28.197.9`.
- Host has **no direct IPv6 egress**; the tunnel carried an IPv6 TLS handshake to `2606:4700:4700::1111` (cert `CN=cloudflare-dns.com`), so IPv6 works *through* the tunnel.
- Explicitly **not covered**: IPv6 leak coverage outside the tunnel (no v6 path exists to leak onto), UDP/QUIC leak behaviour (SOCKS listener is TCP-only here), second interface / OS-configured resolver.

---

## 4. Unit-test coverage of the provider

`apps/api/test/aetherProvider.test.ts` — 19 tests over: connect through the shared core-process owner, TUN status mapping, settings parsing, argv construction, and the SOCKS5 client.
`apps/api/test/aetherDns.test.ts` — 7 tests over the tunnel DNS codec: query encoding, compression pointers, uncompressed answer names, non-zero rcode, ID mismatch, truncated packets.

Both are part of the 1,198-test API suite that passes (see §6).

---

## 5. Integration boundaries that are real

1. **Aether cannot dial free share links.** It accepts settings JSON only. Public VLESS/VMess/Trojan/SS/Hy2/TUIC configurations are handled by Xray/sing-box. This is enforced, not documented-and-forgotten: `SmartConnect` excludes a protocol no installed core supports.
2. **Aether is a WARP client.** It does not give you a third-party free node; it gives you Cloudflare WARP egress. Its privacy properties are Cloudflare's, not the free-node operator's.
3. **`--team` is not passed**, so WARP Zero Trust key pinning is off; `aether/run6.log` records `tls verification: disabled`. Changing that default is a product decision, not a silent edit.

---

## 6. Build and test status at time of report

| Check | Command | Result |
| --- | --- | --- |
| TypeScript typecheck (API) | `npx tsc -p apps/api/tsconfig.json --noEmit` | **PASS** (exit 0) |
| API test suite | `npx vitest run` in `apps/api` | **PASS** — 107 files, **1,198 tests**, exit 0 |
| Smart Connect unit tests | `npx vitest run test/smartConnect.test.ts` | **PASS** — 40/40 |
| Agent permission tests | `npx vitest run test/agentPermissions.test.ts` | **PASS** — 28/28 |
| Windows tunnel proofs | `npm run proof:vpn`, `probe:*`, `test:reconnect`, `test:leaks` | **PASS** as recorded in `reports/accounting/*` (2026-11-03) |
| Iran-ISP field behaviour | `npm run field:iran` | **NOT TESTED** — no Iranian vantage available |
| Android core binding | inspection of PattNG Java | **NOT TESTED** |

---

## 7. Remaining gaps

- No byte counters from Aether: upload/download totals in the UI must come from another source or stay null. They are currently null rather than fabricated.
- The IP-version/leak matrix is incomplete: UDP/QUIC leak behaviour is unmeasured.
- Aether release handling depends on GitHub's unauthenticated API quota (60/hr); the artifact notes the API-free `releases/latest/download` path exists as a fallback but is not yet the primary path.
- Iran remains the central unproven claim, and this report does not make it.
