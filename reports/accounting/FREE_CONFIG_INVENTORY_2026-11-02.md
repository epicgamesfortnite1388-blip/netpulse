# Free config inventory — live measurement

**Date:** 2026-11-02 · **Vantage:** this workstation (Iranian access network, AS16322 per
`reports/adaptive/ADAPTIVE_EVIDENCE_2026-10-26.md`)
**Tool:** `npx tsx scripts/free-config-probe.ts --out reports/accounting/free-config-probe-2026-11-02.json`
**Raw data:** `reports/accounting/free-config-probe-2026-11-02.json`

The provider host is retired, so the built-in free-source catalog is now one of the two
real ways to obtain a config. This is what it actually returned today.

## Headline

**9 of 9 enabled sources served parseable configs · 34,150 parseable configs · 0 network
failures** (each source answered in 82–1,048 ms).

| Source | Parsed | Found | Size | Distinct endpoints | Time |
| --- | ---: | ---: | ---: | ---: | ---: |
| `mheidari98 / .proxy` | 14,920 | 14,990 | 5,049 KiB | 7,833 | 450 ms |
| `barry-far / V2ray-Config` | 8,699 | 8,767 | 2,083 KiB | 3,354 | 1,048 ms |
| `mahdibland / ShadowsocksAggregator` | 4,579 | 4,641 | 1,172 KiB | 4,213 | 141 ms |
| `ALIILAPRO / v2rayNG-Config` | 4,058 | 4,103 | 1,417 KiB | 2,474 | 126 ms |
| `MhdiTaheri / V2rayCollector` | 1,115 | 1,932 | 515 KiB | 687 | 107 ms |
| `peasoft / NoMoreWalls` | 417 | 483 | 105 KiB | 397 | 83 ms |
| `ts-sf / fly` | 200 | 201 | 85 KiB | 200 | 88 ms |
| `0xRadikal / Free-v2ray-Configs` | 100 | 100 | 21 KiB | 59 | 330 ms |
| `ermaozi / get_subscribe` | 62 | 66 | 15 KiB | 45 | 82 ms |

Protocol spread of the combined catalog: **VLESS 15,915 · VMess 9,285 · Trojan 4,268 ·
Shadowsocks 3,901 · Hysteria2 492 · hy2 279 · TUIC 10**.

Counts are candidates the app's own parser accepted (`partitionConfigs`), not lines
fetched. “Distinct endpoints” dedupes by `host:port` (VMess decoded from base64) and is
the only figure here that approximates how many *servers* exist.

## Two sources were dead, and are now retired

The first run probed all 11 built-ins. Two returned **404**, and not because a path
moved:

| Source | Finding |
| --- | --- |
| `Epodonios / v2ray-configs` | `api.github.com/repos/Epodonios/v2ray-configs` → **404**. Repository deleted. |
| `ebrasha / free-v2ray-public-list` | `api.github.com/repos/ebrasha/free-v2ray-public-list` → **404**. Repository deleted. |

`ebrasha` was the widest VLESS feed on record (34,657 parsed on 2026-09-16) — a large
share of the catalog's reach was gone with it. Both are now `retired: true`: not seeded
enabled, and an existing database row is disabled on next boot
(`seedKnownSources`, guarded by the `enabled === false` branch).

## A replacement was measured and rejected

`mahdibland/V2RayAggregator` looked like a strong replacement (4,728 lines of
VMess/SS/Trojan, 200 OK). It is **the same file** as the existing
`mahdibland/ShadowsocksAggregator` feed:

```
ShadowsocksAggregator  200  1,200,085 bytes  sha256 38f1c39e3e4a93d1…
V2RayAggregator        200  1,200,085 bytes  sha256 38f1c39e3e4a93d1…
identical: true
```

Adding it would have raised the catalog's advertised total by ~4,600 while adding zero
new servers. It was not added. The catalog now shows 9 sources and 34,150 configs, which
is the honest number.

## What this does and does not prove

- **Proven:** these nine feeds were reachable from this network today and yielded
  configs the app's parser accepts.
- **Not proven:** that any of those configs *works*. Reachability of a list is not a
  working tunnel; only a connect + exit-IP check proves that (`npm run proof:vpn`).
- **Not proven:** that the dead repos stay dead, or that today's live ones stay up.
  Community lists churn daily — this report is a timestamp, not a guarantee.
- The probe uses Node's `fetch`; the app uses its own https client with retries. Parsing
  is identical, transport is not.

## Reproduce

```bash
npm run probe:sources                     # all enabled built-ins
npx tsx scripts/free-config-probe.ts --only barry-far,mheidari98 --timeout 15000
```

Read-only: no database writes, no imports, no persistence. Exit code is non-zero only
when *every* source fails, so one dead community list does not break a scheduled run.
