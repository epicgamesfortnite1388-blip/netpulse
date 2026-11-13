# Smart Connect — live end-to-end run

**Date:** 2026-11-04 · **Host:** this Windows workstation · **Vantage:** non-Iranian network
**Server:** `apps/api` (tsx), temp data dir `tmp/smart-e2e`, port 8799, xray at `cores/xray.exe`
**Core detected:** `xray` (only), `preferred: auto`, `effective: xray`

This is the run that closes acceptance criterion #10. It exercises the real route, the real
database, the real engine-selection path and the real proxy probe — not injected fakes.

---

## 1. Discovery → import

```
POST /api/v1/sources/MhdiTaheri/fetch
→ 200 in 3,512 ms
  { "status": "completed", "parsed": 1, "imported": 699, "duplicates": 437, "invalid": 863 }
```

Post-import stats: `total 699`, protocols `vless 413, vmess 108, trojan 91, shadowsocks 87`,
transports `tcp 618, ws 80, grpc 1`, countries `{}` (no geo yet).

Interpretation: 699 stored nodes from one feed, **437 duplicates collapsed** and **863
invalid candidates rejected** in the same pass. Discovery, dedupe and rejection are working
on real input.

---

## 2. First plan (before any core was visible) — and the bug it exposed

With `NETPULSE_CORES_DIR` unset, no core was discoverable from this process:

```
considered 300, candidates 0, excludedByReason { "no-engine-installed": 300 }
decision: "No candidate survived the filters. Every stored configuration is stale, failing,
           revoked, or unsupported by the installed cores — stay disconnected…"
```

Two defects found and fixed as a result:

1. **Wrong explanation.** The real cause was a missing core, but the message blamed the
   configurations. `explainEmpty()` now reports the dominant exclusion reason and names the
   remedy ("no local proxy core is installed … install Xray, sing-box or V2Ray").
2. **Fresh catalog excluded.** Newly imported rows carry `freshness: 'stale'` (no test yet).
   Excluding on that flag would empty Smart Connect immediately after every refresh. Staleness
   is now derived from **evidence age** (`EVIDENCE_STALE_AFTER = 24 h`), never from the raw flag.

---

## 3. Plan with a core available

```
GET /api/v1/vpn/smart-connect?limit=300  → 200 in 43 ms
considered 300, candidates 300, excluded {}
chosen: node 156ccd7b…  vless over xray  score 93  confidence "tested"  trust CONNECTION_TESTED
```

That #1 slot was a **TCP-only** success. Another node had just carried HTTP traffic at 580 ms
and ranked below it. Fixed: port-only evidence is capped at **70**, so a port can never
outrank a working tunnel.

---

## 4. Verification run (the wiring proof)

```
POST /api/v1/vpn/smart-connect { "maxProbes": 3, "limit": 300 }
→ 200 in 931 ms, probesRun 2, verified true

probe 1: vless  → failed, xray rejected the config: core exited during startup (code 23)
probe 2: shadowsocks → done, HTTP 200, 580 ms, engine xray

decision: "Traffic verified through node node:156ccd7b… (shadowsocks via xray, 580 ms,
           HTTP 200). Probe count: 2. Authorise the connection to use this endpoint."
next:     create profile (POST /api/v1/vpn/profiles/from-node) → connect (POST /api/v1/vpn/connect)
```

Persistence after the call (`tmp/smart-e2e/netpulse.db`):

| Row | Value |
| --- | --- |
| `node_tests` total | 26 (auto-test scheduler plus these) |
| proxy test, verified | `status done`, `engine xray`, `latency_ms 580`, `http_status 200` |
| proxy test, failed | `status failed`, `engine xray`, error `xray rejected the config: core exited during startup` |
| node `156ccd7b…` | `test_count 1`, `success_count 1`, `failure_count 0`, `last_proxy_ms 580`, `status healthy` |

Adaptive learning after the call (`GET /api/v1/adaptive/status`):

```
enabled true, observationsKept 2
entry: context dns:0|tls:0|relay:0|v6:0|p:balanced, strategy xray+doh, successes 1, failures 1
```

So the AI observed both the success and the failure — the same decisions that produced them.

---

## 5. Second plan, after the fix and the learned evidence

```
GET  → chosen: node 156ccd7b…  confidence "verified"  trust TRAFFIC_VERIFIED  score 89
       next two:  confidence "tested"  trust CONNECTION_TESTED  score 70 (capped)
POST → 200 in 1,043 ms, probesRun 1, verified true
       "Traffic verified through node … (shadowsocks via xray, 628 ms, HTTP 200)"
```

The verified node now leads, port-only evidence is capped, and re-verification costs **one**
probe instead of two.

---

## 6. What this run proves, and what it does not

**Proves:** the route is wired; core detection works; ranking uses real evidence; the probe
carries real traffic; verification is HTTP-observable; node rows and adaptive state are
updated; a failing candidate falls through to the next; the failure taxonomy is surfaced.

**Does not prove:** that any of these endpoints will work in an hour (see survival, 6/7 over
25 minutes), that throughput is adequate (unmeasured), or that the behaviour holds on an
Iranian ISP (untested). The database here is a temporary working copy, not the user's.

No endpoint address, credential or raw link appears in this artifact.
