# Connection Benchmarks

**Mission:** `NETPULSE_AETHER_AUTONOMOUS_V2` · **Date:** 2026-11-04
**Rule for this document:** every number is copied from a recorded artifact or a test run named beside it. Metrics that were never measured are marked **NOT MEASURED** — not estimated, not borrowed from a vendor.

**Vantage for all network measurements:** one Windows host on a non-Iranian network (behind an existing VPN), 2026-11-02/03. Iran-ISP numbers do not exist.

---

## 1. Aether tunnel — stage latencies

`reports/accounting/TUNNEL_STAGES_2026-11-03.json` · 20 repeats · target `api.ipify.org` · 20/20 completed, 0 failures.

| Stage | min | median | p90 | max |
| --- | ---: | ---: | ---: | ---: |
| DNS (local resolver — see caveat) | 0 ms | 1 ms | 1 ms | 89 ms |
| SOCKS5 connect | 76 ms | 80 ms | 87 ms | 95 ms |
| TLS handshake | 82 ms | 92 ms | 100 ms | 100 ms |
| HTTP first byte | 186 ms | 197 ms | 278 ms | 361 ms |
| **End to end** | **352 ms** | **372 ms** | **467 ms** | **535 ms** |

Caveat carried from the artifact: `dnsRunsThrough: "local resolver (tunnel refuses ATYP 0x03)"`. Aether's SOCKS listener rejects domain-form addressing, so this stage run resolved locally. Name resolution **through** the tunnel is measured separately (§2) and is real.

---

## 2. DNS through the tunnel

`reports/accounting/DNS_TUNNEL_PROOF_2026-11-03.json` · resolver `1.1.1.1:53` over DNS-over-TCP inside SOCKS5 · 5 rounds × 3 names.

| Metric | Value |
| --- | --- |
| Queries resolved locally | 15 / 15 |
| Queries resolved through tunnel | 15 / 15 |
| Same answer locally vs tunnel | 15 |
| Different answer | **0** |
| Local median | 0 ms (cached/instant) |
| Tunnel median | **80 ms** |
| End-to-end exit IP | `104.28.197.9` |

---

## 3. Reconnect and outage

`reports/accounting/RECONNECT_TEST_2026-11-03.json`

| Metric | Value |
| --- | --- |
| Down detected | yes, **93 ms** |
| Back up | yes, **3,032 ms** |
| Total outage | **3,125 ms** |
| Exit IP before/after | `104.28.197.9` / `104.28.197.9` (stable) |
| Verdict | **PASS** |

---

## 4. Aether exit and leak observations

`reports/accounting/LEAK_TEST_2026-11-03.json`

| Observation | Value |
| --- | --- |
| IPv4 exit through the tunnel | `104.28.197.9` (WARP, DE via FRA per `aether/run6.log`) |
| Host direct IPv6 egress | none reachable |
| IPv6 through the tunnel | TLS handshake succeeded to `2606:4700:4700::1111`, cert `CN=cloudflare-dns.com` |
| UDP/QUIC leak | **NOT MEASURED** (SOCKS listener is TCP-only in this harness) |
| Second interface / OS resolver | **NOT MEASURED** |

---

## 5. Public free configuration performance

`reports/accounting/free-config-connect-all-sources-2026-11-03.json` · 270 deterministic samples · xray 26.10.31 · 12 s budget · probe `https://www.cloudflare.com/cdn-cgi/trace`.

| Metric | Value |
| --- | --- |
| Sampled | 270 |
| Carried traffic | **16** |
| Success rate | **5.9%** |
| Latency min | **350 ms** |
| Latency median | 1,179 ms |
| Latency max | 10,579 ms |

By protocol:

| Protocol | Sampled | Worked | Yield |
| --- | ---: | ---: | ---: |
| Shadowsocks | 32 | 6 | 18.8% |
| VMess | 83 | 5 | 6.0% |
| Trojan | 29 | 1 | 3.4% |
| VLESS | 118 | 4 | 3.4% |
| Hysteria2 | 8 | 0 | 0% (no supporting core installed) |

Note: VLESS is 44% of the sample and yields least; Shadowsocks is small and yields most. With n = 270 this is a **source-composition signal**, not proof that one protocol is better.

### Best measured configuration

The fastest verified endpoint in the recorded set: **Shadowsocks, source `barry-far`, 350 ms** end-to-end through the local xray core. The artifact deliberately records `host: "?"` — endpoints are not carried into reports, so no address is named here.

**Throughput for that endpoint: NOT MEASURED.** The connect-rate harness measured whether a request completed, not how fast bytes flow.

---

## 6. Endpoint survival

`reports/accounting/FREE_CONFIG_SURVIVAL_2026-11-03.md` · round 1 then a 25-minute gap, re-dialling exactly the survivors.

| Metric | Value |
| --- | --- |
| Round 1 sampled | 75 |
| Round 1 reachable | **7 (9.3%)** |
| Round 2 (25 min later) | **6 of 7 survived = 85.7%** |
| Fast survivors | two Shadowsocks endpoints held ~360 ms |
| Slowest survivor | 11.4 s in round 1 → **failed** in round 2 |
| One-hour survival | **NOT MEASURED** |

Useful conclusion recorded by the artifact: **round-1 latency predicted survival better than protocol did** — endpoints near the timeout were the ones that flipped.

---

## 7. Engine overhead — core spawning

`reports/engines/01_BULK_PROBE_FINDINGS.md` · 12 nodes, xray 26.10.21/26.3.27.

| Path | Time for 12 nodes | Core spawns |
| --- | ---: | ---: |
| One core per node (`proxyProbeWithEngine`) | 13,412 ms | 12 |
| Batched (`proxyProbeManyWithEngine`) | 12,107 ms | 2 |

Batching cuts spawns 6× for ~10% wall-clock. The win is smaller than expected because the probe time is dominated by the network, not by process startup — worth saying plainly, since the feature is often sold as a large speedup.

---

## 8. Adaptive AI cost

`reports/adaptive/ADAPTIVE_COST.json` · 20,000 iterations at maximum state (32 contexts × 8 strategies, 200 observations).

| Operation | p50 | p95 |
| --- | ---: | ---: |
| Rank strategies | **4 µs** | 6.8 µs |
| Apply observation | 54.9 µs | 70.7 µs |
| Parse state | 320 µs | 443.7 µs |

State: 79,481 B serialized, 123,000 B heap. Negligible at desktop scale.

---

## 9. Smart Connect (2026-11-04, live)

`reports/accounting/SMART_CONNECT_LIVE_2026-11-04.md` · 699 imported nodes · xray 26.10.31.

| Metric | Value |
| --- | --- |
| Feed import (699 stored, 437 dup, 863 invalid) | 3.5 s |
| Plan / ranking, 300 candidates | **43 ms** |
| Verify, 2 probes (1 rejected, 1 verified) | **931 ms** |
| Verified probe latency (Shadowsocks) | **580 ms**, HTTP 200 |
| Re-verify after fixes, 1 probe | **1,043 ms**, 628 ms probe latency |
| Port-only evidence cap | 70/100 |
| Untested cap | 55/100 |

---

## 10. What is still unmeasured

| Metric | Status |
| --- | --- |
| Download / upload throughput on any tunnel | **NOT MEASURED** |
| Packet loss and jitter under sustained load | **NOT MEASURED** |
| Long-run stability (hours) | **NOT MEASURED** |
| Behaviour on an Iranian ISP | **NOT MEASURED** — the central gap |
| Multiple exits concurrently | **NOT MEASURED** |
| Time-to-first-byte for a public node under Smart Connect verification | **PARTIAL** — plan and verify wall-clock measured (§9); first-byte inside the probe is not separately instrumented |

No throughput claim appears anywhere in this project's UI or docs, because none was measured. That is deliberate.
