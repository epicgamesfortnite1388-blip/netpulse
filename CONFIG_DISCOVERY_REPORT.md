# Configuration Discovery Report

**Mission:** `NETPULSE_AETHER_AUTONOMOUS_V2` · **Date:** 2026-11-04
**Headline:** discovery is real and measured — **34,150 parseable configurations** from **9/9 live feeds**, deduplicated by canonical fingerprint, with **5.9%** of sampled configurations carrying actual traffic. Discovery is not the bottleneck; endpoint survival is.

---

## 1. Pipeline as implemented

```
source registry ──▶ conditional HTTP GET ──▶ raw document stored (evidence)
      │                                              │
      │                                              ▼
      │                                  extractRawConfigs()  (base64 / lines / JSON)
      │                                              │
      │                                              ▼
      │                                  partitionConfigs()   (parse + protocol)
      │                                              │
      │                                              ▼
      │                                  canonical fingerprint dedupe
      │                                              │
      │                                              ▼
      │                                  public_nodes + node_sources (provenance)
      │                                              │
      │                                              ▼
      │                                  engine compatibility (engineSupports)
      │                                              │
      │                                              ▼
      │                                  bounded probe (traffic must traverse)
      │                                              │
      │                                              ▼
      └──────────────────────────────▶ ranking (node score) ──▶ Smart Connect
```

Code ownership:

| Stage | Module |
| --- | --- |
| fetch, hash, conditional request, SSRF guard, scheduler | `apps/api/src/services/nodeSourceRegistry.ts` |
| URI parsing (VLESS/VMess/Trojan/SS/Hysteria2/TUIC) | `apps/api/src/services/nodeParsers.ts` |
| dedupe/provenance persistence | `apps/api/src/services/nodesService.ts` (`importParsedConfigs`) |
| compatibility | `apps/api/src/services/proxyCores.ts` (`engineSupports`, `engineSupportsConfig`) |
| probes | `apps/api/src/services/nodeTestProbes.ts` + `proxyEngineRunner.ts` |
| ranking | `apps/api/src/services/nodeScoring.ts` |
| selection / verification | `apps/api/src/services/smartConnect.ts` (new) |
| HTTP surface | `apps/api/src/routes/nodes.ts` (`/api/v1/sources`, `/api/v1/nodes`, `/api/v1/scanner/*`) |

---

## 2. Retrieval results

`reports/accounting/free-config-probe-2026-11-02.json`:

- `sourcesProbed: 9`, `sourcesOk: 9`, `sourcesFailed: 0`.
- `totalParsed: 34,150`.
- Scheme spread: `vless 15,915 · vmess 9,285 · trojan 4,268 · ss 3,901 · hysteria2 492 · hy2 279 · tuic 10`.
- Vantage: win32 x64, Node v24.18.0, bounded timeouts, redirects followed.

### Parse quality is not uniform

`reports/accounting/FREE_CONFIG_CONNECT_RATES_2026-11-03.md` records acceptance against lines fetched:

| Source | Lines | Parsed valid | Engine-testable | Effective parse rate |
| --- | ---: | ---: | ---: | ---: |
| mheidari98 | 14,944 | 14,879 | 14,849 | 99.5% |
| ALIILAPRO | 4,168 | 4,123 | 4,123 | 98.9% |
| peasoft | 502 | 470 | 470 | 86.3% |

A feed with a 3.4% malformed rate is normal for aggregators; the parser rejects rather than guesses, and the malformed remainder is counted (`invalid`), not silently dropped.

---

## 3. Deduplication

- Each parsed configuration is reduced to a **canonical fingerprint** (`canonical_fingerprint`, `UNIQUE` in `public_nodes`). A configuration republished by five feeds becomes **one node** with `sourceCount = 5` and five `node_sources` provenance rows.
- Evidence that dedupe is doing real work: **34,150 parsed links** collapse to far fewer distinct endpoints per feed — e.g. `mheidari98` 14,920 parsed / 7,833 distinct `host:port`; `ALIILAPRO` 4,058 / 2,474; `mahdibland` 4,579 / 4,213.
- Duplicate **feeds** are also detected by content hash: `mahdibland/V2RayAggregator` is byte-identical to `ShadowsocksAggregator` (`sha256 38f1c39e…`, 1,200,085 bytes) and was rejected rather than registered.
- Result: `sourceCount` is a genuine signal ("how many independent feeds publish this endpoint") and is used as a ranking component rather than as an accidental multiplier.

---

## 4. Rejection taxonomy (static and engine-level)

Aggregated from the 270-candidate run and the 60-candidate run:

| Category | Count (10 s / 25 s sample) | Meaning |
| --- | ---: | --- |
| `handshake_failed` — timeout | 25 / 22 | Server never completed a handshake |
| `handshake_failed` — ECONNRESET | 12 / ~12 | Server actively reset |
| `target_failed` — TLS dropped / wrong version | 8+2 / ~13 | Relayed, but destination TLS failed |
| `engine_unavailable` — `allowInsecure` removed | 6 / 6 | Xray 26.x **refuses these by design** |
| `engine_unavailable` — hysteria2 | 3 / 3 | No installed core speaks hy2 (sing-box missing) |
| `engine_start_failed` — xray code 23 | 3 / 3 | Core rejected the config at startup |

Two facts worth keeping:

1. **Extending the timeout does not rescue nodes.** 10 s → 25 s changed three timeouts and added **zero** successes. Longer patience is not a fix.
2. **Incompatible configurations are rejected, not retried.** `allowInsecure` and unsupported protocols are classified `engine_unavailable`, and `SmartConnect` excludes a protocol no installed core supports instead of burning a probe on it.

---

## 5. Change detection and freshness

- Every fetch stores the raw document plus its hash; an unchanged hash does not re-parse into new rows.
- `lastSeen` is bumped on every sighting; `freshness` is derived (`fresh` / `stale` / `expired`).
- `retireStaleNodes()` demotes nodes that stop appearing; `SmartConnect` excludes `stale`/`expired` rows and rows unseen for more than 7 days (`abandoned`).
- Staleness is a **first-class exclusion reason with a count**, so a dashboard can say "412 were stale" instead of showing an empty list.

---

## 6. What was removed in this evaluation

A second, parallel discovery stack (`apps/api/src/services/config-discovery/` and `apps/api/src/routes/configDiscovery/`, added 2026-11-03) was **deleted**.

Why it could not stay:

- It called `fetch(source.url)` with **no** `assertPublicHttpUrl()` guard on a user-supplied URL — an SSRF path into loopback/private/metadata addresses, which the hardened registry explicitly rejects.
- It kept configurations **in memory only**, so discovery vanished on restart.
- It had **no deduplication**, no provenance, no conditional requests, no rate limiting, no engine compatibility check and no probing — while the UI-facing `/api/v1/sources` and `/api/v1/nodes` already provided all of that against the database.
- It advertised `POST /api/config-discovery/discover/all` as if it produced validated configurations. It did not: it produced parsed strings.

Removing it changed the API surface (the `/api/config-discovery/*` prefix no longer exists) and left the hardening in one place. Typecheck and the full suite pass afterwards.

---

## 7. Honest limits

- **A catalog is not a connection.** 34,150 parseable links produced **16 working endpoints** in a 270-sample (5.9%). The number to show a user is the tested one, never the discovered one.
- **One vantage.** All measurements come from a single Windows host behind an existing VPN, not from an Iranian ISP. Iran behaviour is **NOT TESTED**.
- **One core for public configs.** Xray 26.10.31 only; sing-box install is blocked on an upstream release-lookup problem, so Hysteria2/TUIC coverage is structurally absent (`engine_unavailable`), not merely unlucky.
- **Telegram is not ingested.** No Telegram source is implemented, by policy.
