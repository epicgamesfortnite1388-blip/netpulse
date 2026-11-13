# Free Configuration Source Registry

**Mission:** `NETPULSE_AETHER_AUTONOMOUS_V2` · **Date:** 2026-11-04
**Scope:** sources that **intentionally publish** configurations for unrestricted public use. No private groups, no credential leaks, no access-control bypass, no subscription theft.

The runtime registry is `apps/api/src/services/nodeSourceRegistry.ts` (`getKnownSources()` / `seedKnownSources()`). Sources are persisted in `public_sources`, fetched with conditional requests and content hashing, and every fetched document is stored as evidence before parsing.

---

## 1. Registered and enabled sources

11 built-ins are defined; **9 are enabled**. The two disabled ones are deliberately retired, not forgotten.

| ID | Repository / feed | Category | Feed URL | Enabled |
| --- | --- | --- | --- | --- |
| `mheidari98` | mheidari98/.proxy | GitHub raw | `raw.githubusercontent.com/mheidari98/.proxy/main/all` | yes |
| `barry-far` | barry-far/V2ray-Config | GitHub raw | `.../barry-far/V2ray-Config/main/All_Configs_Sub.txt` | yes |
| `mahdibland` | mahdibland/ShadowsocksAggregator | GitHub raw | `.../ShadowsocksAggregator/master/sub/sub_merge.txt` | yes |
| `ALIILAPRO` | ALIILAPRO/v2rayNG-Config | GitHub raw | `.../v2rayNG-Config/main/server.txt` | yes |
| `MhdiTaheri` | MhdiTaheri/V2rayCollector | GitHub raw | `.../V2rayCollector/main/sub/mix` | yes |
| `peasoft` | peasoft/NoMoreWalls | GitHub raw | `.../NoMoreWalls/master/list.txt` | yes |
| `ts-sf` | ts-sf/fly | GitHub raw | `.../ts-sf/fly/main/v2` | yes |
| `0xRadikal` | 0xRadikal/Free-v2ray-Configs | GitHub raw | `.../Free-v2ray-Configs/main/top100.txt` | yes |
| `ermaozi` | ermaozi/get_subscribe | GitHub raw | `.../get_subscribe/main/subscribe/v2ray.txt` | yes |
| `Epodonios` | Epodonios/v2ray-configs | GitHub raw | — | **no — retired** |
| `ebrasha` | ebrasha/free-v2ray-public-list | GitHub raw | — | **no — retired** |

Retirement evidence (`reports/accounting/FREE_CONFIG_INVENTORY_2026-11-02.md`): both repositories return **404** from the GitHub API because they were **deleted**, not moved. `ebrasha` had been the widest VLESS feed on record (34,657 parsed on 2026-09-16), so this was a material loss of catalog reach. `seedKnownSources` disables an existing row once its source is retired.

---

## 2. Measured inventory per source (2026-11-02)

`scripts/free-config-probe.ts` → `reports/accounting/free-config-probe-2026-11-02.json`.
**9 of 9 enabled sources answered; 34,150 parseable configurations; 0 network failures**; response 82–1,048 ms.

| Source | Parsed | Lines found | Size | Distinct `host:port` |
| --- | ---: | ---: | ---: | ---: |
| mheidari98 | 14,920 | 14,990 | 5,049 KiB | 7,833 |
| barry-far | 8,699 | 8,767 | 2,083 KiB | 3,354 |
| mahdibland | 4,579 | 4,641 | 1,172 KiB | 4,213 |
| ALIILAPRO | 4,058 | 4,103 | 1,417 KiB | 2,474 |
| MhdiTaheri | 1,115 | 1,932 | 515 KiB | 687 |
| peasoft | 417 | 483 | 105 KiB | 397 |
| ts-sf | 200 | 201 | 85 KiB | 200 |
| 0xRadikal | 100 | 100 | 21 KiB | 59 |
| ermaozi | 62 | 66 | 15 KiB | 45 |

Protocol spread of the whole catalog: **VLESS 15,915 · VMess 9,285 · Trojan 4,268 · Shadowsocks 3,901 · Hysteria2 492 · hy2 279 · TUIC 10**.

"Parsed" means the app's own `partitionConfigs()` accepted the candidate. "Distinct `host:port`" is the only figure that approximates *servers* rather than *links* — the same server is republished many times across feeds, which is why deduplication matters more than the headline count suggests.

---

## 3. Measured connect yield per source (2026-11-03)

`reports/accounting/free-config-connect-all-sources-2026-11-03.json` — 30 deterministic samples per source, xray 26.10.31, 12 s budget, probe URL `https://www.cloudflare.com/cdn-cgi/trace`.

| Source | Sampled | Carried traffic | Yield |
| --- | ---: | ---: | ---: |
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

This is the number that should set expectations for any user: **the catalog is large and mostly dead.** A `reliability history` field that treats "published" as "working" would be wrong by an order of magnitude.

Trust classification in this column is therefore **not source prestige**; it is measured yield plus licensing/usage clarity.

---

## 4. Trust and usage classification

| Class | Meaning in this registry |
| --- | --- |
| `community` | Public repository, no operator identity, no guarantee, no SLA. **All 9 enabled feeds are this class.** |
| `known` | Not used — no feed here has an identifiable operator publishing an explicit public-use licence. |
| `verified` | Not used — a successful TCP/TLS handshake is not a trust signal (see `CONFIG_SECURITY_REVIEW.md`). |
| `unverified` | Candidate feeds awaiting measurement. |

Operational rules applied to every source:

- Conditional HTTP (`If-None-Match`/`If-Modified-Since`), content hashing, and a stored raw document per fetch.
- Per-source rate limiting and bounded timeouts; failures increment `failureCount` and lower the reliability score.
- Only HTTP(S) GETs against public hosts. `assertPublicHttpUrl()` rejects loopback, private, link-local and metadata addresses (SSRF guard) before any fetch.
- Fetched bytes are **data**: never executed, never treated as a script, never used to spawn a process.

---

## 5. Candidates that were evaluated and rejected

| Candidate | Finding | Verdict |
| --- | --- | --- |
| `mahdibland/V2RayAggregator` (mission-suggested) | Feed is **byte-identical** to `mahdibland/ShadowsocksAggregator`: 1,200,085 bytes, `sha256 38f1c39e3e4a93d1…`, `identical: true` | **Rejected — duplicate.** Registering both would double-count every node and inflate `sourceCount`. |
| `freeVpnMan/abc-configs-free-vpn-proxy` (mission-suggested) | Repository exists (`GET /repos/...` → 200) but no verified machine-readable feed of one-config-per-line was confirmed | **Not adopted** — a README is not a feed. Would need a measured parse-and-yield run first. |
| `hiddenio.com/en` (mission-suggested) | Website, not a machine-readable feed; terms and reuse permissions unverified | **Not adopted** — scraping a site without an explicit public-use grant is exactly what this mission forbids. |
| Telegram channels that publish free links | Public but not an HTTP feed; Telegram ToS and per-channel intentions are ambiguous | **Excluded by policy** — no Telegram ingestion is implemented. |
| Private groups / leaked subscription links | Would require bypassing access controls | **Excluded by policy.** |

---

## 6. What is deliberately absent

- No "unlimited source discovery" crawler. Source addition is a reviewed input (`POST /api/v1/sources` validates the URL through the public-URL guard) or a code change with a measurement run.
- No claim that any feed is safe. Feeds are mirrors of other people's nodes; the operator of an individual endpoint is usually unidentifiable.
- No source that requires authentication, a paid subscription, or a leaked credential.

---

## 7. Evidence index

- `reports/accounting/FREE_CONFIG_INVENTORY_2026-11-02.md` — inventory, dead sources, duplicate proof.
- `reports/accounting/free-config-probe-2026-11-02.json` — raw inventory.
- `reports/accounting/FREE_CONFIG_CONNECT_RATES_2026-11-03.md` — per-source yields and failure taxonomy.
- `reports/accounting/free-config-connect-all-sources-2026-11-03.json` — 270 raw probe results.
- `reports/accounting/FREE_CONFIG_SURVIVAL_2026-11-03.md` — 25-minute survival.
