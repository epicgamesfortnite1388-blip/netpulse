# Protocol and Transport Comparison

This is a decision table, not a scoreboard. "Measured here" means the
evidence exists in this iteration; everything else is documented prior art or
`NOT_RUN`. A protocol's reputation is not a measurement.

| Candidate | Transport / shape | Strengths | Main failure modes | NetPulse status | Evidence |
|---|---|---|---|---|---|
| VLESS + REALITY | TCP/TLS-like, Xray | real TLS cover, mature Iran/China use | target/IP blocking, active probing, version drift | deployed on VPS; real client reported in prior work; not retested here | S13, S14 |
| VLESS/VMess WS+TLS | TCP/TLS + WebSocket, often CDN | real certificate/domain, CDN option | CDN policy, path fingerprint, origin leak | deployed; not retested here | S09, S13 |
| Trojan TLS | TCP/TLS | simple, real certificate | SNI/IP filtering, active probing | deployed; not retested here | S13 |
| Shadowsocks 2022 | TCP (and UDP variants) | lightweight, widely supported | shared key in current deployment, fingerprinting | deployed; per-user revocation missing | S22 |
| Hysteria2 | QUIC/UDP | loss tolerance, high throughput | UDP blocking, QUIC classification, MTU | deployed; UDP not verified in this iteration | S19 |
| TUIC | QUIC/UDP | 0-RTT, low handshake | UDP blocking, less active maintenance | not deployed | S20 |
| WireGuard | UDP | simple, fast | static fingerprint, UDP blocking, key mgmt | deployed; DNS/peer test incomplete | prior VPS inventory |
| AmneziaWG | obfuscated UDP | reduces static WG signature | obfuscation params become signature; UDP | not deployed | S25 |
| OpenVPN | TCP/UDP + TLS | mature | fingerprint, overhead | supported, not default | local code |
| NaiveProxy | HTTP/2/3 TLS | browser-like stack | needs domain/cert/server; traffic shape | not deployed | S21 |
| Soar (WhiteDNS) | DNS tunnel over recursive resolvers | survives DNS-only paths; multi-resolver | rate limits, QNAME limits, latency, client gap | server live; VPS client **PASS**; Windows **BLOCKED_ENVIRONMENT** | S07, S08, live result |
| CottenDNS / CottenMax | DNS tunnel, UDP/TCP/DoT/DoH | Windows client, adaptive paths | beta, shared key normal mode, no Iran test | not deployed | S12 |
| MasterDNS/StormDNS | DNS tunnel | lineage, resolver handling | shared key, licensing/maintenance | not deployed | S27, S28 |
| Tor PTs / Psiphon | bridges / adaptive tunnels | established ecosystem | distribution, blocking, not tested | not deployed | not verified here |
| ByeDPI / Geneva | local packet manipulation | research probes | stateful filters, app breakage, not a VPN | not deployed | S29, S30 |

## Selection criteria

| Criterion | How to measure | Minimum evidence |
|---|---|---|
| Connection success | attempts that reach authenticated data phase / total | 20 attempts, separate vantages |
| Establishment time | median/p95 to first HTTPS byte | timestamps, same endpoint |
| Throughput | sustained up/down | controlled transfer |
| Resilience | reconnect after loss/restart | bounded fault injection |
| Filtering sensitivity | failure stage by SNI/IP/transport | controlled variation |
| Resource cost | CPU/RAM/battery | measured, not guessed |
| Deployment complexity | server/client steps | reproducible runbook |
| Security | auth, revocation, parsing, secrets | review + negative tests |
| Privacy | metadata, logs, correlation | data-flow review |
| Licensing | redistribution obligations | license text + review |

## Current recommendation

1. **Primary:** REALITY/VLESS on TCP/443, because it is already deployed and
   has the strongest prior evidence; keep measuring it.
2. **Secondary:** VLESS/VMess WS+TLS on a NetPulse-controlled domain, for
   paths where REALITY's target/IP is blocked.
3. **UDP fallback:** Hysteria2 where UDP survives; do not assume it does.
4. **Last resort:** Soar/Cotten DNS tunnel, only with a real compatible client
   and a per-account profile; do not call it a full VPN.
5. **Not default:** arbitrary SNI, unsafe fingerprints, unauthenticated
   Shadowsocks, or a shared non-revocable credential.

No candidate is "best" without a vantage-specific measurement. The product
should expose the path and the failure stage, not a universal green badge.
