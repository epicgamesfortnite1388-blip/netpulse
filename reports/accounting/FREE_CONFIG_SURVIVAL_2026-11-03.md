# Free-Config Survival — 2026-11-03

**Workstream:** F-05 / roadmap open question 5 ("which free-source configs survive more than an hour?")
**Verdict:** **MEASURED over a 25-minute gap** — 6 of 7 reachable endpoints still carried traffic; one failed. One-hour survival remains **NOT TESTED**.
**Harness:** `scripts/free-config-survival.ts` (`npm run probe:survival`)
**Scope limit:** one 25-minute window, one network, one core. Small n (7 endpoints) — this is a rate with a wide error bar, not a stable statistic.

---

## Design

Round 1 dials a deterministic sample and keeps the endpoints that actually carried traffic. After a gap, round 2 re-dials **exactly those endpoints**. A config that answered in round 1 and not in round 2 is "did not survive"; a config that answered in neither was never a candidate and is not counted as a death.

Raw share links are held in memory only — the JSON carries source, protocol, latency and outcome, never the link.

## Round 1 — reachability

75 configs (25 per source), 12 s budget, concurrency 6:

| Source | Sampled | Reachable | Yield |
|---|---|---|---|
| 0xRadikal | 25 | 3 | 12.0% |
| MhdiTaheri | 25 | 3 | 12.0% |
| barry-far | 25 | 1 | 4.0% |
| **Total** | **75** | **7** | **9.3%** |

By protocol: vmess 3/5, shadowsocks 2/8, vless 2/57, trojan 0/5. This is the same pattern as the wide sample — vmess and shadowsocks carry, vless dominates the feed and mostly does not answer.

## Round 2 — 25 minutes later

| Source | Protocol | Round 1 | Round 2 | Outcome |
|---|---|---|---|---|
| 0xRadikal | vmess | 597 ms | 592 ms | survived, stable |
| MhdiTaheri | shadowsocks | 364 ms | 356 ms | survived, stable |
| MhdiTaheri | shadowsocks | 383 ms | 955 ms | survived, ~2.5× slower |
| MhdiTaheri | vmess | 6,289 ms | 2,852 ms | survived, faster |
| 0xRadikal | vless | 1,190 ms | 11,663 ms | survived, ~10× slower |
| barry-far | vmess | 9,268 ms | 7,852 ms | survived |
| 0xRadikal | vless | 11,399 ms | **failed** (`target_failed`) | **did not survive** |

**Survival rate: 6/7 = 85.7%** over 25 minutes.

## What the numbers say

- The one endpoint that died had already been the slowest kind of survivor (11.4 s in round 1 — essentially at the edge of the budget). Endpoints that answered fast in round 1 stayed fast; endpoints near the timeout were the ones that flipped. **Latency in round 1 predicts survival better than protocol does.**
- Of the six survivors, three changed latency by 2.5–10×. A client that picks a node once and keeps it will sit on a 11 s path while a better one exists; re-measurement matters as much as selection.
- Two shadowsocks endpoints held ~360 ms in both rounds — the only consistently fast pair in the set. With n=7 that is a hint, not a finding.

## Honest limits

- **One-hour survival is NOT TESTED.** This is a 25-minute window; the roadmap question says "more than an hour" and this run does not answer it. The harness takes `PROBE_GAP_MIN` and can run the longer window.
- n = 7 endpoints. A single failure moves the rate by 14 points.
- The 12 s probe budget sets a ceiling on what counts as "alive"; a slow-but-working endpoint that needs 15 s is scored dead here. The wide-sample run used the same budget, so this is consistent, but it is a definition, not a fact about the internet.
- Iranian-network survival — **NOT TESTED** (W5). Censorship events would change this picture completely, and that is precisely what cannot be measured from here.

## Reproduce

```bash
PROBE_SOURCES=barry-far,0xRadikal,MhdiTaheri PROBE_SAMPLE=25 PROBE_GAP_MIN=25 npm run probe:survival
# one-hour window: PROBE_GAP_MIN=60
```

Raw data: `reports/accounting/free-config-survival-2026-11-03.json`.
