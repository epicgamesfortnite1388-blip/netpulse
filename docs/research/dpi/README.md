# NetPulse DPI Research Lab

Mission: `NETPULSE_DPI_RESEARCH_AND_ENGINEERING`

This directory is the durable research record for censorship-resistant
transport work on NetPulse and WhiteDNS. It is deliberately separate from
marketing claims and from the deployment reports: a technique appears here
with its evidence, limitations, and the exact conditions under which it was
tested.

## Current position (2026-10-25)

- The WhiteDNS Soar server on the VPS is real and a compatible client works.
  `soar-check 0.1.0` (Soar v0.2.2) authenticated through public recursive
  resolvers and fetched `https://example.com/` with HTTP 200 over UDP/53,
  TCP/53, and automatic transport. See
  [`results/2026-10-25-soar-live.md`](results/2026-10-25-soar-live.md).
- A wrong public key failed closed (`stage=tunnel`, `handshake=false`).
- A Windows client built from Soar v0.2.3 succeeded through the user's local
  Happ proxy (`127.0.0.1:10808`, SOCKS5) using TCP/53 only: HTTP 200 in
  ~3.4 s. This is a **real Windows client** and **real HTTPS through the
  tunnel**, but via a proxy, not a direct Iranian path.
- Direct local DNS remains invalid: the `happ-xray` TUN owns the default
  route and every tested resolver (`1.1.1.1`, `8.8.8.8`, `9.9.9.9`, and the
  VPS) returned `AA=1` with an empty answer in 5-9 ms. Direct Windows Soar
  times out; that is `BLOCKED_ENVIRONMENT`, not a server failure.
- No Iranian-network vantage was available. No claim of Iran-wide
  reachability or censorship resistance is made.

## Evidence labels

| Label | Meaning |
|---|---|
| `PASS_UNIT` | deterministic unit/regression test |
| `PASS_BUILD` | compiles or packages |
| `PASS_LOCAL_INTEGRATION` | two local components work together |
| `PASS_RUNTIME_LIVE_VPS` | live VPS process/endpoint works |
| `PASS_REAL_CLIENT` | a compatible client completed a handshake |
| `PASS_REAL_HTTPS_THROUGH_TUNNEL` | HTTPS content returned through the tunnel |
| `PASS_WHITEDNS_REAL_CLIENT` | WhiteDNS/Soar-specific client path proven |
| `PASS_DNS_PATH_VERIFIED` | DNS path proven, not merely resolved |
| `PASS_SUBSCRIPTION_E2E` | entitlement -> profile -> tunnel -> revoke |
| `PASS_SECURITY_TEST` | negative/security case proven |
| `BLOCKED_ENVIRONMENT` | the environment cannot produce a valid result |
| `NOT_RUN` | no evidence collected |
| `FAIL` | tested and failed |

The VPS Soar run is `PASS_WHITEDNS_REAL_CLIENT` and
`PASS_REAL_HTTPS_THROUGH_TUNNEL` **from a VPS vantage**. It is not an
Iranian-ISP result.

## Documents

- [`bibliography.md`](bibliography.md) — source registry, 30+ entries.
- [`iran-censorship-threat-model.md`](iran-censorship-threat-model.md) —
  layered threat model and confidence.
- [`censorship-mechanisms.md`](censorship-mechanisms.md) — mechanism-level
  observations and discriminating tests.
- [`circumvention-techniques.md`](circumvention-techniques.md) — techniques,
  prior art, and failure modes.
- [`tls-sni-ech-analysis.md`](tls-sni-ech-analysis.md) — SNI, TLS 1.3, ECH,
  and why ECH is not a drop-in fix.
- [`dns-circumvention-analysis.md`](dns-circumvention-analysis.md) — DoH,
  DoT, DoQ, authoritative delegation, and resolver failure.
- [`protocol-comparison.md`](protocol-comparison.md) — measured and
  documented comparison.
- [`whitedns-design.md`](whitedns-design.md) — what WhiteDNS actually is,
  what is deployed, and the integration design.
- [`experimental-methodology.md`](experimental-methodology.md) — safe,
  reproducible lab procedure.
- [`architecture-proposal.md`](architecture-proposal.md) — recommended
  NetPulse design.
- [`engineering-roadmap.md`](engineering-roadmap.md) — prioritized work.
- [`security-review.md`](security-review.md) — privacy, abuse, and secrets.
- [`mission-journal.md`](mission-journal.md) — durable resume state.

## Non-negotiable limits

- Do not probe government filtering infrastructure or arbitrary public
  address space. Use owned VPSes, published measurements, and controlled
  endpoints.
- Do not treat a successful DNS lookup, an open TCP port, a unit test, or a
  process status as proof of a working tunnel.
- Do not reuse the compromised REALITY key, the WhiteDNS panel access path,
  or any credential in a report, commit, screenshot, or chat.
- Do not copy WhiteDNS Android code or binaries into NetPulse; that project
  is source-available proprietary software. WhiteVPN is GPL-3.0 and is a
  Mihomo client, not the WhiteDNS tunnel.
- Do not change production DNS, ports, or services from this lab without a
  reviewed change plan and rollback.
