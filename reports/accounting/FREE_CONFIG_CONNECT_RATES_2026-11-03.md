# Free-Config Connect Rates — 2026-11-03

**Workstream:** W2 / F-05 (free-source connect rates)
**Verdict:** **MEASURED** — 16 of 270 sampled configs carried traffic (5.9%) across all nine sources, and yield is strongly source-dependent: three feeds supply most of the live endpoints while four supply none. A smaller 60-config sample over three feeds gave 1.7%, which understates the catalog because two of those feeds are dead.

> **Revision note:** this report first carried only the 60-config result (1.7%). The wider 270-config run below supersedes it as the headline, and the narrow run is kept because it shows the same ALIILAPRO/mheidari98/peasoft yields independently.
**Scope limit:** one snapshot, one non-Iranian network (host behind an existing VPN), one core (xray). Statistical, not a survival measurement.

---

## Method

- Sampled the built-in catalog through the repo's own code paths, not ad-hoc parsing:
  `getKnownSources()` → `fetchSourceUrls()` → `extractRawConfigs()` → `partitionConfigs()` → `configIsTestable()`.
- Deterministic stride sample of 20 per source across three healthy feeds (`mheidari98`, `ALIILAPRO`, `peasoft`) → **n = 60**.
- Each config dialled with `proxyProbeWithEngine()` (preferred `auto`) against `https://www.cloudflare.com/cdn-cgi/trace`.
- Core: xray **26.10.31** installed via the app's `installEngine('xray')` (checksum verified). sing-box could not be installed: latest is unpinned, and the pinned 1.12.x tags no longer resolve in the upstream release lookup.
- Two passes over the identical sample: 10 s and 25 s per-probe timeouts.

### Fetch sanity

| Source | Lines discovered | Parsed valid | Engine-testable | Sampled |
|---|---|---|---|---|
| mheidari98 | 14,944 | 14,879 | 14,849 | 20 |
| ALIILAPRO | 4,168 | 4,123 | 4,123 | 20 |
| peasoft | 502 | 470 | 470 | 20 |

These line up with the 2026-11-02 inventory (parse rates 99.5% / 98.9% / 86.3%).

---

## Result

| Timeout | Sampled | Reachable | Rate | Latency |
|---|---|---|---|---|
| 10 s | 60 | 1 | **1.7%** | 1,230 ms |
| 25 s | 60 | 1 | **1.7%** | 1,599 ms |

The single working endpoint was the same node in both passes: `vmess`, `ALIILAPRO`, ~1.2–1.6 s.

Failure taxonomy (10 s pass / 25 s pass):

| Reason | 10 s | 25 s | Meaning |
|---|---|---|---|
| `handshake_failed` (timeout) | 25 | 22 | server never completed a handshake |
| `handshake_failed` (ECONNRESET) | 12 | ~12 | server actively reset |
| `target_failed` (TLS dropped / wrong version) | 8+2 | ~13 | relayed but the destination TLS failed |
| `engine_unavailable` — `allowInsecure` removed | 6 | 6 | xray 26.x refuses these configs by design |
| `engine_unavailable` — hysteria2 | 3 | 3 | no installed core supports hy2 (sing-box missing) |
| `engine_start_failed` — xray code 23 | 3 | 3 | core rejected the config at startup |

Protocol spread of the sample: vless 23, vmess 22, trojan 8, shadowsocks 4, hysteria2 3 — and the only success came from vmess. With n = 60 that is **not** evidence that vmess outperforms vless; it is one endpoint.

Extending the timeout from 10 s to 25 s changed timeouts by only 3 probes and did not add a single success. Longer patience does not rescue these endpoints; they are simply down.

---

## Wider sample — all nine enabled sources (n = 270)

30 configs per enabled source, 12 s per probe, concurrency 6, same probe URL and core.

| Source | Sampled | Reachable | Yield |
|---|---|---|---|
| barry-far | 30 | 7 | **23.3%** |
| MhdiTaheri | 30 | 4 | **13.3%** |
| 0xRadikal | 30 | 3 | **10.0%** |
| ALIILAPRO | 30 | 1 | 3.3% |
| ermaozi | 30 | 1 | 3.3% |
| mahdibland | 30 | 0 | 0% |
| mheidari98 | 30 | 0 | 0% |
| peasoft | 30 | 0 | 0% |
| ts-sf | 30 | 0 | 0% |
| **Total** | **270** | **16** | **5.9%** |

Protocol spread of the successes: shadowsocks 6, vmess 5, vless 4, trojan 1, hysteria2 0 (no supporting core). Latency min 350 ms, median 1,179 ms, max 10,579 ms.

The narrow sample is consistent with this one where they overlap: ALIILAPRO 1/20 then 1/30, mheidari98 0/20 then 0/30, peasoft 0/20 then 0/30. The 1.7% vs 5.9% gap is therefore **source mix, not sampling luck** — the wide run added barry-far, 0xRadikal and MhdiTaheri, which is where the live endpoints are.

### What this changes

- **Harvesting is not the constraint; selection is.** mheidari98 contributes 14,920 of the 34,150 catalog entries and 0 of 30 dialled configs. barry-far is a quarter of mheidari98's size and 23% live. Weighting the fetch order toward barry-far, MhdiTaheri and 0xRadikal is worth more than any volume increase.
- Scaling 5.9% naively across 34,150 would suggest ~2,000 usable entries; the per-source spread makes that number meaningless. What the data supports is: *the live endpoints are concentrated in three feeds*, and each feed needs its own rate.

## What this means

- The 34,150-config inventory is a large address space but a thin one in practice: at 1.7%, expecting ~580 usable entries from the whole set is optimistic, and anything near that number would need the full sweep to confirm — 60 configs cannot support it.
- Roughly 15% of the sample was never dialled for reasons that are *our* limitations, not the servers': 6 configs xray now refuses because upstream removed `allowInsecure`, and 3 hysteria2 configs that need sing-box. Fixing the sing-box install path (pin a current digest, or make the pin optional with a provenance check) would recover that share.
- Rounds of harvesting will not by themselves make the free path viable. Rotating, re-testing and promoting the few survivors is the leverage, which is what F-05 was meant to establish.
- A ~6% dialable rate with a median ~1.2 s handshake is workable for an emergency fallback, but only with per-source weighting and continuous re-testing — four of nine sources currently contribute nothing and would waste most of a sweep.

## Not measured

- Survival over time (open question 5: "which configs survive more than an hour?") — **NOT TESTED**; this is a single snapshot.
- Iranian-network behaviour — **NOT TESTED**; no vantage (W5).
- Throughput/bandwidth — **NOT TESTED**; only handshake-plus-request latency.
- Full-inventory rate — 330 of 34,150 dialled across both samples; the per-source table is an estimate, not a census.

## Reproduce

```bash
npm run probe:connect                                                # 10 s pass
PROBE_TIMEOUT_MS=25000 PROBE_OUT=reports/accounting/free-config-connect-25s-2026-11-03.json \
  npm run probe:connect                                              # 25 s pass
```

`scripts/free-config-connect.ts` accepts `PROBE_TIMEOUT_MS`, `PROBE_OUT`, `PROBE_SOURCES`
and `PROBE_SAMPLE`, and drives the same catalog/parse/probe code the API uses
(requires an installed core — `installEngine('xray')`).

```bash
npm run probe:sources                                               # inventory
PROBE_SOURCES=barry-far,0xRadikal,mahdibland,mheidari98,ALIILAPRO,ermaozi,MhdiTaheri,peasoft,ts-sf \
  PROBE_SAMPLE=30 PROBE_CONC=6 PROBE_TIMEOUT_MS=12000 \
  PROBE_OUT=reports/accounting/free-config-connect-all-sources-2026-11-03.json \
  npm run probe:connect                                             # n=270 pass
```

Raw per-probe data: `reports/accounting/free-config-connect-2026-11-03.json`, `free-config-connect-25s-2026-11-03.json`, `free-config-connect-all-sources-2026-11-03.json`.
